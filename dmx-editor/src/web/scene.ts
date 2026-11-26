// The viewport. three.js only DRAWS: it mirrors the rig document (hierarchy, transforms, profiles)
// into a scene graph and colours pixels from whatever frame it is handed. It owns no state that
// matters — a gizmo drag is reported back as one edit when the drag ends, and the document then
// flows back in through sync() like any other change.
//
// Navigation and selection follow Unity's Scene View (see sceneCamera.ts for the camera):
//
//   click                  select; click empty space to deselect
//   Shift / Cmd + click    toggle in the selection
//   click again, same spot cycle through overlapping objects
//   drag on empty space    rectangle select (Shift adds, Cmd removes)
//   Q W E R                view / move / rotate / scale tool (not while flying)
//   Cmd while dragging     snap by the increment settings
//
// The gizmo drives a PROXY object, not the node itself, so several objects move together: placed
// at the active object's pivot or the selection's centre (Unity's Pivot / Center), oriented to the
// active object or the world (Local / Global). Only the top-most selected nodes move — a selected
// child of a selected rail rides along with its parent, as in Unity.
//
// Object rotation order is "YXZ" everywhere, matching model/transform.ts, so the scene graph's
// world matrices are the evaluator's (test/rig.test.ts pins this).

import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { rigOrder } from "../model/patch";
import { profileById, type RigDocument, type RoomModel, subtree, type VideoSurface } from "../model/rig";
import { surfaceMesh } from "../model/surfaces";
import { tidy, type Transform } from "../model/transform";
import { applyClick, applyRect, pickAt } from "./picking";
import { type NavMode, SceneCamera } from "./sceneCamera";

const DEG = Math.PI / 180;
const TUBE_RADIUS = 0.016;
const CLICK_SLOP = 4;
const PICK_RADIUS = 6;

const COLOURS = {
  body: new THREE.Color(0x3a4150),
  bodySelected: new THREE.Color(0xff9a3c),
  bodyInSelection: new THREE.Color(0xc7783a),
  bodyUnpatched: new THREE.Color(0x6a3a3a),
  pixelOff: new THREE.Color(0x15171c),
  fixtureGuide: new THREE.Color(0xb7c6de),
  inputEnd: new THREE.Color(0xd23c3c),
  surfaceEmpty: new THREE.Color(0x3b6ea5),
  surfaceOutline: new THREE.Color(0x5b6b85),
};

// Unity-ish cursors: an eye for look/orbit, a hand for pan, a magnifier for zoom.
const EYE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="white" stroke="black" stroke-width="1.2"/><circle cx="12" cy="12" r="3.5" fill="black"/></svg>',
)}") 12 12, crosshair`;
const CURSORS: Record<NavMode, string> = { none: "", fly: EYE_CURSOR, orbit: EYE_CURSOR, pan: "grabbing", zoom: "zoom-in" };

export type Tool = "view" | "translate" | "rotate" | "scale";

interface NodeView {
  obj: THREE.Object3D;
  /** "pixels:length" for lights, the surface's JSON for surfaces — a change rebuilds the geometry. */
  shape: string | null;
  surface?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  outline?: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  body?: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  pixels?: THREE.InstancedMesh;
  marker?: THREE.Object3D;
}

export interface SceneCallbacks {
  /** The new selection, active (last-clicked) object last. */
  onSelect(ids: string[]): void;
  /** One gizmo drag's result: new local transforms for every node it moved. */
  onTransforms(changes: { id: string; transform: Transform }[]): void;
}

export interface SceneOptions {
  /** Active object last. */
  selection: string[];
  tool: Tool;
  space: "local" | "world";
  pivot: "pivot" | "center";
  /** Increment snapping, applied while Cmd is held during a drag. */
  snapMove: number;
  snapRotate: number;
  /** Draw video surfaces (and let them be clicked). */
  showSurfaces: boolean;
}

