import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { addRail, addTube, duplicateNode, reparent, setTransform, addGroup, setLinkStart, updateRoom, addGateway, updateGateway } from "../src/model/ops";
import { identifyFrame, pixelMap, worldMatrices } from "../src/model/pixels";
import { newRig, parseRig, type RigDocument, serializeRig } from "../src/model/rig";
import { DocStore } from "../src/model/store";
import { compose, decompose, invert, multiply, type Transform } from "../src/model/transform";

const DEG = Math.PI / 180;

const threeMatrix = (t: Transform) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(...t.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, "YXZ")),
    new THREE.Vector3(...t.scale),
  );

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(eps);
};

describe("transforms match three.js (the viewport) exactly", () => {
  const samples: Transform[] = [
    { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { position: [0, 2.4, -1], rotation: [30, 45, 60], scale: [1, 1, 1] },
    { position: [-3, 0.1, 7], rotation: [-90, 0, 0], scale: [0.01, 0.01, 0.01] },
    { position: [0.5, 0, 0], rotation: [12, -170, 95], scale: [2, 1, 0.5] },
  ];

  test("compose", () => {
    for (const t of samples) close(compose(t), threeMatrix(t).elements);
  });

  test("decompose ∘ compose is the identity", () => {
    for (const t of samples) {
      const back = decompose(compose(t));
      close(compose(back), compose(t), 1e-5);
    }
  });

  test("invert", () => {
    for (const t of samples) close(invert(compose(t))!, threeMatrix(t).invert().elements, 1e-7);
  });

  test("a nested light's pixels land where three.js would draw them", () => {
    const rig = (() => {
      const d = newRig();
      const rail = addRail(d, { tubes: 3, transform: { position: [2, 2.5, -1], rotation: [0, 90, 0], scale: [1, 1, 1] } });
      setTransform(d, d.nodes.find((n) => n.parent === rail)!.id, { position: [-0.5, 0, 0], rotation: [0, 0, 90], scale: [1, 1, 1] });
      return d;
    })();

    // The same hierarchy built in three.js.
    const objects = new Map<string, THREE.Object3D>();
    const root = new THREE.Object3D();
    for (const n of rig.nodes) {
      const o = new THREE.Object3D();
      o.rotation.order = "YXZ";
      o.position.set(...n.transform.position);
      o.rotation.set(n.transform.rotation[0] * DEG, n.transform.rotation[1] * DEG, n.transform.rotation[2] * DEG);
      o.scale.set(...n.transform.scale);
      objects.set(n.id, o);
    }
    for (const n of rig.nodes) (n.parent ? objects.get(n.parent)! : root).add(objects.get(n.id)!);
    root.updateMatrixWorld(true);

    const worlds = worldMatrices(rig);
    for (const n of rig.nodes) close(worlds.get(n.id)!, objects.get(n.id)!.matrixWorld.elements, 1e-9);

    // Pixel 0 of the first tube: rotated 90° about Z inside a rail yawed 90° — it points down.
    const map = pixelMap(rig);
    const p0 = new THREE.Vector3(-0.25 + 0.5 / 64, 0, 0).applyMatrix4(objects.get(rig.nodes[1]!.id)!.matrixWorld);
    close(map.positions.subarray(0, 3), [p0.x, p0.y, p0.z], 1e-6);
  });
});

describe("pixels", () => {
  test("a tube's 32 pixels span its 0.5m, pixel 0 at the −X end", () => {
    const d = newRig();
    addTube(d, { transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    const { positions, pixelCount } = pixelMap(d);
    expect(pixelCount).toBe(32);
    close([positions[0]!, positions[1]!], [-0.25 + 0.5 / 64, 2], 1e-6);
    close([positions[31 * 3]!], [0.25 - 0.5 / 64], 1e-6);
  });

  test("identify lights only the chosen tube, pixel 0 red", () => {
    const d = newRig();
    addTube(d);
    const b = addTube(d);
    const frame = identifyFrame(d, new Set([b]), true);
    expect(Math.max(...frame.subarray(0, 96))).toBe(0);
    expect(frame[96 + 1]).toBe(0); // pixel 0 of tube 2: red only
    expect(frame[96]!).toBeGreaterThan(0);
    expect(frame[99]).toBe(frame[100]!); // the rest white
    expect(Math.max(...identifyFrame(d, new Set([b]), false))).toBe(0);
  });
});

describe("hierarchy", () => {
  test("reparenting keeps the world position (Unity's default)", () => {
    const d = newRig();
    const tube = addTube(d, { transform: { position: [1, 2, 3], rotation: [10, 20, 30], scale: [1, 1, 1] } });
    const group = addGroup(d, { transform: { position: [5, 0, 0], rotation: [0, 45, 0], scale: [2, 2, 2] } });
    const before = worldMatrices(d).get(tube)!;
    reparent(d, tube, group);
    expect(d.nodes.find((n) => n.id === tube)!.parent).toBe(group);
    close(worldMatrices(d).get(tube)!, before, 1e-5);
    reparent(d, tube, null);
    close(worldMatrices(d).get(tube)!, before, 1e-5);
  });

  test("a node cannot be parented under its own descendant or a light", () => {
    const d = newRig();
    const rail = addRail(d, { tubes: 2 });
    const child = d.nodes.find((n) => n.parent === rail)!.id;
    expect(() => reparent(d, rail, child)).toThrow();
    const outer = addGroup(d);
    reparent(d, outer, rail);
    expect(() => reparent(d, rail, outer)).toThrow();
  });

  test("duplicating a rail copies its tubes with fresh names onto the same chain", () => {
    const d = newRig();
    const rail = addRail(d, { tubes: 3 });
    duplicateNode(d, rail);
    expect(d.nodes.filter((n) => n.light).map((n) => n.name)).toEqual(["Tube 1", "Tube 2", "Tube 3", "Tube 4", "Tube 5", "Tube 6"]);
    expect(d.chains[0]!.links).toHaveLength(6);
  });
});

describe("the rig file", () => {
  const busy = (): RigDocument => {
    const d = newRig();
    d.name = "Dolby Room";
    for (const tubes of [5, 5, 3]) addRail(d, { tubes, transform: { position: [Math.random() * 4, 2.4, -1.23456789], rotation: [0, 33.3, 0], scale: [1, 1, 1] } });
    addTube(d, { chain: null });
    setLinkStart(d, "chain1", 5, { universe: 1, channel: 1 });
    const gw = addGateway(d);
    updateGateway(d, gw, { port: 6455 });
    updateRoom(d, { file: "models/room.glb", scale: 0.01, rotation: [-90, 0, 0] });
    d.profiles[0]!.gain = [1, 0.9, 0.8];
    return d;
  };

  test("save → load is lossless, and load → save is byte-identical", () => {
    const rig = busy();
    const text = serializeRig(rig);
    const back = parseRig(text);
    expect(back).toEqual(rig);
    expect(serializeRig(back)).toBe(text);
  });

  test("a file from a newer editor keeps the fields this one does not know", () => {
    const text = serializeRig({ ...busy(), sequences: ["a"] } as RigDocument);
    expect(serializeRig(parseRig(text))).toBe(text);
  });

  test("a damaged file is refused with reasons, not half-loaded", () => {
    const broken = JSON.parse(serializeRig(busy()));
    broken.chains[0].links[0].start = { universe: "one" };
    delete broken.room;
    expect(() => parseRig(JSON.stringify(broken))).toThrow(/link 0 has a malformed start.*room is missing/);
  });
});

describe("the document store", () => {
  test("edits replace the document, leave the old value intact, and track dirtiness", () => {
    const store = new DocStore(newRig());
    const before = store.get();
    expect(store.dirty).toBe(false);
    store.edit("Add tube", (d) => void addTube(d));
    expect(before.nodes).toHaveLength(0);
    expect(store.get().nodes).toHaveLength(1);
    expect(store.dirty).toBe(true);
    store.markSaved();
    expect(store.dirty).toBe(false);
    expect(store.journal.map((e) => e.label)).toEqual(["Add tube"]);
  });

  test("a failing edit changes nothing", () => {
    const store = new DocStore(newRig());
    const before = store.get();
    expect(store.edit("Bad", (d) => { d.name = "x"; throw new Error("no"); })).toBe(false);
    expect(store.get()).toBe(before);
  });
});

// multiply is exercised through worldMatrices; keep an explicit check that it is a × b, not b × a.
test("multiply order", () => {
  const a = compose({ position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  const b = compose({ position: [0, 0, 0], rotation: [0, 90, 0], scale: [2, 2, 2] });
  close(multiply(a, b), new THREE.Matrix4().fromArray(a).multiply(new THREE.Matrix4().fromArray(b)).elements);
});
