// Configuration: config.json (tracked defaults) ← config.local.json (on-site overrides) ← flags/env.
//
// config.local.json exists so that moving the master dimmer on the control page does not dirty a
// tracked file: the page writes there, and only there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARTNET_PORT, type ColourOrder, type Patch, simplePatch, validatePatch } from "./shared/patch";
import { DEFAULT_CONTROL_PORT } from "./shared/preview-protocol";
import { parseRig } from "../../dmx-editor/src/model/rig";
import { compileRigPatch, rigProblems } from "../../dmx-editor/src/model/patch";
import { enttecPatchProblems } from "./transport";

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
  output?: "artnet" | "enttec" | "preview";
  usbDevice?: string;
  usbUniverse?: number;
  /** Optional editor rig: one source of truth for addresses, patterns, preview and baking. */
  rigFile?: string;
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
  output: "artnet" | "enttec" | "preview";
  usbDevice?: string;
  usbUniverse: number;
  previewUsbUniverse?: number;
  standalone: boolean;
  localPath: string;
  /** The name in the console's roster. */
  name: string;
  /** Pinned control server "host:port", or undefined to discover it. */
  server: string | undefined;
  controlPort: number;
  showsDir: string;
  /** Output refresh rate. The ENTTEC Pro supports at most 40 Hz. */
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

// Finder launches the helper with the folder containing the .app as its working directory.
const resources = process.env.LBE_LIGHTING_RESOURCES;
const ROOT = resources ? process.cwd() : path.resolve(import.meta.dir, "..");
const CONFIG_PATH = resources ? path.join(resources, "config.pavotube.json") : path.join(ROOT, "config.json");
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
  const configPath = path.resolve(ROOT, flag("config") ?? process.env.LBE_LIGHTING_CONFIG ?? CONFIG_PATH);
  const localName = path.basename(configPath, ".json") + ".local.json";
  const localPath = resources && configPath === CONFIG_PATH
    ? path.join(os.homedir(), "Library", "Application Support", "SoundSpace DMX", localName)
    : path.join(path.dirname(configPath), localName);
  if (!fs.existsSync(configPath)) throw new Error(`Configuration not found: ${configPath}`);
  const file = { ...readJson(configPath), ...readJson(localPath) };
  const kind = flag("output") ?? process.env.LBE_LIGHTING_OUTPUT ?? file.output ?? "artnet";
  if (kind !== "artnet" && kind !== "enttec" && kind !== "preview") throw new Error(`Unknown output "${kind}"; choose artnet, enttec or preview`);
  const usbUniverse = num(file.usbUniverse) ?? 0;
  if (!Number.isInteger(usbUniverse) || usbUniverse < 0 || usbUniverse > 32767) throw new Error("usbUniverse must be a whole number from 0 to 32767");

  let rig = file.rig;
  // --gateway host[:port] repoints the default rig — at the simulated gateway, typically.
  const gateway = flag("gateway") ?? process.env.LBE_LIGHTING_GATEWAY;
  if (gateway && rig) {
    const [host, port] = gateway.split(":");
    rig = { ...rig, host: host!, port: num(port) ?? ARTNET_PORT };
  }

  let pixelsPerFixture = rig?.pixelsPerFixture ?? 32;
  let patch = file.patch ?? (rig ? simplePatch(rig) : null);
  if (file.rigFile) {
    const doc = parseRig(fs.readFileSync(path.resolve(path.dirname(configPath), file.rigFile), "utf8"));
    const problems = rigProblems(doc);
    if (problems.length) throw new Error(`Editor rig is invalid: ${problems.join("; ")}`);
    patch = compileRigPatch(doc);
    pixelsPerFixture = doc.profiles[0]?.pixels ?? pixelsPerFixture;
  }
  if (patch) {
    const problems = validatePatch(patch);
    if (problems.length) throw new Error(`config patch is invalid: ${problems.join("; ")}`);
    if (kind === "enttec" || (kind === "preview" && file.output === "enttec")) {
      const usbProblems = enttecPatchProblems(patch, usbUniverse);
      if (usbProblems.length) throw new Error(usbProblems.join("; "));
    }
  }

  const outputFps = num(file.outputFps) ?? 40;
  if (!Number.isInteger(outputFps) || outputFps < 1 || outputFps > (kind === "enttec" ? 40 : 120)) {
    throw new Error(`outputFps must be a whole number from 1 to ${kind === "enttec" ? 40 : 120}`);
  }

  return {
    output: kind,
    usbDevice: flag("usb-device") ?? process.env.LBE_LIGHTING_USB_DEVICE ?? file.usbDevice,
    usbUniverse,
    previewUsbUniverse: file.output === "enttec" ? usbUniverse : undefined,
    standalone: process.argv.includes("--standalone"),
    localPath,
    name: flag("name") ?? process.env.LBE_LIGHTING_NAME ?? file.name ?? os.hostname().replace(/\.local$/, ""),
    server: flag("server") ?? process.env.LBE_SERVER ?? file.server,
    controlPort: num(flag("port"), process.env.LBE_LIGHTING_PORT, file.controlPort) ?? DEFAULT_CONTROL_PORT,
    showsDir: path.resolve(ROOT, flag("shows") ?? process.env.LBE_LIGHTING_MEDIA_DIR ?? process.env.LBE_LIGHTING_SHOWS_DIR ?? file.showsDir ?? "media"),
    outputFps,
    outputLatencyMs: num(file.outputLatencyMs) ?? 0,
    master: clamp01(num(file.master) ?? 1),
    cap: clamp01(num(file.cap) ?? 1),
    sequenced: file.sequenced ?? false,
    sourcePort: num(flag("source-port"), process.env.LBE_LIGHTING_SOURCE_PORT) ?? ARTNET_PORT,
    patch,
    pixelsPerFixture,
  };
}

/** Persist an on-site override (the master dimmer) without touching the tracked config.json. */
export function saveLocal(overrides: Pick<ConfigFile, "master">, localPath = LOCAL_PATH) {
  const next = { ...readJson(localPath), ...overrides };
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, `${JSON.stringify(next, null, 2)}\n`);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
