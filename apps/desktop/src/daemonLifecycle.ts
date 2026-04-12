import * as ChildProcess from "node:child_process";
import * as Net from "node:net";
import * as OS from "node:os";
import * as readline from "node:readline";
import {
  readTrustedDaemonSocketStat,
  stripInheritedDaemonRuntimeEnv,
} from "@forgetools/shared/daemon";
import {
  buildDaemonWsUrl,
  readDaemonInfo,
  type DesktopDaemonReadOptions,
  type DesktopDaemonInfo,
  type DesktopDaemonPaths,
} from "./daemonState";

export { buildDaemonWsUrl, readDaemonInfo };
export type { DesktopDaemonInfo, DesktopDaemonPaths };

export interface DetachedDaemonLaunchPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ConnectedDaemon {
  readonly info: DesktopDaemonInfo;
  readonly source: "existing" | "spawned";
  readonly wsUrl: string;
}

export interface EnsureDaemonConnectionInput {
  readonly paths: DesktopDaemonPaths;
  readonly spawnDetachedDaemon: () => Promise<void>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly readDaemonInfo?: (
    daemonInfoPath: string,
    options?: DesktopDaemonReadOptions,
  ) => Promise<DesktopDaemonInfo | undefined>;
  readonly pingDaemon?: (socketPath: string) => Promise<boolean>;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
}

export interface StopDesktopDaemonInput {
  readonly paths: DesktopDaemonPaths;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly readDaemonInfo?: (
    daemonInfoPath: string,
    options?: DesktopDaemonReadOptions,
  ) => Promise<DesktopDaemonInfo | undefined>;
  readonly stopDaemon?: (
    socketPath: string,
    input?: {
      readonly timeoutMs?: number;
      readonly pollIntervalMs?: number;
      readonly ping?: (socketPath: string) => Promise<boolean>;
    },
  ) => Promise<boolean>;
  readonly pingDaemon?: (socketPath: string) => Promise<boolean>;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  readonly terminateProcess?: (pid: number) => Promise<boolean>;
}

export interface SingleInstanceAppLike {
  readonly requestSingleInstanceLock: () => boolean;
  readonly quit: () => void;
}

export interface ProtocolClientAppLike {
  readonly setAsDefaultProtocolClient: (scheme: string) => boolean;
}

export interface BeforeQuitHandlers {
  readonly markQuitting: () => void;
  readonly clearUpdatePollTimer: () => void;
  readonly restoreStdIoCapture: () => void;
  readonly stopDaemon?: () => void;
}

export interface DesktopUiReadinessInput {
  readonly appReady: boolean;
  readonly backendWsUrl: string;
}

const DEFAULT_DAEMON_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_PING_TIMEOUT_MS = 1_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_TERMINATE_TIMEOUT_MS = 2_000;
const DESKTOP_DAEMON_PING_REQUEST_ID = "forge-desktop-ping";
const DESKTOP_DAEMON_STOP_REQUEST_ID = "forge-desktop-stop";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const noop = () => {};

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
};

const waitForProcessExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !isProcessAlive(pid);
};

const terminateProcess = async (pid: number): Promise<boolean> => {
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    return true;
  }

  try {
    if (process.platform === "win32") {
      const result = ChildProcess.spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      if (result.error && result.status !== 0) {
        return false;
      }
      return await waitForProcessExit(pid, DEFAULT_FORCE_TERMINATE_TIMEOUT_MS);
    }

    process.kill(pid, "SIGTERM");
    if (await waitForProcessExit(pid, DEFAULT_FORCE_TERMINATE_TIMEOUT_MS)) {
      return true;
    }

    process.kill(pid, "SIGKILL");
    return await waitForProcessExit(pid, DEFAULT_FORCE_TERMINATE_TIMEOUT_MS);
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    if (code === "ESRCH") {
      return true;
    }
    return false;
  }
};

