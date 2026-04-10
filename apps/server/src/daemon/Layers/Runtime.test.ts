import { describe, expect, it, vi } from "vitest";
import { Deferred, Effect, Layer, Stream } from "effect";
import { ThreadId, type ProviderSession } from "@forgetools/contracts";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import type { DaemonServiceError } from "../Errors.ts";
import { DaemonService } from "../Services/DaemonService.ts";
import { DaemonRuntime } from "../Services/DaemonRuntime.ts";
import { SocketTransport } from "../Services/SocketTransport.ts";
import { NotificationReactor } from "../Services/NotificationReactor.ts";
import { DaemonRuntimeLive } from "./Runtime.ts";

const VALID_DAEMON_WS_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const makeServerConfig = (): ServerConfigShape => ({
  logLevel: "Info",
  traceMinLevel: "Info",
  traceTimingEnabled: true,
  traceBatchWindowMs: 200,
  traceMaxBytes: 10 * 1024 * 1024,
  traceMaxFiles: 10,
  otlpTracesUrl: undefined,
  otlpMetricsUrl: undefined,
  otlpExportIntervalMs: 10_000,
  otlpServiceName: "forge-server",
  mode: "daemon",
  port: 4777,
  host: "127.0.0.1",
  cwd: process.cwd(),
  baseDir: "/tmp/forge-daemon-runtime",
  stateDir: "/tmp/forge-daemon-runtime",
  dbPath: "/tmp/forge-daemon-runtime/forge.db",
  keybindingsConfigPath: "/tmp/forge-daemon-runtime/keybindings.json",
  settingsPath: "/tmp/forge-daemon-runtime/settings.json",
  worktreesDir: "/tmp/forge-daemon-runtime/worktrees",
  attachmentsDir: "/tmp/forge-daemon-runtime/attachments",
  artifactsDir: "/tmp/forge-daemon-runtime/artifacts",
  logsDir: "/tmp/forge-daemon-runtime/logs",
  serverLogPath: "/tmp/forge-daemon-runtime/logs/server.log",
  serverTracePath: "/tmp/forge-daemon-runtime/logs/server.trace.ndjson",
  providerLogsDir: "/tmp/forge-daemon-runtime/logs/sessions",
  providerEventLogPath: "/tmp/forge-daemon-runtime/logs/provider-events.log",
  terminalLogsDir: "/tmp/forge-daemon-runtime/logs/terminals",
  anonymousIdPath: "/tmp/forge-daemon-runtime/telemetry/anonymous-id",
  staticDir: undefined,
  devUrl: undefined,
  noBrowser: true,
  authToken: VALID_DAEMON_WS_TOKEN,
  autoBootstrapProjectFromCwd: false,
  logWebSocketEvents: false,
});

