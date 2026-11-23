// The show library: the .show files on this machine, and which experience each answers to.
//
// The control server only ever NAMES an experience. Like a screen resolving a video on its own
// disk, we resolve that name against the headers of the files in shows/ — a baked show never
// crosses the LAN at showtime. The directory is re-read whenever it matters (each start, and
// periodically while idle), so dropping in a fresh bake needs no restart.

import fs from "node:fs";
import path from "node:path";
import { validatePatch } from "./shared/patch";
import { AMBIENT_EXPERIENCE, type ParsedShow, SHOW_EXTENSION, parseShow, showHeaderSpan, slugOf } from "./shared/show-file";

export interface ShowEntry {
  file: string;
  path: string;
  size: number;
  mtimeMs: number;
  show: ParsedShow;
}

export interface LoadedShow extends ShowEntry {
  /** The whole file, memory-mapped: frames page in as they are played, nothing is read up front. */
  bytes: Uint8Array;
}

export interface ShowProblem {
  file: string;
  problem: string;
}

function readHeader(filePath: string, size: number): ParsedShow {
  const fd = fs.openSync(filePath, "r");
  try {
    const first = new Uint8Array(12);
    if (fs.readSync(fd, first, 0, 12, 0) < 12) throw new Error("file is too short to be a show");
    const span = showHeaderSpan(first);
    if (span > 16 * 1024 * 1024) throw new Error("show header is implausibly large");
    const head = new Uint8Array(span);
    fs.readSync(fd, head, 0, span, 0);
    const parsed = parseShow(head, size);
    const patchProblems = validatePatch(parsed.header.patch);
    if (patchProblems.length) throw new Error(`patch: ${patchProblems[0]}`);
    return parsed;
  } finally {
    fs.closeSync(fd);
  }
}

export class ShowLibrary {
  shows: ShowEntry[] = [];
  problems: ShowProblem[] = [];
  private signature: string | null = null; // null: never scanned, so the first scan always reports

  constructor(readonly dir: string) {}

  /** Re-read the directory. Returns true if anything changed since the last scan. */
  scan(): boolean {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(SHOW_EXTENSION)).sort();
    } catch {
      // No shows directory is not an error — it is an unconfigured client, and it stays dark.
    }

    const stats = names.map((file) => {
      const p = path.join(this.dir, file);
      const st = fs.statSync(p, { throwIfNoEntry: false });
      return { file, path: p, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 };
    });
    const signature = stats.map((s) => `${s.file}:${s.size}:${s.mtimeMs}`).join("|");
    if (signature === this.signature) return false;
    this.signature = signature;

    const shows: ShowEntry[] = [];
    const problems: ShowProblem[] = [];
    for (const s of stats) {
      try {
        shows.push({ ...s, show: readHeader(s.path, s.size) });
      } catch (err) {
        problems.push({ file: s.file, problem: err instanceof Error ? err.message : String(err) });
      }
    }

    // Two shows claiming one experience is ambiguous, and silently picking one is how the wrong
    // look ends up on the wall. Newest bake wins — and it is said out loud.
    const byExperience = new Map<string, ShowEntry>();
    for (const entry of shows) {
      const key = slugOf(entry.show.header.experience);
      const existing = byExperience.get(key);
      if (!existing) {
        byExperience.set(key, entry);
        continue;
      }
      const [winner, loser] = entry.mtimeMs > existing.mtimeMs ? [entry, existing] : [existing, entry];
      byExperience.set(key, winner);
      problems.push({ file: loser.file, problem: `also answers to "${loser.show.header.experience}" — ${winner.file} is newer and wins` });
    }

    this.shows = shows;
    this.problems = problems;
    for (const p of problems) console.warn(`[shows] ${p.file}: ${p.problem}`);
    console.log(
      shows.length
        ? `[shows] ${shows.map((s) => `${s.file} → "${s.show.header.experience}"`).join(", ")}`
        : `[shows] no ${SHOW_EXTENSION} files in ${this.dir}`,
    );
    return true;
  }

  /**
   * The show for an experience name. Exact match first; then a forgiving slug match, so
   * "Second Nature", "second nature" and "second-nature" are one experience. Newest wins a tie.
   */
  find(experience: string): ShowEntry | null {
    const newestFirst = [...this.shows].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const slug = slugOf(experience);
    return (
      newestFirst.find((s) => s.show.header.experience === experience) ??
      newestFirst.find((s) => slugOf(s.show.header.experience) === slug) ??
      null
    );
  }

  /** The idle loop, if one has been baked. */
  ambient(): ShowEntry | null {
    return this.find(AMBIENT_EXPERIENCE);
  }

  load(entry: ShowEntry): LoadedShow {
    let bytes: Uint8Array;
    try {
      bytes = Bun.mmap(entry.path, { shared: false });
    } catch {
      bytes = new Uint8Array(fs.readFileSync(entry.path)); // mmap unavailable: read it all instead
    }
    // Re-parse against what was actually mapped, in case the file was replaced since the scan.
    const show = parseShow(bytes, bytes.length);
    return { ...entry, show, bytes };
  }
}