export const pingDaemon = async (
  socketPath: string,
  timeoutMs = DEFAULT_PING_TIMEOUT_MS,
): Promise<boolean> => {
  const trustedSocket = await readTrustedDaemonSocketStat(socketPath, {
    requireOwnerOnlyPermissions: true,
  });
  if (trustedSocket === undefined) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const socket = new Net.Socket();
    const lines = readline.createInterface({
      input: socket,
      crlfDelay: Infinity,
    });
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      lines.removeAllListeners();
      socket.removeAllListeners();
      // Attach a permanent error sink so any errors emitted during or after
      // destroy (e.g. ECONNREFUSED arriving after cleanup) don't surface as
      // uncaught exceptions.
      socket.on("error", noop);
      lines.close();
      socket.destroy();
      resolve(result);
    };

    const timeout = setTimeout(() => finish(false), timeoutMs);

    socket.once("error", () => finish(false));
    lines.once("error", () => finish(false));
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: DESKTOP_DAEMON_PING_REQUEST_ID,
          method: "daemon.ping",
          params: {},
        })}\n`,
      );
    });
    socket.connect(socketPath);

    lines.once("line", (line) => {
      try {
        const parsed = JSON.parse(line) as {
          readonly jsonrpc?: string;
          readonly id?: string;
          readonly result?: { readonly status?: string };
        };
        finish(
          parsed.jsonrpc === "2.0" &&
            parsed.id === DESKTOP_DAEMON_PING_REQUEST_ID &&
            parsed.result?.status === "ok",
        );
      } catch {
        finish(false);
      }
    });
  });
};

export const stopDaemon = async (
  socketPath: string,
  input?: {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly ping?: (socketPath: string) => Promise<boolean>;
  },
): Promise<boolean> => {
  const ping = input?.ping ?? ((nextSocketPath: string) => pingDaemon(nextSocketPath));
  const timeoutMs = input?.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollIntervalMs = input?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const trustedSocket = await readTrustedDaemonSocketStat(socketPath, {
    requireOwnerOnlyPermissions: true,
  });
  if (trustedSocket === undefined) {
    return false;
  }

  const acknowledged = await new Promise<boolean>((resolve) => {
    const socket = new Net.Socket();
    const lines = readline.createInterface({
      input: socket,
      crlfDelay: Infinity,
    });
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      lines.removeAllListeners();
      socket.removeAllListeners();
      socket.on("error", noop);
      lines.close();
      socket.destroy();
      resolve(result);
    };

    const timeout = setTimeout(() => finish(false), Math.min(timeoutMs, DEFAULT_PING_TIMEOUT_MS));

    socket.once("error", () => finish(false));
    lines.once("error", () => finish(false));
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: DESKTOP_DAEMON_STOP_REQUEST_ID,
          method: "daemon.stop",
          params: {},
        })}\n`,
      );
    });
    socket.connect(socketPath);

    lines.once("line", (line) => {
      try {
        const parsed = JSON.parse(line) as {
          readonly jsonrpc?: string;
          readonly id?: string;
          readonly result?: unknown;
        };
        finish(parsed.jsonrpc === "2.0" && parsed.id === DESKTOP_DAEMON_STOP_REQUEST_ID);
      } catch {
        finish(false);
      }
    });
  });

  if (!acknowledged) {
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await ping(socketPath))) {
      return true;
    }
    await sleep(pollIntervalMs);
  }

  return !(await ping(socketPath));
};

export const stopDesktopDaemon = async (input: StopDesktopDaemonInput): Promise<boolean> => {
  const timeoutMs = input.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const ping = input.pingDaemon ?? ((socketPath: string) => pingDaemon(socketPath));
  const stop = input.stopDaemon ?? stopDaemon;
  const readInfo = input.readDaemonInfo ?? readDaemonInfo;
  const checkProcessAlive = input.isProcessAlive ?? isProcessAlive;
  const killProcess = input.terminateProcess ?? terminateProcess;

  if (
    await stop(input.paths.socketPath, {
      timeoutMs,
      pollIntervalMs,
      ping,
    })
  ) {
    return true;
  }

  const daemonInfo = await readInfo(input.paths.daemonInfoPath, {
    expectedSocketPath: input.paths.socketPath,
    requireOwnerOnlyPermissions: true,
  });
  if (!daemonInfo) {
    return !(await ping(input.paths.socketPath));
  }

  if (!(await checkProcessAlive(daemonInfo.pid))) {
    return true;
  }

  return await killProcess(daemonInfo.pid);
};

