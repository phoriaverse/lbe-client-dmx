// The local media directory is rescanned on each visit, so deploying a cue only takes a file rename or copy.

import fs from "node:fs";
import path from "node:path";
import { validatePatch } from "./shared/patch";
import { AMBIENT_EXPERIENCE, type ParsedShow, SHOW_EXTENSION, parseShow, showHeaderSpan } from "./shared/show-file";

export interface ShowEntry {
  file: string;
  state: string;
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
      names = fs.readdirSync(this.dir).filter((n) => path.extname(n).toLowerCase() === SHOW_EXTENSION).sort();
    } catch {
      // No shows directory is not an error — it is an unconfigured client, and it stays dark.
    }

    const stats = names.map((file) => {
      const p = path.join(this.dir, file);
      const st = fs.statSync(p, { throwIfNoEntry: false });
      return { file, state: path.parse(file).name, path: p, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 };
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

    this.shows = shows;
    this.problems = problems;
    for (const p of problems) console.warn(`[shows] ${p.file}: ${p.problem}`);
    console.log(
      shows.length
        ? `[shows] ${shows.map((s) => s.file).join(", ")}`
        : `[shows] no ${SHOW_EXTENSION} files in ${this.dir}`,
    );
    return true;
  }

  /** Match the entire filename stem. Scan order breaks ties consistently with the audio and display clients. */
  find(state: string): ShowEntry | null {
    const stem = state.toLowerCase();
    return this.shows.find((entry) => entry.state.toLowerCase() === stem) ?? null;
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
