// The LBE wire protocol, re-exported from the control server rather than copied — the same rule
// video-client follows. These are `export type` only, so the import is erased before anything runs:
// lighting-client still starts on a show Mac with bun-server/ absent. A protocol change breaks this
// project's typecheck, which is the point.

import type { ClientMessage, ClientType } from "../../../../server/web/src/protocol";

export type {
  JourneyVisit,
  ClientDiagnostics,
  ClientMessage,
  CloseReason,
  CloseSupersededCode,
  ServerMessage,
} from "../../../../server/web/src/protocol";

// What we declare ourselves as. "lighting-client" is in the server's SINGLE_INSTANCE_TYPES, so a
// reconnect evicts its own half-open ghost (which would otherwise hold the Ready barrier) and the
// loser of a duplicate is told so with CLOSE_SUPERSEDED — see session.ts.
export const CLIENT_TYPE = "lighting-client" satisfies ClientType;

/** Everything we send. */
export type OutboundMessage = ClientMessage;
