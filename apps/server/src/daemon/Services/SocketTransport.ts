import { ServiceMap, type Effect } from "effect";

import type { DaemonSocketError } from "../Errors.ts";
import type { DaemonSocketBinding } from "./DaemonService.ts";

export interface SocketTransportBindInput {
  readonly socketPath: string;
  readonly startedAt?: string;
  readonly awaitReady?: Effect.Effect<void, Error>;
  readonly stopDaemon?: Effect.Effect<void, Error>;
}

export interface SocketTransportShape {
  readonly bind: (
    input: SocketTransportBindInput,
  ) => Effect.Effect<DaemonSocketBinding, DaemonSocketError>;
}

export class SocketTransport extends ServiceMap.Service<SocketTransport, SocketTransportShape>()(
  "forge/daemon/Services/SocketTransport",
) {}
