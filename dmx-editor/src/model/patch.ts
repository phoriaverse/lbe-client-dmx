// Rig → the client's Patch.
//
// RIG ORDER is the one order every frame uses: chains in list order, each chain's lights in wire
// order, then any light not on a chain (drawn and evaluated, never sent) in hierarchy order. A
// light's pixels occupy a contiguous span of the frame starting at its `first`.
//
// Because frame order follows wire order, a single chain compiles to exactly what chainRuns /
// simplePatch produce — the property test/patch.test.ts holds the editor to.

import {
  ARTNET_PORT,
  DMX_UNIVERSE_SIZE,
  endOfRun,
  type Gateway,
  type Patch,
  type PixelRun,
  validatePatch,
} from "../../../dmx-client/src/shared/patch";
import { type Chain, hierarchyOrder, isLight, profileById, type RigDocument, type RigNode } from "./rig";

export interface LightSpan {
  light: RigNode;
  /** Frame index of the light's pixel 0. */
  first: number;
  count: number;
  /** The chain carrying it, or null if unpatched. */
  chain: string | null;
}

/** Every light with its span of the frame, in rig order. Lights whose profile is missing are skipped. */
export function rigOrder(rig: RigDocument): LightSpan[] {
  const spans: LightSpan[] = [];
  const placed = new Set<string>();
  const lights = new Map(rig.nodes.filter(isLight).map((n) => [n.id, n]));
  let first = 0;
  const place = (light: RigNode, chain: string | null) => {
    const profile = light.light && profileById(rig, light.light.profile);
    if (!profile || placed.has(light.id)) return;
    placed.add(light.id);
    spans.push({ light, first, count: profile.pixels, chain });
    first += profile.pixels;
  };
  for (const chain of rig.chains) {
    for (const link of chain.links) {
      const light = lights.get(link.light);
      if (light) place(light, chain.id);
    }
  }
  for (const node of hierarchyOrder(rig)) if (isLight(node)) place(node, null);
  return spans;
}

export const pixelCountOf = (rig: RigDocument) => rigOrder(rig).reduce((n, s) => n + s.count, 0);

export interface ResolvedLink {
  light: string;
  universe: number;
  channel: number;
  /** True if this link's address is a manual override rather than following the chain. */
  pinned: boolean;
  /** Where the next fixture would go — for showing "ends at" in the patch panel. */
  end: { universe: number; channel: number };
}

/** Addresses for every link in a chain, following the chain-order rule with manual overrides. */
export function resolveChain(rig: RigDocument, chain: Chain): ResolvedLink[] {
  const out: ResolvedLink[] = [];
  let universe = chain.universe;
  let channel = chain.channel;
  for (const link of chain.links) {
    const node = rig.nodes.find((n) => n.id === link.light);
    const profile = node?.light && profileById(rig, node.light.profile);
    if (link.start) ({ universe, channel } = link.start);
    const end = profile ? endOfRun({ count: profile.pixels, universe, channel, order: profile.order }) : { universe, channel };
    out.push({ light: link.light, universe, channel, pinned: !!link.start, end });
    ({ universe, channel } = end);
  }
  return out;
}

/**
 * The patch the client plays. Gateways are emitted as {id, host, port?} only — their human names
 * stay in the rig — so a rig and lighting-client's config shorthand describing the same wiring
 * compile to byte-identical patches.
 */
export function compileRigPatch(rig: RigDocument): Patch {
  const spans = rigOrder(rig);
  const firstOf = new Map(spans.map((s) => [s.light.id, s.first]));
  const runs: PixelRun[] = [];
  for (const chain of rig.chains) {
    const resolved = resolveChain(rig, chain);
    chain.links.forEach((link, i) => {
      const node = rig.nodes.find((n) => n.id === link.light);
      const profile = node?.light && profileById(rig, node.light.profile);
      const first = firstOf.get(link.light);
      // A light listed twice (in two chains) is patched where it first appears; rigProblems says so.
      if (!profile || first === undefined || runs.some((r) => r.first === first)) return;
      const at = resolved[i]!;
      const run: PixelRun = { first, count: profile.pixels, gateway: chain.gateway, universe: at.universe, channel: at.channel, order: profile.order, gamma: profile.gamma };
      if (profile.gain) run.gain = [...profile.gain];
      runs.push(run);
    });
  }
  const gateways: Gateway[] = rig.gateways.map((g) => {
    const out: Gateway = { id: g.id, host: g.host };
    if (g.port !== undefined && g.port !== ARTNET_PORT) out.port = g.port;
    return out;
  });
  return { pixelCount: spans.reduce((n, s) => n + s.count, 0), gateways, runs };
}

/** Everything wrong with a rig that would make its output wrong or surprising. Empty = good to go. */
export function rigProblems(rig: RigDocument): string[] {
  const problems: string[] = [];
  const names = new Map(rig.nodes.map((n) => [n.id, n.name]));
  const seen = new Map<string, string>();
  for (const chain of rig.chains) {
    if (!rig.gateways.some((g) => g.id === chain.gateway)) problems.push(`${chain.name} is on a gateway that no longer exists`);
    if (chain.channel < 1 || chain.channel > DMX_UNIVERSE_SIZE) problems.push(`${chain.name} starts at channel ${chain.channel}`);
    for (const link of chain.links) {
      const name = names.get(link.light);
      if (!name) {
        problems.push(`${chain.name} lists a light that no longer exists`);
        continue;
      }
      const other = seen.get(link.light);
      if (other) problems.push(`${name} is on both ${other} and ${chain.name}`);
      else seen.set(link.light, chain.name);
    }
  }
  for (const n of rig.nodes) {
    if (n.light && !profileById(rig, n.light.profile)) problems.push(`${n.name} uses a fixture profile that no longer exists`);
  }
  // Then the client's own rules — overlapping channels, past the last universe, and so on.
  problems.push(...validatePatch(compileRigPatch(rig)));
  return problems;
}
