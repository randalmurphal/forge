import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as Net from "node:net";
import * as Path from "node:path";
import * as readline from "node:readline";

import { isTrustedDaemonManifest, parseDaemonManifest } from "@forgetools/shared/daemon";
import { Effect, Layer, Option, Ref } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  DaemonLockError,
  DaemonShutdownError,
  DaemonSocketError,
  DaemonStateFileError,
  type DaemonServiceError,
} from "../Errors.ts";
import {
  DaemonService,
  type DaemonPaths,
  type DaemonInfo,
  type DaemonSocketBinding,
  type DaemonStartInput,
  type DaemonStartResult,
} from "../Services/DaemonService.ts";

const DEFAULT_PING_TIMEOUT_MS = 1_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const LOCK_READY_LINE = "ready";
const LOCK_HELPER_READY_TIMEOUT_MS = 5_000;
const WEDGED_PROCESS_TERMINATE_TIMEOUT_MS = 2_000;
const PING_REQUEST_ID = "forge-daemon-ping";
const SOCKET_PERMISSIONS = 0o600;
const STATE_FILE_PERMISSIONS = 0o600;
const LOCK_READY_SCRIPT =
  'process.stdout.write("ready\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));';

interface LockHandle {
  readonly release: Effect.Effect<void, DaemonLockError>;
}

const makeDaemonPaths = (baseDir: string): DaemonPaths => ({
  lockPath: Path.join(baseDir, "forge.lock"),
  pidPath: Path.join(baseDir, "forge.pid"),
  socketPath: Path.join(baseDir, "forge.sock"),
  daemonInfoPath: Path.join(baseDir, "daemon.json"),
});

const toDefect = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const isDaemonLockError = (cause: unknown): cause is DaemonLockError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "DaemonLockError";

const makeStateFileError = (
  path: string,
  operation: string,
  detail: string,
  cause?: unknown,
): DaemonStateFileError =>
  new DaemonStateFileError({
    path,
    operation,
    detail,
    ...(cause !== undefined ? { cause: toDefect(cause) } : {}),
  });

const makeSocketError = (
  path: string,
  operation: string,
  detail: string,
  cause?: unknown,
): DaemonSocketError =>
  new DaemonSocketError({
    path,
    operation,
    detail,
    ...(cause !== undefined ? { cause: toDefect(cause) } : {}),
  });

const makeLockError = (path: string, detail: string, cause?: unknown): DaemonLockError =>
  new DaemonLockError({
    path,
    detail,
    ...(cause !== undefined ? { cause: toDefect(cause) } : {}),
  });

const writeFileWithPermissions = (
  path: string,
  contents: string,
  mode: number,
): Effect.Effect<void, DaemonStateFileError> =>
  Effect.tryPromise({
    try: async () => {
      await FSP.writeFile(path, contents, { encoding: "utf8", mode });
      await FSP.chmod(path, mode);
    },
    catch: (cause) => makeStateFileError(path, "write", "Failed to persist daemon state.", cause),
  });

const removeIfExists = (
  path: string,
  operation: string,
): Effect.Effect<void, DaemonStateFileError | DaemonSocketError> =>
  Effect.tryPromise({
    try: async () => {
      await FSP.rm(path, { force: true });
    },
    catch: (cause) =>
      operation === "remove-socket"
        ? makeSocketError(path, "cleanup", "Failed to remove stale socket path.", cause)
        : makeStateFileError(path, operation, "Failed to remove daemon state.", cause),
  });

const ensureParentDirectory = (path: string): Effect.Effect<void, DaemonStateFileError> =>
  Effect.tryPromise({
    try: () => FSP.mkdir(Path.dirname(path), { recursive: true }),
    catch: (cause) =>
      makeStateFileError(path, "mkdir", "Failed to create daemon state directory.", cause),
  });

const readFileStringOption = (path: string): Effect.Effect<string | undefined, never> =>
  Effect.tryPromise({
    try: () => FSP.readFile(path, "utf8"),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.void.pipe(Effect.as(undefined))));

const readPidFile = (path: string): Effect.Effect<number | undefined, never> =>
  readFileStringOption(path).pipe(
    Effect.map((raw) => {
      if (raw === undefined) return undefined;
      const parsed = Number.parseInt(raw.trim(), 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    }),
  );

const readDaemonInfo = (
  path: string,
  expectedSocketPath: string,
): Effect.Effect<DaemonInfo | undefined, never> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const [raw, stat] = await Promise.all([FSP.readFile(path, "utf8"), FSP.stat(path)]);
        const parsed = parseDaemonManifest(JSON.parse(raw));
        if (parsed === undefined) {
          return undefined;
        }
        return isTrustedDaemonManifest(parsed, stat.mode, {
          expectedSocketPath,
          requireOwnerOnlyPermissions: true,
        })
          ? parsed
          : undefined;
      } catch {
        return undefined;
      }
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.void.pipe(Effect.as(undefined))));

