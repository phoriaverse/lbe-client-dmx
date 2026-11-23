// The rig: everything physical about the lighting install — what fixtures exist, where they are in
// the room, how they are wired, and where the video surfaces they sample from sit. ONE rig file is shared by every sequence; sequences (milestone
// 4) refer to its lights by id and never redefine them.
//
// The document is plain JSON-able data, edited only through the DocStore (store.ts) so undo/redo
// and autosave (milestone 6) can be added in one place. Nothing in here touches three.js.
//
// Coordinates are metres, Y-up. A light's pixels lie along its LOCAL +X axis, centred on its
// origin, pixel 0 at the −X end — the end the data goes in. The viewport marks that end, and
// Identify lights it differently, so a tube drawn backwards is caught on the bench.

import { type ColourOrder, COLOUR_ORDERS } from "../../../dmx-client/src/shared/patch";
import { identityTransform, type Transform, type Vec3 } from "./transform";

export const RIG_FORMAT = "lbe-rig";
export const RIG_VERSION = 1;

/** A fixture TYPE: what a light is, independent of where it is. */
export interface FixtureProfile {
  id: string;
  name: string;
  /** Pixels along the fixture. */
  pixels: number;
  /** Physical length in metres; pixels are evenly spaced along it. */
  length: number;
  order: ColourOrder;
  /** Drive-curve exponent; see PixelRun.gamma in the shared patch. */
  gamma: number;
  /** Per-channel white-balance trim, linear light. Omitted means [1,1,1]. */
  gain?: Vec3;
}

/** How a video surface maps its picture into space. The maths is in surfaces.ts. */
export type Projection = "planar" | "dome" | "equirect";
export const PROJECTIONS: readonly Projection[] = ["planar", "dome", "equirect"];

/**
 * A video surface: a shape in the room that a sequence plays a video on, and that lights sample
 * their colour from. It is a rig node like a light — same transform, same parenting — because where
 * the picture sits in the room is part of the install, not of one sequence. WHICH video plays on it
 * is the sequence's business (sequence.ts).
 *
 * Every field is always present, so switching projection keeps the others' values.
 */
export interface VideoSurface {
  projection: Projection;
  /** Planar: metres across local X. The picture lies in the local XY plane and faces +Z. */
  width: number;
  /** Planar: metres up local Y. */
  height: number;
  /** Dome and equirect: radius in metres of the shell drawn (and measured to, for nearest-surface). */
  radius: number;
  /** Dome: the fisheye picture's field of view in degrees. 180 is a hemisphere. */
  fov: number;
}

export const defaultSurface = (projection: Projection = "planar"): VideoSurface => ({ projection, width: 3.2, height: 1.8, radius: 3, fov: 180 });

/**
 * A node in the scene hierarchy. With `light` it is a fixture; with `surface` a video surface;
 * with neither it is a group (a rail, a truss) that only carries a transform for its children.
 * Siblings are ordered by their position in `RigDocument.nodes`.
 */
export interface RigNode {
  id: string;
  name: string;
  parent: string | null;
  transform: Transform;
  light?: { profile: string };
  surface?: VideoSurface;
}

export interface RigGateway {
  /** Stable id, referenced by chains and by the compiled patch. Not the IP. */
  id: string;
  name?: string;
  host: string;
  /** Destination UDP port; omitted = 6454. Only the simulator wants anything else. */
  port?: number;
}

/** A light's place in a chain. `start` pins its address; otherwise it follows the light before it. */
export interface ChainLink {
  light: string;
  start?: { universe: number; channel: number };
}

/**
 * A daisy chain off one gateway output, in wire order. Patching follows this order: the first link
 * starts at (universe, channel), each next one at the channel after the previous one ends, unless a
 * link pins its own start (the manual override), after which the chain continues from there.
 */
export interface Chain {
  id: string;
  name: string;
  gateway: string;
  universe: number;
  channel: number;
  links: ChainLink[];
}

/** The room model drawn as a backdrop. Fix-ups are applied on top of whatever the GLB contains. */
export interface RoomModel {
  /** Path relative to dmx-editor/ (uploads land in models/), or null for none. */
  file: string | null;
  /** Uniform scale to metres: 1 for a metres export, 0.01 for centimetres, 0.001 for millimetres. */
  scale: number;
  /** Euler degrees (YXZ) — e.g. [-90, 0, 0] to stand a Z-up export upright. */
  rotation: Vec3;
  /** Metres, after scale and rotation. */
  position: Vec3;
  visible: boolean;
  /** 0–1. Lower it to see the lights through walls. */
  opacity: number;
}