export const buildDetachedDaemonLaunchPlan = (input: {
  readonly baseDir: string;
  readonly entryScriptPath: string;
  readonly cwd: string;
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}): DetachedDaemonLaunchPlan => ({
  command: input.execPath ?? process.execPath,
  args: [input.entryScriptPath, "--mode", "daemon", "--no-browser", "--base-dir", input.baseDir],
  cwd: input.cwd,
  env: {
    ...stripInheritedDaemonRuntimeEnv(input.env ?? process.env),
    ELECTRON_RUN_AS_NODE: "1",
  },
});

export const buildWslDaemonLaunchPlan = (input: {
  readonly distro: string;
  readonly forgePath: string;
  readonly wslHome: string;
  readonly port: number;
  readonly authToken: string;
  readonly baseDir?: string;
}): DetachedDaemonLaunchPlan => {
  const baseDir = input.baseDir ?? `${input.wslHome}/.forge`;
  return {
    command: "wsl.exe",
    args: [
      "-d",
      input.distro,
      "--",
      input.forgePath,
      "--mode",
      "web",
      "--host",
      "0.0.0.0",
      "--no-browser",
      "--base-dir",
      baseDir,
      "--port",
      String(input.port),
      "--auth-token",
      input.authToken,
    ],
    cwd: process.env.USERPROFILE ?? OS.homedir(),
    env: {
      ...process.env,
      WSLENV: [process.env.WSLENV, "FORGE_LOG_LEVEL"].filter(Boolean).join(":"),
    },
  };
};

