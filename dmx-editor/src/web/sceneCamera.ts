// The viewport camera, modelled on Unity's Scene View — the controls Lucas has in his hands.
//
// State is Unity's: a PIVOT, a ROTATION and a DISTANCE. The camera sits `distance` behind the pivot
// along its view direction. Every navigation mode is a change to one of the three:
//
//   RMB held                fly: mouse-look about the camera, WASD move, Q down / E up (camera-local),
//                           Shift ×4, scroll changes fly speed. Speed builds while you keep moving.
//                           While RMB is held the keyboard belongs to the camera — W/E/Q do not
//                           switch tools (`flying` tells the app so).
//   Alt + LMB               orbit about the pivot
//   Alt + RMB               zoom (drag right / up = in)
//   MMB, or Alt + Cmd + LMB pan (the point under the cursor stays under the cursor)
//   LMB with the View tool  pan; Alt + LMB still orbits
//   Wheel                   zoom toward the pivot (proportional — it never passes through it)
//   F                       frame the selection (animated)
//
// Orbit and look are unclamped and roll-free (yaw about world up, pitch about the camera's own right
// axis), as in Unity — you can go over the top.

import * as THREE from "three";

export type NavMode = "none" | "fly" | "orbit" | "pan" | "zoom";

const LOOK_SENSITIVITY = 0.0035; // radians per pixel
const SHIFT_MULTIPLIER = 4;
const FLY_ACCELERATION = 0.8; // extra × per second of continuous movement…
const FLY_MAX_BOOST = 3; // …up to this
const MIN_DISTANCE = 0.01;
const FRAME_MS = 250;

const UP = new THREE.Vector3(0, 1, 0);

export class SceneCamera {
  readonly pivot = new THREE.Vector3(0, 1.2, 0);
  readonly rotation = new THREE.Quaternion();
  distance = 6;
  /** Fly speed in m/s before Shift and acceleration. Scroll while flying changes it. */
  flySpeed = 2;

  mode: NavMode = "none";
  private keys = new Set<string>();
  private shift = false;
  private flyHeld = 0; // seconds of continuous fly movement, for acceleration
  private last: { x: number; y: number } | null = null;
  private pointerId: number | null = null;
  private frameAnim: { from: THREE.Vector3; to: THREE.Vector3; d0: number; d1: number; t0: number } | null = null;