export interface RigDocument {
  format: typeof RIG_FORMAT;
  version: typeof RIG_VERSION;
  name: string;
  profiles: FixtureProfile[];
  nodes: RigNode[];
  gateways: RigGateway[];
  chains: Chain[];
  room: RoomModel;
}

/** Today's fixture, from the bench (Notion: CL05 Tubes). */
export const CL05_PROFILE: FixtureProfile = {
  id: "cl05",
  name: "CLEN CL05 tube",
  pixels: 32,
  length: 0.5,
  order: "GRB",
  gamma: 2.2,
};

/**
 * A new rig: the CL05 profile, the bench gateway, and one empty chain on it. The gateway id is
 * "gw1" — the id simplePatch gives the same gateway, which is what lets a 21-tube chain built here
 * compile to exactly the patch lighting-client's config builds.
 */
export function newRig(): RigDocument {
  return {
    format: RIG_FORMAT,
    version: RIG_VERSION,
    name: "Untitled rig",
    profiles: [{ ...CL05_PROFILE }],
    nodes: [],
    gateways: [{ id: "gw1", name: "CL-104PS", host: "2.0.0.100" }],
    chains: [{ id: "chain1", name: "Chain 1", gateway: "gw1", universe: 0, channel: 1, links: [] }],
    room: defaultRoom(),
  };
}

export const defaultRoom = (): RoomModel => ({ file: null, scale: 1, rotation: [0, 0, 0], position: [0, 0, 0], visible: true, opacity: 1 });

// ── Files ────────────────────────────────────────────────────────────────────

/**
 * The saved form. Plain JSON with stable key order (the document's own), two-space indented with a
 * trailing newline, so a rig diffs sensibly in git and parse → serialize is byte-identical.
 */
export function serializeRig(rig: RigDocument): string {
  return `${JSON.stringify(rig, null, 2)}\n`;
}

/**
 * Read a rig file. Throws with every problem found rather than half-loading: a rig that silently
 * lost a chain would repatch the wall. Fields a newer editor might add are kept untouched.
 */