interface DragState {
  proxyStart: THREE.Matrix4;
  proxyPos: THREE.Vector3;
  proxyQuat: THREE.Quaternion;
  items: { id: string; obj: THREE.Object3D; world: THREE.Matrix4; scale: THREE.Vector3 }[];
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.02, 500);
  readonly nav: SceneCamera;
  private gizmo: TransformControls;
  private proxy = new THREE.Object3D();
  private drag: DragState | null = null;
  private rigRoot = new THREE.Group();
  private roomRoot = new THREE.Group();
  private roomModel: THREE.Object3D | null = null;
  private roomFile: string | null = null;
  private roomStatus: (s: string | null) => void = () => {};
  private views = new Map<string, NodeView>();
  private rig: RigDocument | null = null;
  private framedInitialRig = false;
  private opts: SceneOptions = { selection: [], tool: "translate", space: "local", pivot: "pivot", snapMove: 0.25, snapRotate: 15, showSurfaces: true };
  private frame: Float32Array | null = null;
  private exposure = 1;
  private videoOf: (surfaceId: string) => HTMLVideoElement | null = () => null;
  private videoTextures = new Map<HTMLVideoElement, THREE.VideoTexture>();
  private resize: ResizeObserver;
  private raf = 0;
  private dirty = true;
  private tmpColour = new THREE.Color();
  /** A left press that may become a click or a rectangle select. */
  private press: { x: number; y: number; id: number; shift: boolean; meta: boolean; base: string[]; marquee: boolean } | null = null;
  private lastClick: { x: number; y: number; hits: string[] } | null = null;
  private marqueeEl: HTMLDivElement;
  private speedEl: HTMLDivElement;
  private speedTimer: ReturnType<typeof setTimeout> | null = null;
  private metaHeld = false;

  constructor(
    private container: HTMLElement,
    private cb: SceneCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    container.appendChild(this.renderer.domElement);
    const el = this.renderer.domElement;

    this.scene.background = new THREE.Color(0x0d0e11);

    // A dim, even light so the room reads as a backdrop without competing with the pixels.
    this.scene.add(new THREE.HemisphereLight(0xb8c4d8, 0x20232a, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(3, 8, 4);
    this.scene.add(key);

    const fine = new THREE.GridHelper(20, 200, 0x1c1f26, 0x1c1f26);
    const coarse = new THREE.GridHelper(20, 20, 0x3b4252, 0x2a2f3a);
    (fine.material as THREE.Material).depthWrite = false;
    this.scene.add(fine, coarse, axesAtOrigin());
    this.scene.add(this.roomRoot, this.rigRoot, this.proxy);
    this.proxy.rotation.order = "YXZ";

    this.nav = new SceneCamera(this.camera, el);
    this.nav.onChange = () => (this.dirty = true);
    this.nav.onModeChange = (mode) => {
      el.style.cursor = CURSORS[mode];
      // The gizmo must not react to a press that is navigation (Alt+LMB over a handle orbits).
      this.gizmo.enabled = mode === "none" && this.opts.tool !== "view";
    };
    this.nav.onSpeedChange = (speed) => this.flashSpeed(speed);

    this.gizmo = new TransformControls(this.camera, el);
    this.gizmo.addEventListener("change", () => (this.dirty = true));
    this.gizmo.addEventListener("mouseDown", () => this.beginDrag());
    this.gizmo.addEventListener("objectChange", () => this.updateDrag());
    this.gizmo.addEventListener("mouseUp", () => this.endDrag());
    this.scene.add(this.gizmo.getHelper());

    this.marqueeEl = overlay(container, "marquee");
    this.speedEl = overlay(container, "speed-overlay");

    // Capture phase: decide before TransformControls' own (bubble) listener whether this press
    // is navigation, a gizmo drag, or selection.
    el.addEventListener("pointerdown", this.onPointerDown, true);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("keydown", this.onModKey);
    window.addEventListener("keyup", this.onModKey);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
    let last = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (this.nav.update(dt)) this.dirty = true;
      if (this.dirty) {
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    window.removeEventListener("keydown", this.onModKey);
    window.removeEventListener("keyup", this.onModKey);
    this.nav.dispose();
    this.gizmo.detach();
    this.gizmo.dispose();
    for (const tex of this.videoTextures.values()) tex.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.marqueeEl.remove();
    this.speedEl.remove();
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /** True while RMB-flying: the camera owns W/A/S/D/Q/E, so they must not switch tools. */
  get flying() {
    return this.nav.flying;
  }

  /** Where a newly placed light should go: the camera's pivot, rounded to 5cm, never below the floor. */
  placementPoint(): [number, number, number] {
    const t = this.nav.pivot;
    return [tidy(Math.round(t.x * 20) / 20), tidy(Math.max(0, Math.round(t.y * 20) / 20)), tidy(Math.round(t.z * 20) / 20)];
  }

  /** F: frame the selection — or the whole rig when nothing is selected. */
  frameSelection(ids = this.opts.selection) {
    const box = new THREE.Box3();
    const objs = ids.length ? ids.map((id) => this.views.get(id)?.obj).filter((o): o is THREE.Object3D => !!o) : [this.rigRoot];
    for (const o of objs) box.expandByObject(o);
    if (box.isEmpty()) return;
    this.nav.frame(box);
    this.dirty = true;
  }

  // ── Document → scene ───────────────────────────────────────────────────────

  sync(rig: RigDocument, opts: SceneOptions) {
    this.rig = rig;
    this.opts = opts;
    const seen = new Set<string>();
    const dragging = new Set(this.drag?.items.map((i) => i.id) ?? []);

    for (const node of rig.nodes) {
      seen.add(node.id);
      let view = this.views.get(node.id);
      if (!view) {
        const obj = new THREE.Group();
        obj.rotation.order = "YXZ";
        obj.userData.nodeId = node.id;
        view = { obj, shape: null };
        this.views.set(node.id, view);
      }
      const profile = node.light ? profileById(rig, node.light.profile) : undefined;
      const shape = profile ? `${profile.pixels}:${profile.length}` : node.surface ? JSON.stringify(node.surface) : null;
      if (shape !== view.shape) {
        this.rebuildLight(view, node.id, profile?.pixels ?? 0, profile?.length ?? 0);
        if (node.surface) this.buildSurface(view, node.id, node.surface);
      }
      view.shape = shape;
      // Don't fight the gizmo mid-drag; the drag's end commits and syncs.
      if (!dragging.has(node.id)) applyTransform(view.obj, node.transform);
    }

    for (const node of rig.nodes) {
      const view = this.views.get(node.id)!;
      const parent = (node.parent && this.views.get(node.parent)?.obj) || this.rigRoot;
      if (view.obj.parent !== parent) parent.add(view.obj);
    }
    // Reparent first, so a removed group can never take a surviving child down with it.
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      view.obj.removeFromParent();
      disposeTree(view.obj);
      this.views.delete(id);
    }

    this.paintBodies();
    this.paintPixels();
    this.paintSurfaces();
    this.syncGizmo();
    this.syncRoom(rig.room);
    if (!this.framedInitialRig && rig.nodes.some((node) => node.light || node.surface)) {
      this.frameSelection([]);
      this.framedInitialRig = true;
    }
    this.dirty = true;
  }

  /**
   * A frame in rig order, linear light — or null for "nothing is being previewed". `exposure`
   * multiplies it for the screen only: identify's dim blink and a sequence baked at a modest level
   * should both read clearly here.
   */
  setFrame(frame: Float32Array | null, exposure = 1) {
    this.frame = frame;
    this.exposure = exposure;
    this.paintPixels();
    this.dirty = true;
  }

  /** How to find the <video> a surface is showing. three.js only draws it; the evaluator samples it. */
  setVideoSource(fn: (surfaceId: string) => HTMLVideoElement | null) {
    this.videoOf = fn;
  }

  /** The surface's shape, straight from the model's mesh — so what is drawn is what is sampled. */
  private buildSurface(view: NodeView, id: string, surface: VideoSurface) {
    const mesh = surfaceMesh(surface);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    // The model measures v from the top of the picture; a three.js video texture (flipY) from the bottom.
    const uv = new Float32Array(mesh.uvs.length);
    for (let i = 0; i < uv.length; i += 2) {
      uv[i] = mesh.uvs[i]!;
      uv[i + 1] = 1 - mesh.uvs[i + 1]!;
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLOURS.surfaceEmpty, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    body.userData = { part: true, pickId: id };
    body.renderOrder = -1; // under the tubes, which are translucent too
    // Planar: just the border. Dome and sphere: a coarse graticule, so the shape reads without a picture.
    const lines = surface.projection === "planar" ? new THREE.EdgesGeometry(geo) : graticule(mesh, surface.projection === "dome" ? [48, 12] : [48, 24]);
    const outline = new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: COLOURS.surfaceOutline, transparent: true, opacity: 0.8 }));
    outline.userData = { part: true };
    outline.raycast = () => {};
    view.obj.add(body, outline);
    view.surface = body;
    view.outline = outline;
  }

  private textureFor(el: HTMLVideoElement): THREE.VideoTexture {
    let tex = this.videoTextures.get(el);
    if (!tex) {
      tex = new THREE.VideoTexture(el);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.videoTextures.set(el, tex);
    }
    return tex;
  }

  private paintSurfaces() {
    const sel = this.opts.selection;
    const active = sel[sel.length - 1];
    const used = new Set<HTMLVideoElement>();
    for (const [id, view] of this.views) {
      if (!view.surface || !view.outline) continue;
      view.surface.visible = view.outline.visible = this.opts.showSurfaces;
      const el = this.videoOf(id);
      if (el) used.add(el);
      const mat = view.surface.material;
      const map = el ? this.textureFor(el) : null;
      if (mat.map !== map) {
        mat.map = map;
        mat.needsUpdate = true;
      }
      mat.color.copy(map ? WHITE : COLOURS.surfaceEmpty);
      mat.opacity = map ? 0.6 : 0.18;
      view.outline.material.color.copy(id === active ? COLOURS.bodySelected : sel.includes(id) ? COLOURS.bodyInSelection : COLOURS.surfaceOutline);
    }
    for (const [el, tex] of this.videoTextures) {
      if (used.has(el)) continue;
      tex.dispose();
      this.videoTextures.delete(el);
    }
  }

  private rebuildLight(view: NodeView, id: string, pixels: number, length: number) {
    for (const child of [...view.obj.children]) {
      if (child.userData.part) {
        child.removeFromParent();
        disposeTree(child);
      }
    }
    view.body = view.pixels = view.marker = view.surface = view.outline = undefined;
    if (!pixels) return;

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(TUBE_RADIUS, TUBE_RADIUS, length, 12, 1),
      new THREE.MeshStandardMaterial({ color: COLOURS.body, transparent: true, opacity: 0.55, roughness: 0.6 }),
    );
    body.rotation.z = Math.PI / 2; // cylinders stand on Y; tubes lie along X
    body.userData = { part: true, pickId: id };

    // Show each pixel on the diffuser, not as a tiny box buried inside the casing.
    // The small clearance prevents the selection/body material from hiding the score.
    const geo = new THREE.CylinderGeometry(TUBE_RADIUS * 1.025, TUBE_RADIUS * 1.025, length / pixels * 0.98, 12);
    geo.rotateZ(Math.PI / 2);
    const pix = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff }), pixels);
    const m = new THREE.Matrix4();
    for (let i = 0; i < pixels; i++) {
      m.makeTranslation(-length / 2 + (i + 0.5) * length / pixels, 0, 0);
      pix.setMatrixAt(i, m);
      pix.setColorAt(i, COLOURS.pixelOff);
    }
    pix.userData = { part: true };
    pix.raycast = () => {}; // pick the body, not 32 boxes

    // The data-in end: a small red cone pointing along the chain.
    const marker = new THREE.Mesh(new THREE.ConeGeometry(TUBE_RADIUS * 1.5, TUBE_RADIUS * 3, 10), new THREE.MeshBasicMaterial({ color: COLOURS.inputEnd }));
    marker.rotation.z = -Math.PI / 2;
    marker.position.x = -length / 2 - TUBE_RADIUS * 1.5;
    marker.userData = { part: true };
    marker.raycast = () => {};

    // Keep a one-screen-pixel guide visible when a metre-long tube is viewed across a large room.
    // It is a viewport overlay only; it does not change pixel samples or physical fixture size.
    const guideGeometry = new THREE.BufferGeometry();
    const ends = new Float32Array(pixels * 6);
    for (let i = 0; i < pixels; i++) {
      ends[i * 6] = -length / 2 + i * length / pixels;
      ends[i * 6 + 3] = -length / 2 + (i + 1) * length / pixels;
    }
    guideGeometry.setAttribute("position", new THREE.BufferAttribute(ends, 3));
    guideGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pixels * 6), 3));
    const guide = new THREE.LineSegments(guideGeometry,
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true }));
    guide.userData = { part: true };
    guide.renderOrder = 1; // visible over the translucent tube body; each segment carries its pixel's colour
    guide.raycast = () => {};

    view.obj.add(body, pix, marker, guide);
    view.body = body;
    view.pixels = pix;
    view.marker = marker;
    view.outline = guide;
  }

  private paintBodies() {
    const rig = this.rig;
    if (!rig) return;
    const sel = this.opts.selection;
    const active = sel[sel.length - 1];
    const selected = new Set(sel);
    const inSelection = new Set(sel.flatMap((id) => subtree(rig, id).map((n) => n.id)));
    const patched = new Set(rig.chains.flatMap((c) => c.links.map((l) => l.light)));
    for (const [id, view] of this.views) {
      if (!view.body) continue;
      const mat = view.body.material;
      const colour = selected.has(id) ? COLOURS.bodySelected : inSelection.has(id) ? COLOURS.bodyInSelection : patched.has(id) ? COLOURS.body : COLOURS.bodyUnpatched;
      mat.color.copy(colour);
      mat.opacity = id === active ? 1 : inSelection.has(id) ? 0.85 : 0.55;
    }
  }

  private paintPixels() {
    const rig = this.rig;
    if (!rig) return;
    const frame = this.frame;
    for (const span of rigOrder(rig)) {
      const view = this.views.get(span.light.id);
      const pix = view?.pixels;
      if (!pix) continue;
      const guideColours = view.outline?.geometry.getAttribute("color");
      const guideOff = this.opts.selection.includes(span.light.id) ? COLOURS.bodySelected : COLOURS.fixtureGuide;
      for (let i = 0; i < span.count && i < pix.count; i++) {
        const o = (span.first + i) * 3;
        if (frame && o + 2 < frame.length && (frame[o]! > 0 || frame[o + 1]! > 0 || frame[o + 2]! > 0)) {
          const k = this.exposure;
          this.tmpColour.setRGB(Math.min(1, frame[o]! * k), Math.min(1, frame[o + 1]! * k), Math.min(1, frame[o + 2]! * k), THREE.LinearSRGBColorSpace);
          pix.setColorAt(i, this.tmpColour);
        } else {
          pix.setColorAt(i, COLOURS.pixelOff);
          this.tmpColour.copy(guideOff);
        }
        guideColours?.setXYZ(i * 2, this.tmpColour.r, this.tmpColour.g, this.tmpColour.b);
        guideColours?.setXYZ(i * 2 + 1, this.tmpColour.r, this.tmpColour.g, this.tmpColour.b);
      }
      if (pix.instanceColor) pix.instanceColor.needsUpdate = true;
      if (guideColours) guideColours.needsUpdate = true;
    }
  }

  // ── Room backdrop ──────────────────────────────────────────────────────────

  onRoomStatus(fn: (s: string | null) => void) {
    this.roomStatus = fn;
  }

  private syncRoom(room: RoomModel) {
    this.roomRoot.visible = room.visible;
    this.roomRoot.scale.setScalar(room.scale);
    this.roomRoot.rotation.order = "YXZ";
    this.roomRoot.rotation.set(room.rotation[0] * DEG, room.rotation[1] * DEG, room.rotation[2] * DEG);
    this.roomRoot.position.set(...room.position);
    if (room.file !== this.roomFile) this.loadRoom(room.file);
    this.applyRoomOpacity(room.opacity);
    this.reportRoomSize();
  }

  private lastRoomReport: string | null = null;
  /** "6.00 × 3.00 × 8.00 m" after fix-ups — the quickest check that the scale really is metres. */
  private reportRoomSize() {
    if (!this.roomModel) return;
    this.roomRoot.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(this.roomRoot).getSize(new THREE.Vector3());
    const text = `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m (W × H × D, after fix-ups)`;
    if (text !== this.lastRoomReport) {
      this.lastRoomReport = text;
      this.roomStatus(text);
    }
  }

  private applyRoomOpacity(opacity: number) {
    this.roomModel?.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const m = mat as THREE.Material;
        if (m.userData.baseOpacity === undefined) m.userData.baseOpacity = m.opacity;
        m.opacity = m.userData.baseOpacity * opacity;
        m.transparent = m.opacity < 1 || m.userData.baseTransparent === true;
        m.depthWrite = m.opacity >= 1;
      }
    });
  }

  private loadRoom(file: string | null) {
    this.roomFile = file;
    if (this.roomModel) {
      this.roomModel.removeFromParent();
      disposeTree(this.roomModel);
      this.roomModel = null;
    }
    if (!file) return this.roomStatus(null);
    this.roomStatus(`loading ${file}…`);
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath("/draco/");
    loader.setDRACOLoader(draco);
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      `/${file.split("/").map(encodeURIComponent).join("/")}`,
      (gltf) => {
        if (this.roomFile !== file) return; // superseded while loading
        this.roomModel = gltf.scene;
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.userData.baseTransparent = m.transparent;
        });
        this.roomRoot.add(gltf.scene);
        if (this.rig) this.applyRoomOpacity(this.rig.room.opacity);
        this.lastRoomReport = null;
        this.reportRoomSize();
        this.dirty = true;
      },
      undefined,
      (err) => {
        if (this.roomFile === file) this.roomStatus(`could not load ${file}: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }

  // ── Gizmo: one proxy drives every selected top-level node ──────────────────

  /** The selected nodes that actually move: those with no selected ancestor. */
  private topLevel(): { id: string; obj: THREE.Object3D }[] {
    const rig = this.rig;
    if (!rig) return [];
    const selected = new Set(this.opts.selection);
    const parentOf = new Map(rig.nodes.map((n) => [n.id, n.parent]));
    const hasSelectedAncestor = (id: string) => {
      for (let p = parentOf.get(id); p; p = parentOf.get(p)) if (selected.has(p)) return true;
      return false;
    };
    return this.opts.selection
      .filter((id) => !hasSelectedAncestor(id))
      .map((id) => ({ id, obj: this.views.get(id)?.obj }))
      .filter((x): x is { id: string; obj: THREE.Object3D } => !!x.obj);
  }

  private syncGizmo() {
    const o = this.opts;
    const items = this.topLevel();
    const show = o.tool !== "view" && items.length > 0;
    this.gizmo.enabled = show && this.nav.mode === "none";
    if (!show) {
      this.gizmo.detach();
      return;
    }
    this.gizmo.setMode(o.tool as "translate" | "rotate" | "scale");
    this.gizmo.setSpace(o.space);
    this.applySnap();
    if (!this.drag) this.placeProxy(items);
    if (this.gizmo.object !== this.proxy) this.gizmo.attach(this.proxy);
  }

  /** Pivot: the active object's origin. Center: the middle of the selection's bounds. */
  private placeProxy(items = this.topLevel()) {
    this.rigRoot.updateMatrixWorld(true);
    const active = this.views.get(this.opts.selection[this.opts.selection.length - 1] ?? "")?.obj ?? items[0]?.obj;
    if (!active) return;
    const pos = new THREE.Vector3();
    if (this.opts.pivot === "center" && items.length) {
      const box = new THREE.Box3();
      for (const { obj } of items) box.expandByObject(obj);
      if (box.isEmpty()) for (const { obj } of items) box.expandByPoint(obj.getWorldPosition(new THREE.Vector3()));
      box.getCenter(pos);
    } else active.getWorldPosition(pos);
    this.proxy.position.copy(pos);
    // Local: the gizmo takes the active object's orientation. Global: the world's.
    if (this.opts.space === "local") active.getWorldQuaternion(this.proxy.quaternion);
    else this.proxy.quaternion.identity();
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrixWorld(true);
  }

  private onModKey = (e: KeyboardEvent) => {
    if (e.metaKey === this.metaHeld && e.ctrlKey === this.metaHeld) return;
    this.metaHeld = e.metaKey || e.ctrlKey;
    this.applySnap();
  };

  /** Unity's increment snap: hold Cmd (Ctrl elsewhere) while dragging a handle. */
  private applySnap() {
    const on = this.metaHeld;
    this.gizmo.setTranslationSnap(on ? this.opts.snapMove : null);
    this.gizmo.setRotationSnap(on ? this.opts.snapRotate * DEG : null);
    this.gizmo.setScaleSnap(on ? 0.1 : null);
  }

  private beginDrag() {
    this.rigRoot.updateMatrixWorld(true);
    this.proxy.updateMatrixWorld(true);
    this.drag = {
      proxyStart: this.proxy.matrixWorld.clone(),
      proxyPos: this.proxy.position.clone(),
      proxyQuat: this.proxy.quaternion.clone(),
      items: this.topLevel().map(({ id, obj }) => ({ id, obj, world: obj.matrixWorld.clone(), scale: obj.scale.clone() })),
    };
  }

  private updateDrag() {
    const d = this.drag;
    if (!d) return;
    this.proxy.updateMatrixWorld(true);
    const mode = this.gizmo.mode;
    const perItemPivot = this.opts.pivot === "pivot" && d.items.length > 1;

    for (const item of d.items) {
      if (mode === "scale") {
        // Scale is always along each object's own axes, as in Unity.
        item.obj.scale.set(item.scale.x * this.proxy.scale.x, item.scale.y * this.proxy.scale.y, item.scale.z * this.proxy.scale.z);
        continue;
      }
      let world: THREE.Matrix4;
      if (mode === "translate") {
        const delta = this.proxy.position.clone().sub(d.proxyPos);
        world = new THREE.Matrix4().makeTranslation(delta.x, delta.y, delta.z).multiply(item.world);
      } else {
        const dq = this.proxy.quaternion.clone().multiply(d.proxyQuat.clone().invert());
        // Center (or one object): turn about the gizmo. Pivot with several: each about its own origin.
        const about = perItemPivot ? new THREE.Vector3().setFromMatrixPosition(item.world) : d.proxyPos;
        world = new THREE.Matrix4()
          .makeTranslation(about.x, about.y, about.z)
          .multiply(new THREE.Matrix4().makeRotationFromQuaternion(dq))
          .multiply(new THREE.Matrix4().makeTranslation(-about.x, -about.y, -about.z))
          .multiply(item.world);
      }
      const parent = item.obj.parent;
      const local = parent ? parent.matrixWorld.clone().invert().multiply(world) : world;
      local.decompose(item.obj.position, item.obj.quaternion, item.obj.scale);
      item.obj.rotation.setFromQuaternion(item.obj.quaternion, "YXZ");
    }
    this.dirty = true;
  }

  private endDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const changes = d.items.map(({ id, obj }) => {
      obj.rotation.reorder("YXZ");
      return {
        id,
        transform: {
          position: [tidy(obj.position.x), tidy(obj.position.y), tidy(obj.position.z)],
          rotation: [tidy(obj.rotation.x / DEG), tidy(obj.rotation.y / DEG), tidy(obj.rotation.z / DEG)],
          scale: [tidy(obj.scale.x), tidy(obj.scale.y), tidy(obj.scale.z)],
        } as Transform,
      };
    });
    this.placeProxy();
    // A press on a handle that never moved is not an edit (it would only mark the rig unsaved).
    const nodes = new Map(this.rig?.nodes.map((n) => [n.id, n.transform]) ?? []);
    const moved = changes.filter((c) => JSON.stringify(c.transform) !== JSON.stringify(nodes.get(c.id)));
    if (moved.length) this.cb.onTransforms(moved);
  }

  // ── Pointer: navigation, gizmo, or selection ───────────────────────────────

  private onPointerDown = (e: PointerEvent) => {
    const nav = this.nav.pointerDown(e, this.opts.tool === "view");
    if (nav !== "none") {
      // Navigation never reaches the gizmo.
      e.stopImmediatePropagation();
      return;
    }
    if (e.button !== 0) return;
    // Over a handle: the gizmo's press, not ours.
    if (this.gizmo.enabled && this.gizmo.object && this.gizmo.axis) return;
    this.press = { x: e.clientX, y: e.clientY, id: e.pointerId, shift: e.shiftKey, meta: e.metaKey || e.ctrlKey, base: [...this.opts.selection], marquee: false };
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      /* not an active pointer */
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.nav.mode !== "none") {
      this.nav.pointerMove(e);
      return;
    }
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    if (!p.marquee && Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) p.marquee = true;
    if (p.marquee) this.updateMarquee(e);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.nav.mode !== "none") {
      this.nav.pointerUp(e);
      this.gizmo.enabled = this.opts.tool !== "view" && !!this.gizmo.object;
      return;
    }
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    this.press = null;
    if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
    if (p.marquee) {
      this.marqueeEl.style.display = "none";
      return;
    }
    this.click(e, p);
  };

  /** Lights under a screen point, nearest first. */
  private hitsAt(clientX: number, clientY: number): string[] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const bodies = [...this.views.values()].flatMap((v) => (v.body ? [v.body] : []));
    const ids: string[] = [];
    for (const hit of ray.intersectObjects(bodies, false)) {
      const id = hit.object.userData.pickId as string;
      if (!ids.includes(id)) ids.push(id);
    }
    // A tube far away is a pixel wide; Unity picks what is DRAWN there, so allow a few pixels of
    // slop in screen space: any light with a pixel within PICK_RADIUS of the cursor, nearest first.
    const near: { id: string; depth: number }[] = [];
    const v = new THREE.Vector3();
    const m = new THREE.Matrix4();
    for (const [id, view] of this.views) {
      if (!view.pixels || ids.includes(id)) continue;
      let best = Infinity;
      for (let i = 0; i < view.pixels.count; i++) {
        view.pixels.getMatrixAt(i, m);
        v.setFromMatrixPosition(m).applyMatrix4(view.obj.matrixWorld).project(this.camera);
        if (v.z < -1 || v.z > 1) continue;
        const sx = rect.left + ((v.x + 1) / 2) * rect.width;
        const sy = rect.top + ((1 - v.y) / 2) * rect.height;
        if (Math.hypot(sx - clientX, sy - clientY) <= PICK_RADIUS) best = Math.min(best, v.z);
      }
      if (best < Infinity) near.push({ id, depth: best });
    }
    near.sort((a, b) => a.depth - b.depth);
    // Video surfaces last: they are large and translucent, and a tube in front of or behind one is
    // almost always what a click there is after. Clicking again cycles on to the surface.
    const surfaces = this.opts.showSurfaces ? [...this.views.values()].flatMap((v) => (v.surface ? [v.surface] : [])) : [];
    const behind: string[] = [];
    for (const hit of ray.intersectObjects(surfaces, false)) {
      const id = hit.object.userData.pickId as string;
      if (!behind.includes(id)) behind.push(id);
    }
    return [...ids, ...near.map((n) => n.id), ...behind];
  }

  private click(e: PointerEvent, p: NonNullable<SceneView["press"]>) {
    const hits = this.hitsAt(e.clientX, e.clientY);
    const lc = this.lastClick;
    const sameSpot = !!lc && Math.hypot(lc.x - e.clientX, lc.y - e.clientY) <= CLICK_SLOP && lc.hits.join() === hits.join();
    this.lastClick = { x: e.clientX, y: e.clientY, hits };
    const id = pickAt(hits, this.opts.selection[this.opts.selection.length - 1] ?? null, sameSpot);
    const next = applyClick(p.base, id, p.shift || p.meta);
    if (next.join() !== this.opts.selection.join()) this.cb.onSelect(next);
  }

  private updateMarquee(e: PointerEvent) {
    const p = this.press!;
    const box = this.container.getBoundingClientRect();
    const x0 = Math.min(p.x, e.clientX), x1 = Math.max(p.x, e.clientX);
    const y0 = Math.min(p.y, e.clientY), y1 = Math.max(p.y, e.clientY);
    Object.assign(this.marqueeEl.style, { display: "block", left: `${x0 - box.left}px`, top: `${y0 - box.top}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });

    // Any pixel of a light inside the rectangle selects it.
    const rect = this.renderer.domElement.getBoundingClientRect();
    const inside: string[] = [];
    const v = new THREE.Vector3();
    const m = new THREE.Matrix4();
    for (const [id, view] of this.views) {
      const pix = view.pixels;
      if (view.surface && this.opts.showSurfaces) {
        // A surface is selected by its origin, so dragging across one to reach tubes does not take it too.
        view.obj.updateMatrixWorld();
        v.setFromMatrixPosition(view.obj.matrixWorld).project(this.camera);
        const sx = rect.left + ((v.x + 1) / 2) * rect.width;
        const sy = rect.top + ((1 - v.y) / 2) * rect.height;
        if (v.z >= -1 && v.z <= 1 && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) inside.push(id);
        continue;
      }
      if (!pix) continue;
      view.obj.updateMatrixWorld();
      for (let i = 0; i < pix.count; i++) {
        pix.getMatrixAt(i, m);
        v.setFromMatrixPosition(m).applyMatrix4(view.obj.matrixWorld).project(this.camera);
        if (v.z < -1 || v.z > 1) continue;
        const sx = rect.left + ((v.x + 1) / 2) * rect.width;
        const sy = rect.top + ((1 - v.y) / 2) * rect.height;
        if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) {
          inside.push(id);
          break;
        }
      }
    }
    const next = applyRect(p.base, inside, p.meta ? "remove" : p.shift ? "add" : "replace");
    if (next.join() !== this.opts.selection.join()) this.cb.onSelect(next);
  }

  private flashSpeed(speed: number) {
    this.speedEl.textContent = `Fly speed ${speed < 1 ? speed.toFixed(2) : speed.toFixed(1)} m/s`;
    this.speedEl.style.display = "block";
    if (this.speedTimer) clearTimeout(this.speedTimer);
    this.speedTimer = setTimeout(() => (this.speedEl.style.display = "none"), 1200);
  }
}

