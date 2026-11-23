// Edit operations: pure functions that mutate a DRAFT rig. Callers run them inside DocStore.edit, so
// every change has one entry point and a label:
//
//   store.edit("Add 5-tube rail", (d) => addRail(d, { tubes: 5 }));
//
// They never reach for the store, the DOM or three.js, which is what makes them testable and what
// lets the test build a 21-tube rig the same way a person in the editor does.

import { CL05_PROFILE, type Chain, childrenOf, defaultSurface, type FixtureProfile, isLight, nodeById, profileById, type Projection, type RigDocument, type RigGateway, type RigNode, subtree, type VideoSurface } from "./rig";
import { decompose, identityTransform, invert, multiply, type Transform, type Vec3 } from "./transform";
import { worldMatrices } from "./pixels";

export function newId(prefix: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (;;) {
    const id = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
    if (!used.has(id)) return id;
  }
}

const allIds = (d: RigDocument) => [...d.nodes.map((n) => n.id), ...d.profiles.map((p) => p.id), ...d.gateways.map((g) => g.id), ...d.chains.map((c) => c.id)];

/** "Tube 7" — the next free number for a name stem. */
function nextName(d: RigDocument, stem: string): string {
  let max = 0;
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`);
  for (const n of d.nodes) {
    const m = re.exec(n.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${stem} ${max + 1}`;
}

// ── Lights and groups ────────────────────────────────────────────────────────

export interface PlaceOptions {
  /** Fixture profile id; defaults to the first profile. */
  profile?: string;
  parent?: string | null;
  transform?: Transform;
  /** Chain the new light(s) are appended to, in placement order. null = leave unpatched. */
  chain?: string | null;
}

function defaultProfile(d: RigDocument): FixtureProfile {
  if (!d.profiles.length) d.profiles.push({ ...CL05_PROFILE });
  return d.profiles[0]!;
}

function appendToChain(d: RigDocument, chainId: string | null | undefined, lightIds: string[]) {
  const chain = chainId === undefined ? d.chains[0] : chainId === null ? undefined : d.chains.find((c) => c.id === chainId);
  if (!chain) return;
  for (const light of lightIds) chain.links.push({ light });
}

/** One light. Returns its id. Appended to the chain (the first one by default) — placement order IS chain order. */
export function addTube(d: RigDocument, opts: PlaceOptions = {}): string {
  const profile = opts.profile ? profileById(d, opts.profile) ?? defaultProfile(d) : defaultProfile(d);
  const id = newId("light", allIds(d));
  d.nodes.push({ id, name: nextName(d, "Tube"), parent: opts.parent ?? null, transform: opts.transform ?? identityTransform(), light: { profile: profile.id } });
  appendToChain(d, opts.chain, [id]);
  return id;
}

export interface RailOptions extends PlaceOptions {
  tubes: number;
  /**
   * "inline": end to end along the rail's X, each tube's data-out end meeting the next one's
   * data-in end. "parallel": side by side, stepping along the rail's Z.
   */
  layout?: "inline" | "parallel";
  /** Metres between tubes: end gap for inline, centre spacing for parallel. */
  gap?: number;
}

/** A group with `tubes` lights under it, chained in order. Returns the group's id. */
export function addRail(d: RigDocument, opts: RailOptions): string {
  const profile = opts.profile ? profileById(d, opts.profile) ?? defaultProfile(d) : defaultProfile(d);
  const layout = opts.layout ?? "inline";
  const gap = opts.gap ?? (layout === "inline" ? 0 : 0.1);
  const group = newId("group", allIds(d));
  d.nodes.push({ id: group, name: nextName(d, `Rail`), parent: opts.parent ?? null, transform: opts.transform ?? identityTransform() });
  const ids: string[] = [];
  for (let i = 0; i < opts.tubes; i++) {
    const offset = i - (opts.tubes - 1) / 2;
    const position: Vec3 = layout === "inline" ? [offset * (profile.length + gap), 0, 0] : [0, 0, offset * gap];
    ids.push(addTube(d, { profile: profile.id, parent: group, transform: { ...identityTransform(), position }, chain: null }));
  }
  appendToChain(d, opts.chain, ids);
  return group;
}

export function addGroup(d: RigDocument, opts: { parent?: string | null; transform?: Transform } = {}): string {
  const id = newId("group", allIds(d));
  d.nodes.push({ id, name: nextName(d, "Group"), parent: opts.parent ?? null, transform: opts.transform ?? identityTransform() });
  return id;
}

