import { ServiceMap, type Effect, type Scope } from "effect";

import type { DaemonServiceError } from "../Errors.ts";

export interface DaemonRuntimeShape {
  readonly run: <A, E, R>(
    launchHttpServer: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    "already-running" | "stopped" | "server-exited",
    E | DaemonServiceError,
    R | Scope.Scope
  >;
}

export class DaemonRuntime extends ServiceMap.Service<DaemonRuntime, DaemonRuntimeShape>()(
  "forge/daemon/Services/DaemonRuntime",
) {}