export function parseRig(text: string): RigDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`rig is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const problems = rigFileProblems(raw);
  if (problems.length) throw new Error(`rig file is invalid: ${problems.join("; ")}`);
  return raw as RigDocument;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isTransform = (v: unknown): v is Transform => isObj(v) && isVec3(v.position) && isVec3(v.rotation) && isVec3(v.scale);

/** Structural problems with a rig file — shape, not meaning (see rigProblems in patch.ts for that). */
export function rigFileProblems(raw: unknown): string[] {
  const p: string[] = [];
  if (!isObj(raw)) return ["not an object"];
  if (raw.format !== RIG_FORMAT) p.push(`format is ${JSON.stringify(raw.format)}, expected "${RIG_FORMAT}"`);
  if (raw.version !== RIG_VERSION) p.push(`version ${JSON.stringify(raw.version)} (this editor reads ${RIG_VERSION})`);
  if (typeof raw.name !== "string") p.push("name is missing");

  if (!Array.isArray(raw.profiles)) p.push("profiles is not a list");
  else
    raw.profiles.forEach((f, i) => {
      if (!isObj(f) || typeof f.id !== "string" || typeof f.name !== "string") return p.push(`profile ${i} has no id/name`);
      if (!Number.isInteger(f.pixels) || (f.pixels as number) < 1) p.push(`profile "${f.id}" has ${f.pixels} pixels`);
      if (!isNum(f.length) || f.length <= 0) p.push(`profile "${f.id}" has length ${f.length}`);
      if (!COLOUR_ORDERS.includes(f.order as ColourOrder)) p.push(`profile "${f.id}" has colour order ${f.order}`);
      if (!isNum(f.gamma) || f.gamma <= 0) p.push(`profile "${f.id}" has gamma ${f.gamma}`);
      if (f.gain !== undefined && !isVec3(f.gain)) p.push(`profile "${f.id}" has a malformed gain`);
    });

  if (!Array.isArray(raw.nodes)) p.push("nodes is not a list");
  else
    raw.nodes.forEach((n, i) => {
      if (!isObj(n) || typeof n.id !== "string" || typeof n.name !== "string") return p.push(`node ${i} has no id/name`);
      if (n.parent !== null && typeof n.parent !== "string") p.push(`node "${n.id}" has a malformed parent`);
      if (!isTransform(n.transform)) p.push(`node "${n.id}" has a malformed transform`);
      if (n.light !== undefined && !(isObj(n.light) && typeof n.light.profile === "string")) p.push(`node "${n.id}" has a malformed light`);
      if (n.surface !== undefined) {
        const s = n.surface;
        if (!isObj(s) || !PROJECTIONS.includes(s.projection as Projection)) p.push(`node "${n.id}" has a malformed surface`);
        else if (![s.width, s.height, s.radius, s.fov].every((v) => isNum(v) && v > 0)) p.push(`surface "${n.id}" has a size that is not above 0`);
        if (n.light !== undefined) p.push(`node "${n.id}" is both a light and a surface`);
      }
    });

  if (!Array.isArray(raw.gateways)) p.push("gateways is not a list");
  else
    raw.gateways.forEach((g, i) => {
      if (!isObj(g) || typeof g.id !== "string" || typeof g.host !== "string") return p.push(`gateway ${i} has no id/host`);
      if (g.port !== undefined && !Number.isInteger(g.port)) p.push(`gateway "${g.id}" has port ${g.port}`);
    });

  if (!Array.isArray(raw.chains)) p.push("chains is not a list");
  else
    raw.chains.forEach((c, i) => {
      if (!isObj(c) || typeof c.id !== "string" || typeof c.gateway !== "string") return p.push(`chain ${i} has no id/gateway`);
      if (!Number.isInteger(c.universe) || !Number.isInteger(c.channel)) p.push(`chain "${c.id}" has a malformed start`);
      if (!Array.isArray(c.links)) return p.push(`chain "${c.id}" has no links list`);
      c.links.forEach((l, j) => {
        if (!isObj(l) || typeof l.light !== "string") return p.push(`chain "${c.id}" link ${j} names no light`);
        if (l.start !== undefined && !(isObj(l.start) && Number.isInteger(l.start.universe) && Number.isInteger(l.start.channel))) {
          p.push(`chain "${c.id}" link ${j} has a malformed start`);
        }
      });
    });

  const r = raw.room;
  if (!isObj(r)) p.push("room is missing");
  else {
    if (r.file !== null && typeof r.file !== "string") p.push("room.file is malformed");
    if (!isNum(r.scale) || r.scale <= 0) p.push(`room.scale is ${r.scale}`);
    if (!isVec3(r.rotation) || !isVec3(r.position)) p.push("room rotation/position is malformed");
    if (typeof r.visible !== "boolean" || !isNum(r.opacity)) p.push("room visible/opacity is malformed");
  }
  return p;
}

// ── Queries ──────────────────────────────────────────────────────────────────

export const nodeById = (rig: RigDocument, id: string) => rig.nodes.find((n) => n.id === id);
export const profileById = (rig: RigDocument, id: string) => rig.profiles.find((f) => f.id === id);
export const childrenOf = (rig: RigDocument, id: string | null) => rig.nodes.filter((n) => n.parent === id);

/** The node and everything under it, depth-first in sibling order. */
export function subtree(rig: RigDocument, id: string): RigNode[] {
  const root = nodeById(rig, id);
  if (!root) return [];
  const out: RigNode[] = [root];
  for (const child of childrenOf(rig, id)) out.push(...subtree(rig, child.id));
  return out;
}

/** Every node depth-first in hierarchy order — the outliner's order. */
export function hierarchyOrder(rig: RigDocument): RigNode[] {
  const out: RigNode[] = [];
  const ids = new Set(rig.nodes.map((n) => n.id));
  // Orphans (a parent id that no longer exists) are shown at the root rather than lost.
  for (const n of rig.nodes) if (n.parent === null || !ids.has(n.parent)) out.push(...subtree(rig, n.id));
  return out;
}

export const isLight = (n: RigNode): n is RigNode & { light: { profile: string } } => n.light !== undefined;
export const isSurface = (n: RigNode): n is RigNode & { surface: VideoSurface } => n.surface !== undefined;

export { identityTransform };
