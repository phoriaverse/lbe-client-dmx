import { describe, expect, test } from "bun:test";
import { compilePatch, simplePatch, validatePatch } from "../../dmx-client/src/shared/patch";
import { addGateway, addRail, addTube, chainLights, deleteNodes, moveLink, setLinkStart, addChain } from "../src/model/ops";
import { compileRigPatch, resolveChain, rigOrder, rigProblems } from "../src/model/patch";
import { newRig, type RigDocument } from "../src/model/rig";

const edit = (rig: RigDocument, fn: (d: RigDocument) => void) => {
  const d = structuredClone(rig);
  fn(d);
  return d;
};

describe("the milestone 2 acceptance check", () => {
  // The bench: 21 CL05 tubes on one chain off the CL-104PS. lighting-client's config.json builds
  // its patch with simplePatch; a rig describing the same wiring must compile to the same thing.
  const expected = simplePatch({ host: "2.0.0.100", fixtures: 21, pixelsPerFixture: 32 });

  test("21 single tubes placed in chain order compile to simplePatch", () => {
    const rig = edit(newRig(), (d) => {
      for (let i = 0; i < 21; i++) addTube(d);
    });
    expect(compileRigPatch(rig)).toEqual(expected);
    expect(JSON.stringify(compileRigPatch(rig))).toBe(JSON.stringify(expected));
  });

  test("the same 21 tubes as rails (5+5+5+3+3) compile to simplePatch", () => {
    const rig = edit(newRig(), (d) => {
      for (const tubes of [5, 5, 5, 3, 3]) addRail(d, { tubes });
    });
    expect(rigOrder(rig)).toHaveLength(21);
    expect(compileRigPatch(rig)).toEqual(expected);
  });

  test("it is a patch the client accepts", () => {
    const rig = edit(newRig(), (d) => {
      for (let i = 0; i < 21; i++) addTube(d);
    });
    expect(validatePatch(compileRigPatch(rig))).toEqual([]);
    expect(rigProblems(rig)).toEqual([]);
    expect(compilePatch(compileRigPatch(rig)).slots.map((s) => s.universe)).toEqual([0, 1, 2, 3]);
  });
});

describe("chain order", () => {
  test("reordering the chain reorders both the frame and the addresses", () => {
    const rig = edit(newRig(), (d) => {
      for (let i = 0; i < 3; i++) addTube(d);
      moveLink(d, "chain1", 2, 0);
    });
    const [a, b, c] = rig.nodes;
    expect(rigOrder(rig).map((s) => s.light.id)).toEqual([c!.id, a!.id, b!.id]);
    expect(compileRigPatch(rig).runs.map((r) => [r.first, r.channel])).toEqual([
      [0, 1],
      [32, 97],
      [64, 193],
    ]);
  });

  test("a pinned link starts where it is told and the chain continues from it", () => {
    const rig = edit(newRig(), (d) => {
      for (let i = 0; i < 3; i++) addTube(d);
      setLinkStart(d, "chain1", 1, { universe: 2, channel: 1 });
    });
    expect(resolveChain(rig, rig.chains[0]!).map((l) => [l.universe, l.channel, l.pinned])).toEqual([
      [0, 1, false],
      [2, 1, true],
      [2, 97, false],
    ]);
    expect(rigProblems(rig)).toEqual([]);
  });

  test("a pin that overlaps the chain before it is reported, not silently compiled", () => {
    const rig = edit(newRig(), (d) => {
      for (let i = 0; i < 2; i++) addTube(d);
      setLinkStart(d, "chain1", 1, { universe: 0, channel: 49 });
    });
    expect(rigProblems(rig).join(" ")).toContain("both write");
  });

  test("unchained lights are in the frame but not the patch", () => {
    const rig = edit(newRig(), (d) => {
      addTube(d);
      addTube(d, { chain: null });
    });
    const patch = compileRigPatch(rig);
    expect(patch.pixelCount).toBe(64);
    expect(patch.runs).toHaveLength(1);
    expect(validatePatch(patch)).toEqual([]);
  });

  test("two gateways, one chain each, patch independently from universe 0", () => {
    const rig = edit(newRig(), (d) => {
      addTube(d);
      const gw = addGateway(d, "2.0.0.101");
      const chain = addChain(d, gw);
      addTube(d, { chain });
    });
    const patch = compileRigPatch(rig);
    expect(patch.runs.map((r) => [r.gateway, r.universe, r.channel, r.first])).toEqual([
      ["gw1", 0, 1, 0],
      ["gw2", 0, 1, 32],
    ]);
    expect(validatePatch(patch)).toEqual([]);
  });

  test("moving a light to another chain takes it off the first", () => {
    const rig = edit(newRig(), (d) => {
      const a = addTube(d);
      addTube(d);
      const chain = addChain(d);
      chainLights(d, chain, [a]);
    });
    expect(rig.chains.map((c) => c.links.length)).toEqual([1, 1]);
    expect(rigProblems(rig).join(" ")).toContain("both write"); // same gateway, both at 0/1
  });

  test("deleting a rail removes its tubes from the chain", () => {
    const rig = edit(newRig(), (d) => {
      const rail = addRail(d, { tubes: 3 });
      addTube(d);
      deleteNodes(d, [rail]);
    });
    expect(rig.nodes).toHaveLength(1);
    expect(rig.chains[0]!.links).toHaveLength(1);
    expect(compileRigPatch(rig).runs[0]!.channel).toBe(1);
  });
});
