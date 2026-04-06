import * as ChildProcess from "node:child_process";
import * as Net from "node:net";
import * as readline from "node:readline";
import * as FSP from "node:fs/promises";
import { stripInheritedDaemonRuntimeEnv } from "@forgetools/shared/daemon";
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const pingDaemon = async (
  socketPath: string,
  timeoutMs = DEFAULT_PING_TIMEOUT_MS,
): Promise<boolean> => {
  try {
    const stat = await FSP.stat(socketPath);
    if (!stat.isSocket()) {
      return false;
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }
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
      lines.close();
      socket.destroy();
      resolve(result);
    };

    const timeout = setTimeout(() => finish(false), timeoutMs);

    socket.once("error", () => finish(false));
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "forge-desktop-ping",
          method: "daemon.ping",
          params: {},
        })}\n`,
      );
    });
    socket.connect(socketPath);

    lines.once("line", (line) => {
      try {
        const parsed = JSON.parse(line) as { readonly result?: { readonly status?: string } };
        finish(parsed.result?.status === "ok");
      } catch {
        finish(false);
      }
    });
  });
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

export const launchDetachedDaemon = async (
  plan: DetachedDaemonLaunchPlan,
  spawn: typeof ChildProcess.spawn = ChildProcess.spawn,
): Promise<void> => {
  const child = spawn(plan.command, [...plan.args], {
    cwd: plan.cwd,
    env: plan.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

export const ensureDaemonConnection = async (
  input: EnsureDaemonConnectionInput,
): Promise<ConnectedDaemon> => {
  const readInfo = input.readDaemonInfo ?? readDaemonInfo;
  const ping = input.pingDaemon ?? pingDaemon;
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
    readonly waitedOnResponsiveSocket: boolean;
  }> => {
    let waitedOnResponsiveSocket = false;

    while (Date.now() < deadline) {
      const readyExisting = await connectIfManifestReady("existing");
      if (readyExisting !== undefined) {
        return {
          daemon: readyExisting,
          waitedOnResponsiveSocket,
        };
      }

      if (!(await ping(input.paths.socketPath))) {
        return {
          daemon: undefined,
          waitedOnResponsiveSocket,
        };
      }

      waitedOnResponsiveSocket = true;
      await sleep(pollIntervalMs);
    }

    return {
      daemon: undefined,
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
