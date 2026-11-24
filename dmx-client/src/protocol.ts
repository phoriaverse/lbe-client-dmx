// Wire messages this standalone lighting client consumes/emits. Compatible with the Bun server
// lifecycle; no runtime dependency on the former monorepo's absent bun-server directory.
// Source: phoriaverse/lbe-server-web f8073812 src/protocol.ts. Coordinate wire changes with it.
// Some servers do not evict duplicate lighting-client identities; USB's exclusive open is local.
export const CLIENT_TYPE = "lighting-client";
export type CloseSupersededCode = 4000;
export type CloseReason = "media" | "operator";

export interface ClientDiagnostics {
  clockSynced: boolean;
  offsetMs: number;
  rttMs: number;
  jitterMs: number;
  sampleAgeMs: number;
  serverNowEstimateMs: number;
  positionMs?: number;
}

export type ClientMessage =
  | { type: "identify"; role: "player"; name: string; clientType: typeof CLIENT_TYPE }
  | { type: "state"; state: string }
  | { type: "ready" }
  | { type: "timeSync"; t0: number }
  | { type: "diagnostics"; diag: ClientDiagnostics }
  | { type: "ack"; commandId: string };
export type OutboundMessage = ClientMessage;

export type ServerMessage =
  | { type: "timeSyncReply"; t0: number; tServer: number }
  | { type: "startExperience"; experience: string; mediaFile?: string }
  | { type: "beginPlayback"; startAt: number }
  | { type: "closeExperience"; reason: CloseReason }
  | { type: "command"; command: string; commandId: string }
  | { type: "welcome"; clientId: string };
