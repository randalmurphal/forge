import type { ForgeDaemonManifest } from "@forgetools/shared/daemon";
import { ServiceMap, type Effect } from "effect";

import type { DaemonServiceError, DaemonShutdownError, DaemonSocketError } from "../Errors.ts";

export interface DaemonPaths {
  readonly lockPath: string;
  readonly pidPath: string;
  readonly socketPath: string;
  readonly daemonInfoPath: string;
}

export type DaemonInfo = ForgeDaemonManifest;

export interface DaemonSocketBinding {
  readonly close: Effect.Effect<void, DaemonSocketError>;
}

export interface DaemonStartInput {
  readonly wsPort: number;
  readonly wsToken?: string;
  readonly startedAt?: string;
  readonly pingTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly bindSocket: (
    socketPath: string,
  ) => Effect.Effect<DaemonSocketBinding, DaemonSocketError>;
  readonly gracefulShutdown?: Effect.Effect<void, DaemonShutdownError>;
  readonly forceShutdown?: Effect.Effect<void, DaemonShutdownError>;
}

export interface DaemonStartResultStarted {
  readonly type: "started";
  readonly info: DaemonInfo;
  readonly paths: DaemonPaths;
  readonly stop: Effect.Effect<void, DaemonServiceError>;
}

export interface DaemonStartResultAlreadyRunning {
  readonly type: "already-running";
  readonly pid: number;
  readonly info: DaemonInfo | undefined;
  readonly paths: DaemonPaths;
}

export type DaemonStartResult = DaemonStartResultStarted | DaemonStartResultAlreadyRunning;

export interface DaemonServiceShape {
  readonly getPaths: Effect.Effect<DaemonPaths>;
  readonly probeSocket: (socketPath?: string, timeoutMs?: number) => Effect.Effect<boolean, never>;
  readonly start: (input: DaemonStartInput) => Effect.Effect<DaemonStartResult, DaemonServiceError>;
}

export class DaemonService extends ServiceMap.Service<DaemonService, DaemonServiceShape>()(
  "forge/daemon/Services/DaemonService",
) {}