  /** Called when the camera moved (the viewport re-renders) or the mode / fly speed changed. */
  onChange: () => void = () => {};
  onModeChange: (mode: NavMode) => void = () => {};
  /** "Fly speed 2.0 m/s" — shown briefly when scrolling while flying, like Unity's overlay. */
  onSpeedChange: (speed: number) => void = () => {};

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    // Start looking at the origin from the front-right, a little above — Unity's default feel.
    this.rotation.setFromEuler(new THREE.Euler(-0.35, 0.7, 0, "YXZ"));
    this.apply();
    dom.addEventListener("contextmenu", this.onContextMenu);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
  }

  dispose() {
    this.dom.removeEventListener("contextmenu", this.onContextMenu);
    this.dom.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
  }

  get flying() {
    return this.mode === "fly";
  }

  forward(out = new THREE.Vector3()) {
    return out.set(0, 0, -1).applyQuaternion(this.rotation);
  }

  /** Put the three.js camera where the pivot/rotation/distance say. */
  apply() {
    this.camera.quaternion.copy(this.rotation);
    this.camera.position.copy(this.pivot).addScaledVector(this.forward(), -this.distance);
    this.camera.updateMatrixWorld();
  }

  // ── Pointer: the viewport routes button presses here when they are navigation ──

  /**
   * Decide whether a pointerdown is navigation. Returns the mode it started, or "none" if the
   * press belongs to selection / the gizmo.
   */
  pointerDown(e: PointerEvent, viewTool: boolean): NavMode {
    let mode: NavMode = "none";
    if (e.button === 2) mode = e.altKey ? "zoom" : "fly";
    else if (e.button === 1) mode = "pan";
    else if (e.button === 0) {
      if (e.altKey && e.metaKey) mode = "pan";
      else if (e.altKey) mode = "orbit";
      else if (viewTool) mode = "pan";
    }
    if (mode === "none") return mode;
    e.preventDefault();
    this.frameAnim = null;
    this.setMode(mode);
    this.last = { x: e.clientX, y: e.clientY };
    this.pointerId = e.pointerId;
    try {
      this.dom.setPointerCapture(e.pointerId);
    } catch {
      /* not an active pointer (synthetic event) — navigation still works while over the canvas */
    }
    this.flyHeld = 0;
    this.shift = e.shiftKey;
    return mode;
  }

  pointerMove(e: PointerEvent) {
    if (this.mode === "none" || e.pointerId !== this.pointerId || !this.last) return;
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    if (!dx && !dy) return;

    switch (this.mode) {
      case "fly":
      case "orbit": {
        const pos = this.camera.position.clone();
        const yaw = new THREE.Quaternion().setFromAxisAngle(UP, -dx * LOOK_SENSITIVITY);
        const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy * LOOK_SENSITIVITY);
        this.rotation.premultiply(yaw).multiply(pitch).normalize();
        // Fly turns about the camera (the pivot swings round in front of it); orbit turns about the pivot.
        if (this.mode === "fly") this.pivot.copy(pos).addScaledVector(this.forward(), this.distance);
        break;
      }
      case "pan": {
        // Scale so the point at the pivot's depth tracks the cursor exactly.
        const h = this.dom.clientHeight || 1;
        const metresPerPixel = (2 * this.distance * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.rotation);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.rotation);
        this.pivot.addScaledVector(right, -dx * metresPerPixel).addScaledVector(up, dy * metresPerPixel);
        break;
      }
      case "zoom":
        this.zoomBy(Math.exp(-(dx - dy) * 0.006));
        break;
    }
    this.apply();
    this.onChange();
  }

  pointerUp(e: PointerEvent) {
    if (e.pointerId !== this.pointerId) return;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    this.pointerId = null;
    this.last = null;
    this.setMode("none");
  }

  private setMode(mode: NavMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== "fly") {
      this.flyHeld = 0;
      this.keys.clear(); // letting go of RMB stops the flight, even with W still down
    }
    this.onModeChange(mode);
  }

  // ── Wheel and keys ─────────────────────────────────────────────────────────

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.mode === "fly") {
      // Unity: scrolling during flythrough changes the camera speed.
      this.flySpeed = THREE.MathUtils.clamp(this.flySpeed * Math.exp(-e.deltaY * 0.002), 0.05, 50);
      this.onSpeedChange(this.flySpeed);
      return;
    }
    this.frameAnim = null;
    const lines = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomBy(Math.exp(lines * 0.0015 * (e.shiftKey ? SHIFT_MULTIPLIER : 1)));
    this.apply();
    this.onChange();
  };

  private zoomBy(factor: number) {
    this.distance = THREE.MathUtils.clamp(this.distance * factor, MIN_DISTANCE, 2000);
  }

  private static FLY_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"]);

  private onKeyDown = (e: KeyboardEvent) => {
    this.shift = e.shiftKey;
    if (this.mode !== "fly") return;
    // RMB is an input lock: while flying, the camera keys are the camera's and nobody else's.
    if (SceneCamera.FLY_KEYS.has(e.code)) {
      this.keys.add(e.code);
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.shift = e.shiftKey;
    this.keys.delete(e.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.shift = false;
  };

  private onContextMenu = (e: Event) => e.preventDefault();

  /** Per-frame: fly movement and the frame-selection animation. Returns true if the camera moved. */
  update(dt: number): boolean {
    let moved = false;

    if (this.frameAnim) {
      const a = this.frameAnim;
      const t = Math.min(1, (performance.now() - a.t0) / FRAME_MS);
      const k = 1 - Math.pow(1 - t, 3);
      this.pivot.lerpVectors(a.from, a.to, k);
      this.distance = a.d0 + (a.d1 - a.d0) * k;
      if (t >= 1) this.frameAnim = null;
      moved = true;
    }

    if (this.mode === "fly") {
      const k = this.keys;
      const f = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
      const r = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
      const u = (k.has("KeyE") ? 1 : 0) - (k.has("KeyQ") ? 1 : 0);
      if (f || r || u) {
        this.flyHeld += dt;
        const boost = Math.min(FLY_MAX_BOOST, 1 + this.flyHeld * FLY_ACCELERATION);
        const speed = this.flySpeed * boost * (this.shift ? SHIFT_MULTIPLIER : 1);
        const move = new THREE.Vector3(r, u, -f).normalize().applyQuaternion(this.rotation).multiplyScalar(speed * dt);
        this.pivot.add(move);
        moved = true;
      } else this.flyHeld = 0;
    }

    if (moved) this.apply();
    return moved;
  }

  /** Frame a bounding box: pivot to its centre, distance to fit it — animated, as Unity's F is. */
  frame(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.25, box.getBoundingSphere(new THREE.Sphere()).radius);
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const fit = radius / Math.sin(Math.min(halfFov, halfFov * this.camera.aspect));
    this.frameAnim = { from: this.pivot.clone(), to: centre, d0: this.distance, d1: fit, t0: performance.now() };
  }
}
