import * as ChildProcess from "node:child_process";
import * as FSP from "node:fs/promises";
import * as Net from "node:net";
import * as readline from "node:readline";

export interface DesktopDaemonPaths {
  readonly baseDir: string;
  readonly socketPath: string;
  readonly daemonInfoPath: string;
}

export interface DesktopDaemonInfo {
  readonly pid: number;
  readonly wsPort: number;
  readonly wsToken: string;
  readonly socketPath: string;
  readonly startedAt: string;
}

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
  readonly readDaemonInfo?: (daemonInfoPath: string) => Promise<DesktopDaemonInfo | undefined>;
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

const DEFAULT_DAEMON_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_PING_TIMEOUT_MS = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const toDesktopDaemonInfo = (value: unknown): DesktopDaemonInfo | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const pid = value.pid;
  const wsPort = value.wsPort;
  const wsToken = value.wsToken;
  const socketPath = value.socketPath;
  const startedAt = value.startedAt;

  if (
    !isPositiveInteger(pid) ||
    !isPositiveInteger(wsPort) ||
    !isNonEmptyString(wsToken) ||
    !isNonEmptyString(socketPath) ||
    !isNonEmptyString(startedAt)
  ) {
    return undefined;
  }

  return {
    pid,
    wsPort,
    wsToken,
    socketPath,
    startedAt,
  };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const readDaemonInfo = async (
  daemonInfoPath: string,
): Promise<DesktopDaemonInfo | undefined> => {
  try {
    const raw = await FSP.readFile(daemonInfoPath, "utf8");
    return toDesktopDaemonInfo(JSON.parse(raw));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
};

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

export const buildDaemonWsUrl = (info: DesktopDaemonInfo): string =>
  `ws://127.0.0.1:${info.wsPort}/?token=${encodeURIComponent(info.wsToken)}`;

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
    ...(input.env ?? process.env),
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

  const existing = await readInfo(input.paths.daemonInfoPath);
  if (existing !== undefined && (await ping(input.paths.socketPath))) {
    return {
      info: existing,
      source: "existing",
      wsUrl: buildDaemonWsUrl(existing),
    };
  }

  await input.spawnDetachedDaemon();

  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const nextInfo = await readInfo(input.paths.daemonInfoPath);
    if (nextInfo !== undefined && (await ping(input.paths.socketPath))) {
      return {
        info: nextInfo,
        source: "spawned",
        wsUrl: buildDaemonWsUrl(nextInfo),
      };
    }
    await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Forge daemon did not become ready within ${input.timeoutMs ?? DEFAULT_DAEMON_TIMEOUT_MS}ms.`,
  );
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
