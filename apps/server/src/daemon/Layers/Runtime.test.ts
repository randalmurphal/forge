import { describe, expect, it, vi } from "vitest";
import { Deferred, Effect, Layer } from "effect";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { runDaemonModeServer } from "./Runtime.ts";
import { DaemonService } from "../Services/DaemonService.ts";
import { SocketTransport } from "../Services/SocketTransport.ts";
import { NotificationDispatch } from "../Services/NotificationDispatch.ts";
import { NotificationReactor } from "../Services/NotificationReactor.ts";

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
  stateDir: "/tmp/forge-daemon-runtime/userdata",
  dbPath: "/tmp/forge-daemon-runtime/userdata/state.sqlite",
  keybindingsConfigPath: "/tmp/forge-daemon-runtime/userdata/keybindings.json",
  settingsPath: "/tmp/forge-daemon-runtime/userdata/settings.json",
  worktreesDir: "/tmp/forge-daemon-runtime/worktrees",
  attachmentsDir: "/tmp/forge-daemon-runtime/userdata/attachments",
  logsDir: "/tmp/forge-daemon-runtime/userdata/logs",
  serverLogPath: "/tmp/forge-daemon-runtime/userdata/logs/server.log",
  serverTracePath: "/tmp/forge-daemon-runtime/userdata/logs/server.trace.ndjson",
  providerLogsDir: "/tmp/forge-daemon-runtime/userdata/logs/provider",
  providerEventLogPath: "/tmp/forge-daemon-runtime/userdata/logs/provider/events.log",
  terminalLogsDir: "/tmp/forge-daemon-runtime/userdata/logs/terminals",
  anonymousIdPath: "/tmp/forge-daemon-runtime/userdata/anonymous-id",
  staticDir: undefined,
  devUrl: undefined,
  noBrowser: true,
  authToken: "token",
  autoBootstrapProjectFromCwd: false,
  logWebSocketEvents: false,
});

describe("runDaemonModeServer", () => {
  it("binds the daemon socket and stops the server when daemon.stop is requested", async () => {
    let stopDaemon: Effect.Effect<void, Error> | undefined;
    const stop = vi.fn();
    const startNotifications = vi.fn();
    const launchStarted = Effect.runSync(Deferred.make<void>());
    const launchStopped = Effect.runSync(Deferred.make<void>());

    const daemonEffect = Effect.scoped(
      runDaemonModeServer(
        Effect.gen(function* () {
          yield* Deferred.succeed(launchStarted, undefined);
          return yield* Effect.never.pipe(
            Effect.ensuring(Deferred.succeed(launchStopped, undefined).pipe(Effect.asVoid)),
          );
        }),
      ).pipe(
        Effect.provide(
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
              start: (input) =>
                Effect.gen(function* () {
                  yield* input.bindSocket("/tmp/forge-daemon-runtime/forge.sock");
                  return {
                    type: "started" as const,
                    info: {
                      pid: 123,
                      wsPort: 4777,
                      wsToken: "token",
                      socketPath: "/tmp/forge-daemon-runtime/forge.sock",
                      startedAt: "2026-04-06T00:00:00.000Z",
                    },
                    paths: {
                      lockPath: "/tmp/forge-daemon-runtime/forge.lock",
                      pidPath: "/tmp/forge-daemon-runtime/forge.pid",
                      socketPath: "/tmp/forge-daemon-runtime/forge.sock",
                      daemonInfoPath: "/tmp/forge-daemon-runtime/daemon.json",
                    },
                    stop: Effect.sync(() => {
                      stop();
                    }),
                  };
                }),
            }),
            Layer.succeed(SocketTransport, {
              bind: (input) =>
                Effect.sync(() => {
                  stopDaemon = input.stopDaemon;
                  return { close: Effect.void };
                }),
            }),
            Layer.succeed(NotificationDispatch, {
              getPreferences: Effect.succeed({
                sessionNeedsAttention: true,
                sessionCompleted: true,
                deliberationConcluded: true,
              }),
              dispatch: () =>
                Effect.succeed({
                  status: "skipped" as const,
                  reason: "backend-unavailable" as const,
                }),
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
    );

    const daemonPromise = Effect.runPromise(daemonEffect);
    await Effect.runPromise(Deferred.await(launchStarted));
    await Effect.runPromise(stopDaemon ?? Effect.fail(new Error("missing stopDaemon")));

    await expect(daemonPromise).resolves.toBe("stopped");
    await Effect.runPromise(Deferred.await(launchStopped));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(startNotifications).toHaveBeenCalledTimes(1);
  });

  it("returns already-running without launching a duplicate server", async () => {
    const launchServer = vi.fn();
    const startNotifications = vi.fn();

    const result = await Effect.runPromise(
      Effect.scoped(
        runDaemonModeServer(
          Effect.sync(() => {
            launchServer();
          }),
        ).pipe(
          Effect.provide(
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
                    info: {
                      pid: 123,
                      wsPort: 4777,
                      wsToken: "token",
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
              Layer.succeed(SocketTransport, {
                bind: () => Effect.die("should not bind a duplicate daemon socket"),
              }),
              Layer.succeed(NotificationDispatch, {
                getPreferences: Effect.succeed({
                  sessionNeedsAttention: true,
                  sessionCompleted: true,
                  deliberationConcluded: true,
                }),
                dispatch: () =>
                  Effect.succeed({
                    status: "skipped" as const,
                    reason: "backend-unavailable" as const,
                  }),
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
    );

    expect(result).toBe("already-running");
    expect(launchServer).not.toHaveBeenCalled();
    expect(startNotifications).not.toHaveBeenCalled();
  });
});