export const launchDetachedDaemon = async (
  plan: DetachedDaemonLaunchPlan,
  spawn: typeof ChildProcess.spawn = ChildProcess.spawn,
): Promise<void> => {
  const child = spawn(plan.command, [...plan.args], {
    cwd: plan.cwd,
    env: plan.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
};

export const ensureDaemonConnection = async (
  input: EnsureDaemonConnectionInput,
): Promise<ConnectedDaemon> => {
  const readInfo = input.readDaemonInfo ?? readDaemonInfo;
  const ping = input.pingDaemon ?? pingDaemon;
  const checkProcessAlive = input.isProcessAlive ?? isProcessAlive;
  const timeoutMs = input.timeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const readOptions = {
    expectedSocketPath: input.paths.socketPath,
    requireOwnerOnlyPermissions: true,
  } satisfies DesktopDaemonReadOptions;

  const deadline = Date.now() + timeoutMs;

  const connectIfManifestReady = async (
    source: ConnectedDaemon["source"],
  ): Promise<ConnectedDaemon | undefined> => {
    const daemonInfo = await readInfo(input.paths.daemonInfoPath, readOptions);
    if (daemonInfo === undefined || !(await ping(input.paths.socketPath))) {
      return undefined;
    }

    return {
      info: daemonInfo,
      source,
      wsUrl: buildDaemonWsUrl(daemonInfo),
    };
  };

  const waitForResponsiveDaemonManifest = async (): Promise<{
    readonly daemon: ConnectedDaemon | undefined;
    readonly waitedOnManifestBackedProcess: boolean;
    readonly waitedOnResponsiveSocket: boolean;
  }> => {
    let waitedOnManifestBackedProcess = false;
    let waitedOnResponsiveSocket = false;

    while (Date.now() < deadline) {
      const daemonInfo = await readInfo(input.paths.daemonInfoPath, readOptions);
      if (daemonInfo !== undefined && (await ping(input.paths.socketPath))) {
        return {
          daemon: {
            info: daemonInfo,
            source: "existing",
            wsUrl: buildDaemonWsUrl(daemonInfo),
          },
          waitedOnManifestBackedProcess,
          waitedOnResponsiveSocket,
        };
      }

      if (daemonInfo !== undefined && (await checkProcessAlive(daemonInfo.pid))) {
        waitedOnManifestBackedProcess = true;
        await sleep(pollIntervalMs);
        continue;
      }

      if (!(await ping(input.paths.socketPath))) {
        return {
          daemon: undefined,
          waitedOnManifestBackedProcess,
          waitedOnResponsiveSocket,
        };
      }

      waitedOnResponsiveSocket = true;
      await sleep(pollIntervalMs);
    }

    return {
      daemon: undefined,
      waitedOnManifestBackedProcess,
      waitedOnResponsiveSocket,
    };
  };

  const existing = await connectIfManifestReady("existing");
  if (existing !== undefined) {
    return existing;
  }

  // A responsive socket wins over a missing manifest. Wait for daemon.json to
  // appear before considering a detached relaunch, otherwise we can race a
  // healthy daemon that is still persisting its startup metadata.
  const existingAfterWait = await waitForResponsiveDaemonManifest();
  if (existingAfterWait.daemon !== undefined) {
    return existingAfterWait.daemon;
  }

  if (existingAfterWait.waitedOnManifestBackedProcess) {
    throw new Error(`Forge daemon did not become ready within ${timeoutMs}ms.`);
  }

  if (existingAfterWait.waitedOnResponsiveSocket && (await ping(input.paths.socketPath))) {
    throw new Error(
      `Forge daemon is responding on ${input.paths.socketPath}, but ${input.paths.daemonInfoPath} did not become available within ${timeoutMs}ms.`,
    );
  }

  if (Date.now() >= deadline) {
    throw new Error(`Forge daemon did not become ready within ${timeoutMs}ms.`);
  }

  await input.spawnDetachedDaemon();

  while (Date.now() < deadline) {
    const spawned = await connectIfManifestReady("spawned");
    if (spawned !== undefined) {
      return spawned;
    }
    await sleep(pollIntervalMs);
  }

  if (await ping(input.paths.socketPath)) {
    throw new Error(
      `Forge daemon is responding on ${input.paths.socketPath}, but ${input.paths.daemonInfoPath} did not become available within ${timeoutMs}ms.`,
    );
  }

  throw new Error(`Forge daemon did not become ready within ${timeoutMs}ms.`);
};

export const requestSingleInstanceOrQuit = (app: SingleInstanceAppLike): boolean => {
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) {
    app.quit();
  }
  return acquired;
};

export const registerProtocolClient = (app: ProtocolClientAppLike, scheme: string): boolean =>
  app.setAsDefaultProtocolClient(scheme);

export const isDesktopUiReady = (input: DesktopUiReadinessInput): boolean =>
  input.appReady && input.backendWsUrl.trim().length > 0;

export const extractProtocolUrlFromArgv = (
  argv: ReadonlyArray<string>,
  scheme: string,
): string | undefined => argv.find((entry) => entry.startsWith(`${scheme}://`));

export const parseSessionProtocolUrl = (
  rawUrl: string,
  scheme: string,
): { readonly threadId: string } | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== `${scheme}:` || parsed.hostname !== "session") {
    return undefined;
  }

  const threadId = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  if (threadId.length === 0 || threadId.includes("/")) {
    return undefined;
  }

  return { threadId };
};

export const buildDesktopWindowUrl = (input: {
  readonly scheme: string;
  readonly threadId?: string;
  readonly devServerUrl?: string;
}): string => {
  const hash = input.threadId ? `#/${encodeURIComponent(input.threadId)}` : "";
  if (typeof input.devServerUrl === "string" && input.devServerUrl.length > 0) {
    const url = new URL(input.devServerUrl);
    url.hash = hash.length > 0 ? hash.slice(1) : "";
    return url.toString();
  }
  return `${input.scheme}://app/index.html${hash}`;
};

export const handleDesktopBeforeQuit = (handlers: BeforeQuitHandlers): void => {
  handlers.markQuitting();
  handlers.clearUpdatePollTimer();
  handlers.restoreStdIoCapture();
};