const isProcessAlive = (pid: number): Effect.Effect<boolean, never> =>
  Effect.sync(() => {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      return false;
    }
  });

const waitForProcessExit = (pid: number, timeoutMs: number): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(yield* isProcessAlive(pid))) {
        return true;
      }
      yield* Effect.sleep("50 millis");
    }
    return yield* isProcessAlive(pid).pipe(Effect.map((alive) => !alive));
  });

const terminateProcess = (pid: number): Effect.Effect<void, DaemonShutdownError> =>
  Effect.gen(function* () {
    if (pid === process.pid || !(yield* isProcessAlive(pid))) {
      return;
    }

    const signal = (name: NodeJS.Signals) =>
      Effect.sync(() => {
        try {
          process.kill(pid, name);
        } catch (cause) {
          const code =
            cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
          if (code !== "ESRCH") {
            throw cause;
          }
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DaemonShutdownError({
              detail: `Failed to signal wedged daemon process ${pid}.`,
              cause: toDefect(cause),
            }),
        ),
      );

    yield* signal("SIGTERM");
    const exited = yield* waitForProcessExit(pid, WEDGED_PROCESS_TERMINATE_TIMEOUT_MS);
    if (exited) return;

    yield* signal("SIGKILL");
    const killed = yield* waitForProcessExit(pid, WEDGED_PROCESS_TERMINATE_TIMEOUT_MS);
    if (!killed) {
      return yield* new DaemonShutdownError({
        detail: `Wedged daemon process ${pid} did not exit after SIGKILL.`,
      });
    }
  });

const cleanupDaemonArtifacts = (paths: DaemonPaths): Effect.Effect<void, DaemonServiceError> =>
  Effect.gen(function* () {
    yield* removeIfExists(paths.pidPath, "remove-pid");
    yield* removeIfExists(paths.daemonInfoPath, "remove-daemon-info");
    yield* removeIfExists(paths.socketPath, "remove-socket");
  });

const closeSocketBinding = (
  socketPath: string,
  binding: DaemonSocketBinding,
): Effect.Effect<void, DaemonSocketError> =>
  binding.close.pipe(
    Effect.mapError((cause) =>
      makeSocketError(socketPath, "close", "Failed to close daemon socket.", cause),
    ),
  );

const writeDaemonState = (
  paths: DaemonPaths,
  info: DaemonInfo,
): Effect.Effect<void, DaemonStateFileError> =>
  Effect.gen(function* () {
    yield* writeFileWithPermissions(paths.pidPath, `${info.pid}\n`, STATE_FILE_PERMISSIONS);
    yield* writeFileWithPermissions(
      paths.daemonInfoPath,
      `${JSON.stringify(info, null, 2)}\n`,
      STATE_FILE_PERMISSIONS,
    );
  });

const pingSocket = (
  socketPath: string,
  timeoutMs = DEFAULT_PING_TIMEOUT_MS,
): Effect.Effect<boolean, never> =>
  Effect.tryPromise({
    try: () =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        let timeout: NodeJS.Timeout | undefined;
        const socket = Net.createConnection(socketPath);
        const input = readline.createInterface({
          input: socket,
          crlfDelay: Infinity,
        });

        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          if (timeout !== undefined) {
            clearTimeout(timeout);
          }
          input.removeAllListeners();
          socket.removeAllListeners();
          input.close();
          socket.destroy();
          resolve(value);
        };

        timeout = setTimeout(() => finish(false), timeoutMs);

        socket.once("error", () => finish(false));
        socket.once("connect", () => {
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: PING_REQUEST_ID, method: "daemon.ping" })}\n`,
          );
        });

        input.once("line", (line) => {
          try {
            const parsed = JSON.parse(line) as {
              readonly id?: string;
              readonly result?: { readonly status?: string };
            };
            finish(parsed.id === PING_REQUEST_ID && parsed.result?.status === "ok");
          } catch {
            finish(false);
          }
        });
      }),
    catch: () => false,
  }).pipe(Effect.catch(() => Effect.succeed(false)));

const resolveLockCommand = (
  lockPath: string,
): Effect.Effect<
  { readonly command: string; readonly args: ReadonlyArray<string> },
  DaemonLockError
> =>
  Effect.try({
    try: () => {
      switch (process.platform) {
        case "darwin":
          return {
            command: "lockf",
            args: [lockPath, process.execPath, "-e", LOCK_READY_SCRIPT],
          } as const;
        case "linux":
          return {
            command: "flock",
            args: ["-x", lockPath, process.execPath, "-e", LOCK_READY_SCRIPT],
          } as const;
        default:
          throw makeLockError(lockPath, `Unsupported daemon lock platform '${process.platform}'.`);
      }
    },
    catch: (cause) =>
      isDaemonLockError(cause)
        ? cause
        : makeLockError(lockPath, "Failed to resolve daemon lock command.", cause),
  });

const waitForLockReady = (
  child: ChildProcess.ChildProcess,
  lockPath: string,
): Effect.Effect<void, DaemonLockError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        let stderr = "";
        let stdoutBuffer = "";
        const timeout = setTimeout(() => {
          cleanup();
          child.kill("SIGKILL");
          reject(makeLockError(lockPath, "Timed out waiting for daemon startup lock acquisition."));
        }, LOCK_HELPER_READY_TIMEOUT_MS);

        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          child.stdout?.removeAllListeners();
          child.stderr?.removeAllListeners();
          child.removeAllListeners();
        };

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");

        child.stdout?.on("data", (chunk: string) => {
          stdoutBuffer += chunk;
          if (stdoutBuffer.includes(`${LOCK_READY_LINE}\n`)) {
            cleanup();
            resolve();
          }
        });

        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });

        child.once("error", (cause) => {
          cleanup();
          reject(
            makeLockError(
              lockPath,
              `Failed to start daemon lock helper.${stderr.length > 0 ? ` ${stderr}` : ""}`,
              cause,
            ),
          );
        });

        child.once("exit", (code, signal) => {
          cleanup();
          reject(
            makeLockError(
              lockPath,
              `Daemon lock helper exited before readiness (code=${code ?? "null"}, signal=${signal ?? "null"}). ${stderr}`.trim(),
            ),
          );
        });
      }),
    catch: (cause) =>
      isDaemonLockError(cause)
        ? cause
        : makeLockError(lockPath, "Failed while waiting for daemon startup lock.", cause),
  });

const releaseLockProcess = (
  child: ChildProcess.ChildProcess,
  lockPath: string,
): Effect.Effect<void, DaemonLockError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          cleanup();
          reject(makeLockError(lockPath, "Timed out releasing daemon startup lock."));
        }, LOCK_HELPER_READY_TIMEOUT_MS);

        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          child.removeAllListeners();
        };

        child.once("exit", (code, signal) => {
          cleanup();
          if (code === 0 || signal === "SIGTERM") {
            resolve();
            return;
          }
          reject(
            makeLockError(
              lockPath,
              `Daemon lock helper exited unexpectedly while releasing lock (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
            ),
          );
        });
        child.once("error", (cause) => {
          cleanup();
          reject(makeLockError(lockPath, "Failed to release daemon startup lock.", cause));
        });

        child.stdin?.end();
      }),
    catch: (cause) =>
      isDaemonLockError(cause)
        ? cause
        : makeLockError(lockPath, "Failed to release daemon startup lock.", cause),
  });

