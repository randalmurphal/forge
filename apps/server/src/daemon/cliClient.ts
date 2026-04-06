import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FSP from "node:fs/promises";
import * as Net from "node:net";
import * as Path from "node:path";
import * as readline from "node:readline";

import { isTrustedDaemonManifest, parseDaemonManifest } from "@forgetools/shared/daemon";
import { Data, Effect } from "effect";

import { resolveBaseDir } from "../os-jank.ts";
import type { DaemonInfo } from "./Services/DaemonService.ts";

const DEFAULT_RPC_TIMEOUT_MS = 3_000;

type JsonRpcSuccess = {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result: unknown;
};

type JsonRpcFailure = {
  readonly jsonrpc: "2.0";
  readonly id: string | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
};

export interface CliDaemonPaths {
  readonly baseDir: string;
  readonly socketPath: string;
  readonly daemonInfoPath: string;
  readonly worktreesDir: string;
}

export interface CliDaemonInfoReadOptions {
  readonly expectedSocketPath?: string;
  readonly requireOwnerOnlyPermissions?: boolean;
  readonly platform?: NodeJS.Platform;
}

export interface DaemonStatusSnapshot {
  readonly running: boolean;
  readonly paths: CliDaemonPaths;
  readonly info: DaemonInfo | undefined;
  readonly ping:
    | {
        readonly status: string;
        readonly uptime: number;
      }
    | undefined;
}

