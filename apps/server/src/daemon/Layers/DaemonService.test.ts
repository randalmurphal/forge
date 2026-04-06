import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, expect } from "@effect/vitest";
import { Effect, Fiber, Layer, Ref } from "effect";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { ServerConfig } from "../../config.ts";
import { DaemonSocketError } from "../Errors.ts";
import { DaemonService } from "../Services/DaemonService.ts";
import { DaemonServiceLive } from "./DaemonService.ts";

const makeDaemonTestLayer = (baseDir: string) =>
  DaemonServiceLive.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );

const waitForSocketHandle = (server: Net.Server, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

const closeServer = (server: Net.Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const toSocketError = (socketPath: string, operation: string, cause: unknown): DaemonSocketError =>
  new DaemonSocketError({
    path: socketPath,
    operation,
    detail: `Test socket ${operation} failed.`,
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  });

const makePingServer = (socketPath: string) =>
  Effect.tryPromise({
    try: async () => {
      const server = Net.createServer((socket) => {
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk;
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) return;
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          const request = JSON.parse(line) as { readonly id?: string; readonly method?: string };
          if (request.method === "daemon.ping") {
            socket.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { status: "ok" } })}\n`,
            );
          }
        });
      });

      await waitForSocketHandle(server, socketPath);
      return {
        close: Effect.tryPromise({
          try: () => closeServer(server),
          catch: (cause) => toSocketError(socketPath, "close", cause),
        }),
      };
    },
    catch: (cause) => toSocketError(socketPath, "bind", cause),
  });

it.effect("start creates forge.pid, forge.sock, and daemon.json with owner-only permissions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-daemon-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => FS.rmSync(baseDir, { recursive: true, force: true })),
      );

      const result = yield* Effect.gen(function* () {
        const daemon = yield* DaemonService;
        return yield* daemon.start({
          wsPort: 47829,
          startedAt: "2026-04-06T18:00:00.000Z",
          bindSocket: (socketPath) => makePingServer(socketPath),
        });
      }).pipe(Effect.provide(makeDaemonTestLayer(baseDir)));

      if (result.type !== "started") {
        assert.fail("expected daemon start to win the singleton race");
      }
      assert.equal(result.info.pid, process.pid);
      assert.equal(result.info.wsPort, 47829);
      assert.equal(result.info.socketPath, Path.join(baseDir, "forge.sock"));

      const pidPath = Path.join(baseDir, "forge.pid");
      const infoPath = Path.join(baseDir, "daemon.json");
      const socketPath = Path.join(baseDir, "forge.sock");
      assert.equal(FS.readFileSync(pidPath, "utf8").trim(), String(process.pid));
      assert.equal(FS.existsSync(socketPath), true);

      const daemonInfo = JSON.parse(FS.readFileSync(infoPath, "utf8")) as {
        readonly pid: number;
        readonly wsPort: number;
        readonly socketPath: string;
        readonly startedAt: string;
        readonly wsToken: string;
      };
      assert.deepStrictEqual(
        {
          pid: daemonInfo.pid,
          wsPort: daemonInfo.wsPort,
          socketPath: daemonInfo.socketPath,
          startedAt: daemonInfo.startedAt,
        },
        {
          pid: process.pid,
          wsPort: 47829,
          socketPath,
          startedAt: "2026-04-06T18:00:00.000Z",
        },
      );
      expect(daemonInfo.wsToken).toHaveLength(64);
      assert.equal(FS.statSync(infoPath).mode & 0o777, 0o600);
      assert.equal(FS.statSync(socketPath).mode & 0o777, 0o600);

      yield* result.stop;
    }),
  ),
);

it.effect("start persists the configured websocket auth token to daemon.json", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-daemon-token-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => FS.rmSync(baseDir, { recursive: true, force: true })),
      );

      const result = yield* Effect.gen(function* () {
        const daemon = yield* DaemonService;
        return yield* daemon.start({
          wsPort: 47832,
          wsToken: "daemon-auth-token",
          bindSocket: (socketPath) => makePingServer(socketPath),
        });
      }).pipe(Effect.provide(makeDaemonTestLayer(baseDir)));

      if (result.type !== "started") {
        assert.fail("expected daemon start to win the singleton race");
      }

      const daemonInfo = JSON.parse(FS.readFileSync(Path.join(baseDir, "daemon.json"), "utf8")) as {
        readonly wsToken: string;
      };
      assert.equal(daemonInfo.wsToken, "daemon-auth-token");

      yield* result.stop;
    }),
  ),
);

it.effect("stop removes daemon state files and socket path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-daemon-stop-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => FS.rmSync(baseDir, { recursive: true, force: true })),
      );

      const result = yield* Effect.gen(function* () {
        const daemon = yield* DaemonService;
        return yield* daemon.start({
          wsPort: 47830,
          bindSocket: (socketPath) => makePingServer(socketPath),
        });
      }).pipe(Effect.provide(makeDaemonTestLayer(baseDir)));

      if (result.type !== "started") {
        assert.fail("expected daemon start to win the singleton race");
      }
      yield* result.stop;

      assert.equal(FS.existsSync(Path.join(baseDir, "forge.pid")), false);
      assert.equal(FS.existsSync(Path.join(baseDir, "daemon.json")), false);
      assert.equal(FS.existsSync(Path.join(baseDir, "forge.sock")), false);
    }),
  ),
);

it.effect(
  "start removes stale pid, stale socket, and stale daemon.json before starting fresh",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-daemon-stale-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => FS.rmSync(baseDir, { recursive: true, force: true })),
        );

        const staleSocketPath = Path.join(baseDir, "forge.sock");
        FS.mkdirSync(baseDir, { recursive: true });
        FS.writeFileSync(Path.join(baseDir, "forge.pid"), "999999\n");
        FS.writeFileSync(staleSocketPath, "stale-socket");
        FS.writeFileSync(
          Path.join(baseDir, "daemon.json"),
          `${JSON.stringify({
            pid: 999999,
            wsPort: 1,
            wsToken: "stale",
            socketPath: staleSocketPath,
            startedAt: "2026-04-05T00:00:00.000Z",
          })}\n`,
        );

        const result = yield* Effect.gen(function* () {
          const daemon = yield* DaemonService;
          return yield* daemon.start({
            wsPort: 47831,
            bindSocket: (socketPath) => makePingServer(socketPath),
          });
        }).pipe(Effect.provide(makeDaemonTestLayer(baseDir)));

        if (result.type !== "started") {
          assert.fail("expected stale daemon state to be replaced");
        }
        assert.equal(result.info.wsPort, 47831);
        assert.equal(FS.statSync(staleSocketPath).isSocket(), true);
        yield* result.stop;
      }),
    ),
);

it.effect("start reuses a responsive daemon even when daemon.json is missing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-daemon-manifest-missing-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => FS.rmSync(baseDir, { recursive: true, force: true })),
      );

      const bindCalls = yield* Ref.make(0);

      const startedResult = yield* Effect.gen(function* () {
        const daemon = yield* DaemonService;
        return yield* daemon.start({
          wsPort: 47832,
          bindSocket: (socketPath) => makePingServer(socketPath),
        });
      }).pipe(Effect.provide(makeDaemonTestLayer(baseDir)));

      if (startedResult.type !== "started") {
        assert.fail("expected initial daemon start to own the singleton");
      }

      FS.rmSync(Path.join(baseDir, "daemon.json"), { force: true });

      const secondResult = yield* Effect.gen(function* () {
        const daemon = yield* DaemonService;
        return yield* daemon.start({
          wsPort: 49999,
          bindSocket: (socketPath) =>
            Effect.gen(function* () {
              yield* Ref.update(bindCalls, (count) => count + 1);
              return yield* makePingServer(socketPath);
            }),
        });
      }).pipe(Effect.provide(makeDaemonTestLayer(baseDir)));

      if (secondResult.type !== "already-running") {
        assert.fail("expected duplicate start to reuse the responsive daemon");
      }
      assert.equal(secondResult.pid, process.pid);
      assert.equal(secondResult.info, undefined);
      assert.equal(yield* Ref.get(bindCalls), 0);

      yield* startedResult.stop;
    }),
  ),
);

it.effect("concurrent start serializes on the startup lock and reuses the winner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-daemon-concurrent-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => FS.rmSync(baseDir, { recursive: true, force: true })),
      );

      const bindCalls = yield* Ref.make(0);

      const bindSocket = (socketPath: string) =>
        Effect.gen(function* () {
          yield* Ref.update(bindCalls, (count) => count + 1);
          return yield* makePingServer(socketPath);
        });

      const firstStart = Effect.gen(function* () {
        const daemon = yield* DaemonService;
        return yield* daemon.start({
          wsPort: 47832,
          bindSocket,
        });
      }).pipe(Effect.provide(makeDaemonTestLayer(baseDir)));

      const secondStart = Effect.gen(function* () {
        const daemon = yield* DaemonService;
        return yield* daemon.start({
          wsPort: 47833,
          bindSocket,
        });
      }).pipe(Effect.provide(makeDaemonTestLayer(baseDir)));

      const firstFiber = yield* Effect.forkScoped(firstStart);
      const secondFiber = yield* Effect.forkScoped(secondStart);

      const firstResult = yield* Fiber.join(firstFiber);
      const secondResult = yield* Fiber.join(secondFiber);
      const startedResult = firstResult.type === "started" ? firstResult : secondResult;
      const alreadyRunningResult =
        firstResult.type === "already-running" ? firstResult : secondResult;

      if (startedResult.type !== "started") {
        assert.fail("expected one concurrent start to own the daemon");
      }
      if (alreadyRunningResult.type !== "already-running") {
        assert.fail("expected the second concurrent start to reuse the winner");
      }
      assert.equal(startedResult.type, "started");
      assert.equal(alreadyRunningResult.type, "already-running");
      assert.equal(alreadyRunningResult.info?.wsPort, startedResult.info.wsPort);
      assert.equal(alreadyRunningResult.pid, startedResult.info.pid);
      assert.equal(yield* Ref.get(bindCalls), 1);

      yield* startedResult.stop;
    }),
  ),
);
