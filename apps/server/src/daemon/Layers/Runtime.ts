import { Effect, Deferred } from "effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { ServerConfig } from "../../config.ts";
import { NotificationDispatch } from "../Services/NotificationDispatch.ts";
import { DaemonService } from "../Services/DaemonService.ts";
import { SocketTransport } from "../Services/SocketTransport.ts";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const runDaemonModeServer = <A, E, R>(launchHttpServer: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const daemonService = yield* DaemonService;
    const socketTransport = yield* SocketTransport;

    // Materialize the notification service so daemon mode includes the runtime dependency.
    yield* NotificationDispatch;

    const shutdownRequested = yield* Deferred.make<void>();
    const startedAt = new Date().toISOString();
    const startResult = yield* daemonService.start({
      wsPort: config.port,
      startedAt,
      bindSocket: (socketPath) =>
        socketTransport.bind({
          socketPath,
          startedAt,
          stopDaemon: Deferred.succeed(shutdownRequested, undefined).pipe(Effect.asVoid),
        }),
      gracefulShutdown: Effect.void,
      forceShutdown: Effect.void,
    });

    if (startResult.type === "already-running") {
      yield* Effect.logInfo("forge daemon already running; skipping duplicate launch", {
        pid: startResult.info.pid,
        socketPath: startResult.paths.socketPath,
      });
      return "already-running" as const;
    }

    yield* Effect.addFinalizer(() =>
      startResult.stop.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to stop daemon during server shutdown", {
            socketPath: startResult.paths.socketPath,
            cause: toError(cause),
          }),
        ),
      ),
    );

    const serverFiber = yield* Effect.forkScoped(launchHttpServer);
    const outcome = yield* Effect.raceFirst(
      Deferred.await(shutdownRequested).pipe(Effect.as({ type: "shutdown-requested" as const })),
      Fiber.await(serverFiber).pipe(Effect.map((exit) => ({ type: "server-exit" as const, exit }))),
    );

    if (outcome.type === "shutdown-requested") {
      yield* Fiber.interrupt(serverFiber);
      return "stopped" as const;
    }

    if (Exit.isFailure(outcome.exit)) {
      return yield* Effect.failCause(outcome.exit.cause);
    }

    return "server-exited" as const;
  });
