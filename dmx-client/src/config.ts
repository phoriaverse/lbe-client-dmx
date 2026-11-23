// Configuration: config.json (tracked defaults) ← config.local.json (on-site overrides) ← flags/env.
//
// config.local.json exists so that moving the master dimmer on the control page does not dirty a
// tracked file: the page writes there, and only there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARTNET_PORT, type ColourOrder, type Patch, simplePatch, validatePatch } from "./shared/patch";
import { DEFAULT_CONTROL_PORT } from "./shared/preview-protocol";

/** The whole rig as one chain of identical fixtures — enough for the bench and for test patterns. */
export interface RigShorthand {
  host: string;
  port?: number;
  fixtures: number;
  pixelsPerFixture: number;
  order?: ColourOrder;
  gamma?: number;
  universe?: number;
}

interface ConfigFile {
  name?: string;
  server?: string;
  controlPort?: number;
  showsDir?: string;
  outputFps?: number;
  outputLatencyMs?: number;
  master?: number;
  cap?: number;
  sequenced?: boolean;
  rig?: RigShorthand;
  patch?: Patch;
}

export interface Config {
  /** The name in the console's roster. */
  name: string;
  /** Pinned control server "host:port", or undefined to discover it. */
  server: string | undefined;
  controlPort: number;
  showsDir: string;
  /** Art-Net refresh rate. DMX tops out near 44Hz; 40 is the conventional pixel rate. */
  outputFps: number;
  /**
   * How far ahead of the clock to read the show, in ms — the fixed delay between sending a frame
   * and light leaving the fixture. A late light needs the FUTURE frame, so this is added.
   */
  outputLatencyMs: number;
  master: number;
  cap: number;
  sequenced: boolean;
  /** UDP source port. 6454 for real hardware (the CL-104PS drops anything else). */
  sourcePort: number;
  /** The patch used for test patterns and idle blackout when no show or editor supplies one. */
  patch: Patch | null;
  pixelsPerFixture: number;
}

const ROOT = path.resolve(import.meta.dir, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const LOCAL_PATH = path.join(ROOT, "config.local.json");

function readJson(file: string): ConfigFile {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const num = (...candidates: (string | number | undefined)[]): number | undefined => {
  for (const c of candidates) {
    if (c === undefined || c === "") continue;
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

export function loadConfig(): Config {
  const file = { ...readJson(CONFIG_PATH), ...readJson(LOCAL_PATH) };

  let rig = file.rig;
  // --gateway host[:port] repoints the default rig — at the simulated gateway, typically.
  const gateway = flag("gateway") ?? process.env.LBE_LIGHTING_GATEWAY;
  if (gateway && rig) {
    const [host, port] = gateway.split(":");
    rig = { ...rig, host: host!, port: num(port) ?? ARTNET_PORT };
  }

  const patch = file.patch ?? (rig ? simplePatch(rig) : null);
  if (patch) {
    const problems = validatePatch(patch);
    if (problems.length) throw new Error(`config patch is invalid: ${problems.join("; ")}`);
  }

  return {
    name: flag("name") ?? process.env.LBE_LIGHTING_NAME ?? file.name ?? os.hostname().replace(/\.local$/, ""),
    server: flag("server") ?? process.env.LBE_SERVER ?? file.server,
    controlPort: num(flag("port"), process.env.LBE_LIGHTING_PORT, file.controlPort) ?? DEFAULT_CONTROL_PORT,
    showsDir: path.resolve(ROOT, flag("shows") ?? process.env.LBE_LIGHTING_SHOWS_DIR ?? file.showsDir ?? "shows"),
    outputFps: Math.min(120, Math.max(1, num(file.outputFps) ?? 40)),
    outputLatencyMs: num(file.outputLatencyMs) ?? 0,
    master: clamp01(num(file.master) ?? 1),
    cap: clamp01(num(file.cap) ?? 1),
    sequenced: file.sequenced ?? false,
    sourcePort: num(flag("source-port"), process.env.LBE_LIGHTING_SOURCE_PORT) ?? ARTNET_PORT,
    patch,
    pixelsPerFixture: rig?.pixelsPerFixture ?? 32,
  };
}

/** Persist an on-site override (the master dimmer) without touching the tracked config.json. */
export function saveLocal(overrides: Pick<ConfigFile, "master">) {
  const next = { ...readJson(LOCAL_PATH), ...overrides };
  fs.writeFileSync(LOCAL_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