// ── Video surfaces ───────────────────────────────────────────────────────────

/** A video surface. Returns its id. Which video plays on it is set per sequence (sequence.ts). */
export function addSurface(d: RigDocument, opts: { projection?: Projection; parent?: string | null; transform?: Transform } = {}): string {
  const id = newId("surface", allIds(d));
  const projection = opts.projection ?? "planar";
  const stem = { planar: "Screen", dome: "Dome", equirect: "Sphere" }[projection];
  d.nodes.push({ id, name: nextName(d, stem), parent: opts.parent ?? null, transform: opts.transform ?? identityTransform(), surface: defaultSurface(projection) });
  return id;
}

export function updateSurface(d: RigDocument, id: string, patch: Partial<VideoSurface>) {
  const n = nodeById(d, id);
  if (n?.surface) Object.assign(n.surface, patch);
}

/** Delete nodes and everything under them, and take their lights off every chain. */
export function deleteNodes(d: RigDocument, ids: Iterable<string>) {
  const doomed = new Set<string>();
  for (const id of ids) for (const n of subtree(d, id)) doomed.add(n.id);
  d.nodes = d.nodes.filter((n) => !doomed.has(n.id));
  for (const c of d.chains) c.links = c.links.filter((l) => !doomed.has(l.light));
}

/** Copy a node (and its subtree) beside the original. New lights go on the end of the original's chain. */
export function duplicateNode(d: RigDocument, id: string): string | null {
  const nodes = subtree(d, id);
  if (!nodes.length) return null;
  const map = new Map<string, string>();
  for (const n of nodes) map.set(n.id, newId(n.light ? "light" : n.surface ? "surface" : "group", [...allIds(d), ...map.values()]));
  const insertAt = d.nodes.indexOf(nodes[nodes.length - 1]!) + 1;
  // Name each copy against the rig *including the copies so far*, so a duplicated rail's tubes get
  // fresh numbers rather than five lights all called "Tube 22".
  const copies: RigNode[] = [];
  for (const [i, n] of nodes.entries()) {
    const stem = n.light ? "Tube" : n.name.replace(/ \d+$/, "");
    const name = i === 0 || n.light || n.surface ? nextName({ ...d, nodes: [...d.nodes, ...copies] }, stem) : n.name;
    copies.push({ ...structuredClone(n), id: map.get(n.id)!, parent: i === 0 ? n.parent : map.get(n.parent!)!, name });
  }
  d.nodes.splice(insertAt, 0, ...copies);
  for (const n of nodes) {
    if (!isLight(n)) continue;
    const chain = d.chains.find((c) => c.links.some((l) => l.light === n.id));
    if (chain) chain.links.push({ light: map.get(n.id)! });
  }
  return map.get(id)!;
}

export function rename(d: RigDocument, id: string, name: string) {
  const n = nodeById(d, id);
  if (n) n.name = name;
}

export function setTransform(d: RigDocument, id: string, t: Transform) {
  const n = nodeById(d, id);
  if (n) n.transform = { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] };
}

export function setLightProfile(d: RigDocument, id: string, profile: string) {
  const n = nodeById(d, id);
  if (n?.light && profileById(d, profile)) n.light.profile = profile;
}

/**
 * Move a node under a new parent (null = the root), keeping where it is in the WORLD — Unity's
 * default. Refuses to parent a node under itself or its own descendant, and lights cannot parent.
 */
export function reparent(d: RigDocument, id: string, parent: string | null, index?: number) {
  const node = nodeById(d, id);
  if (!node) return;
  if (parent !== null) {
    const p = nodeById(d, parent);
    if (!p) throw new Error("no such parent");
    if (p.light) throw new Error("lights cannot have children");
    if (p.surface) throw new Error("video surfaces cannot have children");
    if (subtree(d, id).some((n) => n.id === parent)) throw new Error("cannot parent a node under itself");
  }
  const worlds = worldMatrices(d);
  const world = worlds.get(id)!;
  const parentWorld = parent ? worlds.get(parent)! : null;
  const inv = parentWorld ? invert(parentWorld) : null;
  if (parentWorld && !inv) throw new Error("parent has zero scale");
  node.transform = decompose(inv ? multiply(inv, world) : world);
  node.parent = parent;
  // Sibling order: move to the requested slot among the new siblings (default: last).
  d.nodes.splice(d.nodes.indexOf(node), 1);
  const siblings = childrenOf(d, parent);
  const anchor = index !== undefined && index < siblings.length ? siblings[index]! : null;
  d.nodes.splice(anchor ? d.nodes.indexOf(anchor) : d.nodes.length, 0, node);
}

