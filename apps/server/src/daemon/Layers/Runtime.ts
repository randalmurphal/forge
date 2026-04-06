import { Effect, Deferred } from "effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { ServerConfig } from "../../config.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { NotificationDispatch } from "../Services/NotificationDispatch.ts";
import { NotificationReactor } from "../Services/NotificationReactor.ts";
import { DaemonService } from "../Services/DaemonService.ts";
import { SocketTransport } from "../Services/SocketTransport.ts";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const runDaemonModeServer = <A, E, R>(launchHttpServer: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const daemonService = yield* DaemonService;
    const providerService = yield* ProviderService;
    const socketTransport = yield* SocketTransport;
    const startup = yield* ServerRuntimeStartup;
    const notificationReactor = yield* NotificationReactor;

    // Materialize the notification service so daemon mode includes the runtime dependency.
    yield* NotificationDispatch;

    const gracefulShutdown = Effect.gen(function* () {
      const activeSessions = yield* providerService.listSessions();
      if (activeSessions.length > 0) {
        yield* Effect.logInfo("stopping active provider sessions before daemon shutdown", {
          sessionCount: activeSessions.length,
        });
      }
      yield* Effect.forEach(
        activeSessions,
        (session) =>
          providerService.stopSession({ threadId: session.threadId }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to stop provider session during daemon shutdown", {
                threadId: session.threadId,
                cause: toError(cause),
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
      yield* notificationReactor.drain;
    });

    const shutdownRequested = yield* Deferred.make<void>();
    const startedAt = new Date().toISOString();
    const startResult = yield* daemonService.start({
      wsPort: config.port,
      ...(config.authToken === undefined ? {} : { wsToken: config.authToken }),
      startedAt,
      bindSocket: (socketPath) =>
        socketTransport.bind({
          socketPath,
          startedAt,
          awaitReady: startup.awaitHttpListening.pipe(Effect.mapError(toError)),
          stopDaemon: Deferred.succeed(shutdownRequested, undefined).pipe(Effect.asVoid),
        }),
      gracefulShutdown,
      forceShutdown: Effect.void,
    });

    if (startResult.type === "already-running") {
      yield* Effect.logInfo("forge daemon already running; skipping duplicate launch", {
        pid: startResult.pid,
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

    yield* notificationReactor.start();

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
