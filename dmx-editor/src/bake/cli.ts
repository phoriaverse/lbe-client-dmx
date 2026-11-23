// `bun run bake` — bake a sequence to a .show without opening the editor.
//
//   bun run bake                          # the only sequence in project/sequences/
//   bun run bake -- second-nature         # by id
//   bun run bake -- second-nature --shows /Volumes/Show/shows --rig project/rig.json
//
// It reads what is SAVED: the rig file and the sequence file, exactly as the editor's Bake button does.

import fs from "node:fs";
import path from "node:path";
import { parseRig } from "../model/rig";
import { parseSequence } from "../model/sequence";
import { bake } from "./bake";

const ROOT = path.resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const rigPath = path.resolve(ROOT, flag("rig") ?? "project/rig.json");
const sequencesDir = path.join(path.dirname(rigPath), "sequences");
const ids = fs.existsSync(sequencesDir) ? fs.readdirSync(sequencesDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
const id = positional[0] ?? (ids.length === 1 ? ids[0] : undefined);
if (!id || !ids.includes(id)) {
  console.error(ids.length ? `Which sequence? ${ids.join(", ")}` : `No sequences in ${path.relative(process.cwd(), sequencesDir)}/ — make one in the editor and save it.`);
  process.exit(1);
}

try {
  const rig = parseRig(fs.readFileSync(rigPath, "utf8"));
  const sequence = parseSequence(fs.readFileSync(path.join(sequencesDir, `${id}.json`), "utf8"));
  const showsDir = flag("shows");
  let last = -1;
  const result = await bake({
    rig,
    sequence,
    ...(showsDir ? { showsDir: path.resolve(showsDir) } : {}),
    onProgress: (done, total) => {
      const pct = Math.floor((done / total) * 100);
      if (pct !== last) process.stdout.write(`\rbaking "${sequence.name}" ${pct}%`);
      last = pct;
    },
  });
  process.stdout.write("\r");
  console.log(
    `wrote ${path.relative(process.cwd(), result.file)} — "${result.experience}", ${(result.durationMs / 1000).toFixed(2)}s, ${result.frameCount} frames @ ${result.fps}fps ${result.bits}-bit, ${result.pixelCount} px, ${(result.sizeBytes / 1e6).toFixed(1)} MB, in ${(result.tookMs / 1000).toFixed(1)}s`,
  );
  for (const w of result.warnings) console.warn(`warning: ${w}`);
} catch (err) {
  process.stdout.write("\n");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