describe("DaemonRuntimeLive", () => {
  it("binds the daemon socket and stops the server when daemon.stop is requested", async () => {
    let stopDaemon: Effect.Effect<void, Error> | undefined;
    let requestedWsToken: string | undefined;
    let gracefulShutdown: Effect.Effect<void, DaemonServiceError> | undefined;
    const activeProviderSessions: ReadonlyArray<ProviderSession> = [
      {
        threadId: ThreadId.makeUnsafe("thread-1"),
        provider: "codex",
        runtimeMode: "full-access",
        model: "gpt-5-codex",
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T00:00:00.000Z",
        status: "running",
      },
    ];
    const stop = vi.fn();
    const stopSession = vi.fn(() => Effect.void);
    const listSessions = vi.fn(
      (): Effect.Effect<ReadonlyArray<ProviderSession>> => Effect.succeed(activeProviderSessions),
    );
    const startNotifications = vi.fn();
    const drainNotifications = vi.fn(() => Effect.void);
    const launchStarted = Effect.runSync(Deferred.make<void>());
    const launchStopped = Effect.runSync(Deferred.make<void>());

    const dependencies = Layer.mergeAll(
      Layer.succeed(ServerConfig, makeServerConfig()),
      Layer.succeed(ServerRuntimeStartup, {
        awaitCommandReady: Effect.void,
        awaitHttpListening: Effect.void,
        markHttpListening: Effect.void,
        enqueueCommand: (effect) => effect,
      }),
      Layer.succeed(DaemonService, {
        getPaths: Effect.die("unused"),
        probeSocket: () => Effect.succeed(true),
        start: (input) =>
          Effect.gen(function* () {
            requestedWsToken = input.wsToken;
            gracefulShutdown = input.gracefulShutdown;
            yield* input.bindSocket("/tmp/forge-daemon-runtime/forge.sock");
            return {
              type: "started" as const,
              info: {
                pid: 123,
                wsPort: 4777,
                wsToken: VALID_DAEMON_WS_TOKEN,
                socketPath: "/tmp/forge-daemon-runtime/forge.sock",
                startedAt: "2026-04-06T00:00:00.000Z",
              },
              paths: {
                lockPath: "/tmp/forge-daemon-runtime/forge.lock",
                pidPath: "/tmp/forge-daemon-runtime/forge.pid",
                socketPath: "/tmp/forge-daemon-runtime/forge.sock",
                daemonInfoPath: "/tmp/forge-daemon-runtime/daemon.json",
              },
              stop: Effect.gen(function* () {
                if (gracefulShutdown !== undefined) {
                  yield* gracefulShutdown;
                }
                stop();
              }),
            };
          }),
      }),
      Layer.succeed(ProviderService, {
        startSession: () => Effect.die("unused"),
        sendTurn: () => Effect.die("unused"),
        interruptTurn: () => Effect.die("unused"),
        respondToRequest: () => Effect.die("unused"),
        respondToUserInput: () => Effect.die("unused"),
        stopSession,
        listSessions,
        getCapabilities: () => Effect.die("unused"),
        rollbackConversation: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
        streamEvents: Stream.empty,
      }),
      Layer.succeed(SocketTransport, {
        bind: (input) =>
          Effect.sync(() => {
            stopDaemon = input.stopDaemon;
            return { close: Effect.void };
          }),
      }),
      Layer.succeed(NotificationReactor, {
        start: () =>
          Effect.sync(() => {
            startNotifications();
          }),
        drain: Effect.suspend(() => drainNotifications()),
      }),
    );
    const runtimeLayer = DaemonRuntimeLive.pipe(Layer.provide(dependencies));

    const daemonEffect = Effect.scoped(
      Effect.gen(function* () {
        const daemonRuntime = yield* DaemonRuntime;
        return yield* daemonRuntime.run(
          Effect.gen(function* () {
            yield* Deferred.succeed(launchStarted, undefined);
            return yield* Effect.never.pipe(
              Effect.ensuring(Deferred.succeed(launchStopped, undefined).pipe(Effect.asVoid)),
            );
          }),
        );
      }).pipe(Effect.provide(runtimeLayer)),
    );

    const daemonPromise = Effect.runPromise(daemonEffect);
    await Effect.runPromise(Deferred.await(launchStarted));
    await Effect.runPromise(stopDaemon ?? Effect.fail(new Error("missing stopDaemon")));

    await expect(daemonPromise).resolves.toBe("stopped");
    await Effect.runPromise(Deferred.await(launchStopped));
    expect(requestedWsToken).toBe(VALID_DAEMON_WS_TOKEN);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(drainNotifications).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(startNotifications).toHaveBeenCalledTimes(1);
  });

  it("returns already-running without launching a duplicate server", async () => {
    const launchServer = vi.fn();
    const startNotifications = vi.fn();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const daemonRuntime = yield* DaemonRuntime;
          return yield* daemonRuntime.run(
            Effect.sync(() => {
              launchServer();
            }),
          );
        }).pipe(
          Effect.provide(
            DaemonRuntimeLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ServerConfig, makeServerConfig()),
                  Layer.succeed(ServerRuntimeStartup, {
                    awaitCommandReady: Effect.void,
                    awaitHttpListening: Effect.void,
                    markHttpListening: Effect.void,
                    enqueueCommand: (effect) => effect,
                  }),
                  Layer.succeed(DaemonService, {
                    getPaths: Effect.die("unused"),
                    probeSocket: () => Effect.succeed(true),
                    start: () =>
                      Effect.succeed({
                        type: "already-running" as const,
                        pid: 123,
                        info: {
                          pid: 123,
                          wsPort: 4777,
                          wsToken: VALID_DAEMON_WS_TOKEN,
                          socketPath: "/tmp/forge-daemon-runtime/forge.sock",
                          startedAt: "2026-04-06T00:00:00.000Z",
                        },
                        paths: {
                          lockPath: "/tmp/forge-daemon-runtime/forge.lock",
                          pidPath: "/tmp/forge-daemon-runtime/forge.pid",
                          socketPath: "/tmp/forge-daemon-runtime/forge.sock",
                          daemonInfoPath: "/tmp/forge-daemon-runtime/daemon.json",
                        },
                      }),
                  }),
                  Layer.succeed(ProviderService, {
                    startSession: () => Effect.die("unused"),
                    sendTurn: () => Effect.die("unused"),
                    interruptTurn: () => Effect.die("unused"),
                    respondToRequest: () => Effect.die("unused"),
                    respondToUserInput: () => Effect.die("unused"),
                    stopSession: () => Effect.die("unused"),
                    listSessions: () => Effect.succeed([]),
                    getCapabilities: () => Effect.die("unused"),
                    rollbackConversation: () => Effect.die("unused"),
                    forkThread: () => Effect.die("unused"),
                    streamEvents: Stream.empty,
                  }),
                  Layer.succeed(SocketTransport, {
                    bind: () => Effect.die("should not bind a duplicate daemon socket"),
                  }),
                  Layer.succeed(NotificationReactor, {
                    start: () =>
                      Effect.sync(() => {
                        startNotifications();
                      }),
                    drain: Effect.void,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    expect(result).toBe("already-running");
    expect(launchServer).not.toHaveBeenCalled();
    expect(startNotifications).not.toHaveBeenCalled();
  });
});