const acquireStartupLock = (lockPath: string): Effect.Effect<LockHandle, DaemonLockError> =>
  Effect.gen(function* () {
    const command = yield* resolveLockCommand(lockPath);
    const child = yield* Effect.try({
      try: () =>
        ChildProcess.spawn(command.command, command.args, {
          stdio: ["pipe", "pipe", "pipe"],
        }),
      catch: (cause) => makeLockError(lockPath, "Failed to spawn daemon lock helper.", cause),
    });

    yield* waitForLockReady(child, lockPath);
    return {
      release: releaseLockProcess(child, lockPath),
    } satisfies LockHandle;
  });

const withStartupLock = <A, E>(
  lockPath: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E | DaemonLockError> =>
  Effect.acquireUseRelease(
    acquireStartupLock(lockPath),
    () => effect,
    (handle) => handle.release,
  );

const createStopEffect = (input: {
  readonly binding: DaemonSocketBinding;
  readonly paths: DaemonPaths;
  readonly gracefulShutdown: Effect.Effect<void, DaemonShutdownError>;
  readonly forceShutdown: Effect.Effect<void, DaemonShutdownError>;
  readonly shutdownTimeoutMs: number;
}): Effect.Effect<Effect.Effect<void, DaemonServiceError>> =>
  Ref.make(false).pipe(
    Effect.map((stopped) =>
      Effect.gen(function* () {
        const alreadyStopped = yield* Ref.get(stopped);
        if (alreadyStopped) {
          return;
        }

        yield* Ref.set(stopped, true);

        const gracefulExit = yield* input.gracefulShutdown.pipe(
          Effect.exit,
          Effect.timeoutOption(`${input.shutdownTimeoutMs} millis`),
        );

        let shutdownError: DaemonServiceError | undefined;
        if (Option.isNone(gracefulExit)) {
          const forced = yield* input.forceShutdown.pipe(Effect.exit);
          if (forced._tag === "Failure") {
            shutdownError = new DaemonShutdownError({
              detail: "Daemon graceful shutdown timed out and force shutdown failed.",
              cause: toDefect(forced.cause),
            });
          }
        } else if (gracefulExit.value._tag === "Failure") {
          const forced = yield* input.forceShutdown.pipe(Effect.exit);
          shutdownError = new DaemonShutdownError({
            detail:
              forced._tag === "Failure"
                ? "Daemon graceful shutdown failed and force shutdown failed."
                : "Daemon graceful shutdown failed.",
            cause: toDefect(gracefulExit.value.cause),
          });
        }

        yield* closeSocketBinding(input.paths.socketPath, input.binding);
        yield* cleanupDaemonArtifacts(input.paths);

        if (shutdownError !== undefined) {
          return yield* shutdownError;
        }
      }),
    ),
  );

const makeDaemonService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const paths = makeDaemonPaths(config.baseDir);

  const getPaths = Effect.succeed(paths);

  const probeSocket = (socketPath = paths.socketPath, timeoutMs = DEFAULT_PING_TIMEOUT_MS) =>
    pingSocket(socketPath, timeoutMs);

  const start = (input: DaemonStartInput): Effect.Effect<DaemonStartResult, DaemonServiceError> =>
    withStartupLock(
      paths.lockPath,
      Effect.gen(function* () {
        yield* ensureParentDirectory(paths.lockPath);

        const existingPid = yield* readPidFile(paths.pidPath);
        if (existingPid !== undefined && (yield* isProcessAlive(existingPid))) {
          const responsive = yield* pingSocket(paths.socketPath, input.pingTimeoutMs);
          if (responsive) {
            const existingInfo = yield* readDaemonInfo(paths.daemonInfoPath, paths.socketPath);
            return {
              type: "already-running",
              pid: existingPid,
              info:
                existingInfo !== undefined && existingInfo.pid === existingPid
                  ? existingInfo
                  : undefined,
              paths,
            } as const;
          }

          yield* terminateProcess(existingPid);
          yield* cleanupDaemonArtifacts(paths);
        } else if (existingPid !== undefined) {
          yield* cleanupDaemonArtifacts(paths);
        } else {
          yield* removeIfExists(paths.daemonInfoPath, "remove-daemon-info");
          yield* removeIfExists(paths.socketPath, "remove-socket");
        }

        const binding = yield* input
          .bindSocket(paths.socketPath)
          .pipe(
            Effect.mapError((cause) =>
              makeSocketError(paths.socketPath, "bind", "Failed to bind daemon socket.", cause),
            ),
          );

        yield* Effect.tryPromise({
          try: async () => {
            await FSP.chmod(paths.socketPath, SOCKET_PERMISSIONS);
          },
          catch: (cause) =>
            makeSocketError(
              paths.socketPath,
              "chmod",
              "Failed to set daemon socket permissions.",
              cause,
            ),
        }).pipe(
          Effect.catch((error) =>
            closeSocketBinding(paths.socketPath, binding).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );

        const info = {
          pid: process.pid,
          wsPort: input.wsPort,
          wsToken: input.wsToken ?? Crypto.randomBytes(32).toString("hex"),
          socketPath: paths.socketPath,
          startedAt: input.startedAt ?? new Date().toISOString(),
        } satisfies DaemonInfo;

        yield* writeDaemonState(paths, info).pipe(
          Effect.catch((error) =>
            closeSocketBinding(paths.socketPath, binding).pipe(
              Effect.andThen(cleanupDaemonArtifacts(paths)),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );

        const stop = yield* createStopEffect({
          binding,
          paths,
          gracefulShutdown: input.gracefulShutdown ?? Effect.void,
          forceShutdown: input.forceShutdown ?? Effect.void,
          shutdownTimeoutMs: input.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        });

        return {
          type: "started",
          info,
          paths,
          stop,
        } as const;
      }),
    );

  return {
    getPaths,
    probeSocket,
    start,
  };
});

export const DaemonServiceLive = Layer.effect(DaemonService, makeDaemonService);