const WHITE = new THREE.Color(0xffffff);

/** Every 4th parallel and meridian of a surface grid, as line segments. */
function graticule(mesh: { positions: Float32Array }, [nu, nv]: [number, number]): THREE.BufferGeometry {
  const at = (i: number, j: number) => {
    const k = (j * (nu + 1) + i) * 3;
    return [mesh.positions[k]!, mesh.positions[k + 1]!, mesh.positions[k + 2]!];
  };
  const pts: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      if (i < nu && (j % 4 === 0 || j === nv)) pts.push(...at(i, j), ...at(i + 1, j));
      if (j < nv && i % 4 === 0) pts.push(...at(i, j), ...at(i, j + 1));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

function overlay(container: HTMLElement, className: string) {
  const el = document.createElement("div");
  el.className = className;
  el.style.display = "none";
  container.appendChild(el);
  return el;
}

function applyTransform(obj: THREE.Object3D, t: Transform) {
  obj.position.set(...t.position);
  obj.rotation.order = "YXZ";
  obj.rotation.set(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG);
  obj.scale.set(...t.scale);
}

function axesAtOrigin() {
  const axes = new THREE.AxesHelper(0.5);
  (axes.material as THREE.Material).depthTest = false;
  axes.renderOrder = 1;
  return axes;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}