// ── Profiles ─────────────────────────────────────────────────────────────────

export function addProfile(d: RigDocument, base?: FixtureProfile): string {
  const id = newId("profile", allIds(d));
  d.profiles.push({ ...(base ?? CL05_PROFILE), id, name: base ? `${base.name} copy` : "New fixture" });
  return id;
}

export function updateProfile(d: RigDocument, id: string, patch: Partial<Omit<FixtureProfile, "id">>) {
  const p = profileById(d, id);
  if (p) Object.assign(p, patch);
}

export function deleteProfile(d: RigDocument, id: string) {
  const users = d.nodes.filter((n) => n.light?.profile === id);
  if (users.length) throw new Error(`${users.length} light(s) use it`);
  d.profiles = d.profiles.filter((p) => p.id !== id);
}

// ── Gateways and chains ──────────────────────────────────────────────────────

export function addGateway(d: RigDocument, host = "2.0.0.101"): string {
  const id = `gw${d.gateways.length + 1}`;
  const free = d.gateways.some((g) => g.id === id) ? newId("gw", allIds(d)) : id;
  d.gateways.push({ id: free, name: `Gateway ${d.gateways.length + 1}`, host });
  return free;
}

export function updateGateway(d: RigDocument, id: string, patch: Partial<Omit<RigGateway, "id">>) {
  const g = d.gateways.find((x) => x.id === id);
  if (!g) return;
  Object.assign(g, patch);
  if (g.port === undefined || Number.isNaN(g.port)) delete g.port;
  if (!g.name) delete g.name;
}

export function deleteGateway(d: RigDocument, id: string) {
  const users = d.chains.filter((c) => c.gateway === id);
  if (users.length) throw new Error(`${users.map((c) => c.name).join(", ")} use it`);
  d.gateways = d.gateways.filter((g) => g.id !== id);
}

export function addChain(d: RigDocument, gateway?: string): string {
  const id = newId("chain", allIds(d));
  d.chains.push({ id, name: `Chain ${d.chains.length + 1}`, gateway: gateway ?? d.gateways[0]?.id ?? "gw1", universe: 0, channel: 1, links: [] });
  return id;
}

export function updateChain(d: RigDocument, id: string, patch: Partial<Pick<Chain, "name" | "gateway" | "universe" | "channel">>) {
  const c = d.chains.find((x) => x.id === id);
  if (c) Object.assign(c, patch);
}

export function deleteChain(d: RigDocument, id: string) {
  d.chains = d.chains.filter((c) => c.id !== id);
}

/** Put lights on a chain, in the order given, at `index` (default: the end). Removes them from any other chain first. */
export function chainLights(d: RigDocument, chainId: string, lightIds: string[], index?: number) {
  const chain = d.chains.find((c) => c.id === chainId);
  if (!chain) return;
  const ids = lightIds.filter((id) => nodeById(d, id)?.light);
  const set = new Set(ids);
  for (const c of d.chains) c.links = c.links.filter((l) => !set.has(l.light));
  chain.links.splice(index ?? chain.links.length, 0, ...ids.map((light) => ({ light })));
}

export function unchainLights(d: RigDocument, lightIds: Iterable<string>) {
  const set = new Set(lightIds);
  for (const c of d.chains) c.links = c.links.filter((l) => !set.has(l.light));
}

export function moveLink(d: RigDocument, chainId: string, from: number, to: number) {
  const chain = d.chains.find((c) => c.id === chainId);
  if (!chain || to < 0 || to >= chain.links.length) return;
  const [link] = chain.links.splice(from, 1);
  chain.links.splice(to, 0, link!);
}

export function reverseChain(d: RigDocument, chainId: string) {
  const chain = d.chains.find((c) => c.id === chainId);
  if (chain) chain.links.reverse();
}

/** Pin a link's address (manual override), or pass null to let it follow the chain again. */
export function setLinkStart(d: RigDocument, chainId: string, index: number, start: { universe: number; channel: number } | null) {
  const link = d.chains.find((c) => c.id === chainId)?.links[index];
  if (!link) return;
  if (start) link.start = { universe: start.universe, channel: start.channel };
  else delete link.start;
}

// ── Room ─────────────────────────────────────────────────────────────────────

export function updateRoom(d: RigDocument, patch: Partial<RigDocument["room"]>) {
  Object.assign(d.room, patch);
}