export interface DaemonLaunchPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export class ForgeDaemonCliError extends Data.TaggedError("ForgeDaemonCliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const daemonUnavailableError = (socketPath: string, cause: unknown) =>
  new ForgeDaemonCliError({
    message: `Forge daemon is not running at ${socketPath}. Start it with \`forge daemon start\`.`,
    cause: toError(cause),
  });

const rpcError = (method: string, message: string, cause?: unknown) =>
  new ForgeDaemonCliError({
    message: `Daemon RPC '${method}' failed: ${message}`,
    ...(cause === undefined ? {} : { cause: toError(cause) }),
  });

export const resolveCliDaemonPaths = (rawBaseDir: string | undefined) =>
  Effect.gen(function* () {
    const baseDir = yield* resolveBaseDir(rawBaseDir);
    return {
      baseDir,
      socketPath: Path.join(baseDir, "forge.sock"),
      daemonInfoPath: Path.join(baseDir, "daemon.json"),
      worktreesDir: Path.join(baseDir, "worktrees"),
    } satisfies CliDaemonPaths;
  });

export const readDaemonInfoFile = (daemonInfoPath: string, options?: CliDaemonInfoReadOptions) =>
  Effect.tryPromise({
    try: async () => {
      try {
        const [raw, stat] = await Promise.all([
          FSP.readFile(daemonInfoPath, "utf8"),
          FSP.stat(daemonInfoPath),
        ]);
        const info = parseDaemonManifest(JSON.parse(raw));
        if (info === undefined) {
          return undefined;
        }
        return isTrustedDaemonManifest(info, stat.mode, options) ? info : undefined;
      } catch (cause) {
        const nodeError = cause as NodeJS.ErrnoException | undefined;
        if (nodeError?.code === "ENOENT") {
          return undefined;
        }
        throw rpcError("daemon.info", "Failed to read daemon.json.", cause);
      }
    },
    catch: (cause) =>
      cause instanceof ForgeDaemonCliError
        ? cause
        : rpcError("daemon.info", "Failed to read daemon.json.", cause),
  });

export const sendDaemonRpc = <Result = unknown>(input: {
  readonly socketPath: string;
  readonly method: string;
  readonly params?: unknown;
  readonly timeoutMs?: number;
}) =>
  Effect.tryPromise({
    try: async () => {
      const socketStat = await FSP.stat(input.socketPath).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") {
          return undefined;
        }
        throw cause;
      });

      if (socketStat === undefined || !socketStat.isSocket()) {
        throw daemonUnavailableError(
          input.socketPath,
          new Error(`Socket path ${input.socketPath} is unavailable.`),
        );
      }

      return await new Promise<Result>((resolve, reject) => {
        const requestId = Crypto.randomUUID();
        const socket = new Net.Socket();
        const lines = readline.createInterface({
          input: socket,
          crlfDelay: Infinity,
        });
        let settled = false;

        const finish = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          lines.removeAllListeners();
          socket.removeAllListeners();
          lines.close();
          socket.destroy();
          fn();
        };

        const timeout = setTimeout(() => {
          finish(() =>
            reject(
              rpcError(input.method, `Timed out waiting for a response from ${input.socketPath}.`),
            ),
          );
        }, input.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);

        socket.once("error", (cause) => {
          finish(() => reject(daemonUnavailableError(input.socketPath, cause)));
        });

        socket.once("connect", () => {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              method: input.method,
              params: input.params ?? {},
            })}\n`,
          );
        });

        socket.connect(input.socketPath);

        lines.once("line", (line) => {
          let parsed: JsonRpcSuccess | JsonRpcFailure;
          try {
            parsed = JSON.parse(line) as JsonRpcSuccess | JsonRpcFailure;
          } catch (cause) {
            finish(() =>
              reject(rpcError(input.method, "Received malformed JSON-RPC response.", cause)),
            );
            return;
          }

          if ("error" in parsed) {
            finish(() =>
              reject(
                rpcError(
                  input.method,
                  `${parsed.error.message} (code ${parsed.error.code})`,
                  parsed.error.data,
                ),
              ),
            );
            return;
          }

          finish(() => resolve(parsed.result as Result));
        });
      });
    },
    catch: (cause) =>
      cause instanceof ForgeDaemonCliError
        ? cause
        : rpcError(input.method, "Unexpected daemon RPC failure.", cause),
  });

export const getDaemonStatusSnapshot = (paths: CliDaemonPaths) =>
  Effect.gen(function* () {
    const info = yield* readDaemonInfoFile(paths.daemonInfoPath, {
      expectedSocketPath: paths.socketPath,
      requireOwnerOnlyPermissions: true,
    });
    const ping = yield* sendDaemonRpc<{ readonly status: string; readonly uptime: number }>({
      socketPath: paths.socketPath,
      method: "daemon.ping",
      timeoutMs: 1_000,
    }).pipe(Effect.option);

    if (ping._tag === "None") {
      return {
        running: false,
        paths,
        info,
        ping: undefined,
      } satisfies DaemonStatusSnapshot;
    }

    return {
      running: true,
      paths,
      info,
      ping: ping.value,
    } satisfies DaemonStatusSnapshot;
  });

export const buildDaemonLaunchPlan = (input: {
  readonly baseDir: string;
  readonly entryScriptPath?: string;
  readonly execPath?: string;
}) => {
  const entryScriptPath = input.entryScriptPath ?? process.argv[1];
  if (!entryScriptPath || entryScriptPath.trim().length === 0) {
    return new ForgeDaemonCliError({
      message: "Cannot determine the Forge server entrypoint for daemon startup.",
    });
  }

  const env = { ...process.env };
  delete env.FORGE_MODE;
  delete env.FORGE_NO_BROWSER;

  return {
    command: input.execPath ?? process.execPath,
    args: [entryScriptPath, "--mode", "daemon", "--no-browser", "--base-dir", input.baseDir],
    cwd: process.cwd(),
    env,
  } satisfies DaemonLaunchPlan;
};

export const launchDaemonProcess = (plan: DaemonLaunchPlan) =>
  Effect.try({
    try: () => {
      const child = ChildProcess.spawn(plan.command, [...plan.args], {
        cwd: plan.cwd,
        env: plan.env,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return child;
    },
    catch: (cause) =>
      new ForgeDaemonCliError({
        message: "Failed to spawn the Forge daemon process.",
        cause: toError(cause),
      }),
  });

export const waitForDaemonReady = (
  paths: CliDaemonPaths,
  timeoutMs = 1_500,
  pollIntervalMs = 100,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = yield* getDaemonStatusSnapshot(paths);
      if (status.running) {
        return status;
      }
      yield* Effect.sleep(`${pollIntervalMs} millis`);
    }
    return undefined;
  });

export const cleanEmptyWorktrees = (worktreesDir: string) =>
  Effect.tryPromise({
    try: async () => {
      const stat = await FSP.stat(worktreesDir).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") {
          return undefined;
        }
        throw cause;
      });

      if (stat === undefined || !stat.isDirectory()) {
        return [] as ReadonlyArray<string>;
      }

      const entries = await FSP.readdir(worktreesDir, { withFileTypes: true });
      const removed: Array<string> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const entryPath = Path.join(worktreesDir, entry.name);
        const children = await FSP.readdir(entryPath);
        if (children.length > 0) {
          continue;
        }
        await FSP.rm(entryPath, { recursive: true, force: true });
        removed.push(entry.name);
      }
      return removed as ReadonlyArray<string>;
    },
    catch: (cause) =>
      new ForgeDaemonCliError({
        message: `Failed to clean empty Forge worktree directories under ${worktreesDir}.`,
        cause: toError(cause),
      }),
  });
