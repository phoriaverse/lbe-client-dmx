// Editor ⇄ client: live preview.
//
// Only the client ever sends Art-Net (see artnet.ts — the source port is the lock). So when the
// editor wants the real fixtures to follow its playhead, it does not talk to the gateway; it
// streams frames to a running client over this WebSocket (path /preview on the client's control
// port), and the client outputs them through the same path a baked show takes.
//
// The client decides who owns the fixtures, and a live LBE session always wins: while one is
// running, preview frames are accepted and dropped, and `status.owner` says so.
//
//   editor → client   text    PreviewHello            once, and again whenever the patch changes
//   editor → client   binary  one frame               pixelCount × 3 samples (R G B), 8-bit, or
//                                                     16-bit little-endian if hello.bits is 16;
//                                                     same encoding as a .show frame
//   editor → client   text    PreviewCommand
//   client → editor   text    PreviewStatus           on connect and whenever it changes
//   client → editor   text    PreviewPollResult       answer to {type:"poll"}
//
// A stream that stops is a stream that ended: with no frame for PREVIEW_STALE_MS the client goes
// back to its idle look. The editor therefore re-sends the current frame while live output is on,
// even when nothing is moving.

import type { Patch } from "./patch";

export const PREVIEW_PATH = "/preview";
export const PREVIEW_STALE_MS = 1000;
export const DEFAULT_CONTROL_PORT = 8091;

export interface PreviewHello {
  type: "hello";
  app: string;
  bits: 8 | 16;
  /** Encoding exponent of the frames; a .show's `transfer`. */
  transfer: number;
  patch: Patch;
}

export type PreviewCommand =
  /** Stop previewing now, without waiting for the stream to go stale. */
  | { type: "release" }
  /** Ask the client to ArtPoll the fixture network (it holds the only socket that can). */
  | { type: "poll" };

export type PreviewMessage = PreviewHello | PreviewCommand;

/** Who is driving the fixtures right now. */
export type OutputOwner = "blackout" | "session" | "pattern" | "preview" | "ambient" | "idle";

export interface PreviewStatus {
  type: "status";
  owner: OutputOwner;
  /** The LBE session in progress, if any — the reason preview is being ignored. */
  session: { experience: string; phase: string } | null;
  /** Set when the last hello or frame was rejected, with why. */
  problem: string | null;
  master: number;
  cap: number;
  output?: { kind: "artnet" | "enttec" | "preview"; label: string; connected: boolean; error: string | null };
}

export interface PreviewPollResult {
  type: "pollResult";
  nodes: { ip: string; shortName: string; longName: string; ports: number; universes: number[] }[];
}

export type PreviewReply = PreviewStatus | PreviewPollResult;
