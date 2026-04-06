import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { hasExpectedDaemonSocketPath, hasOwnerOnlyFileMode } from "@forgetools/shared/daemon";

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

export interface DesktopWsUrlResolver {
  readonly getWsUrl: () => string | null;
  readonly prime: () => Promise<string | null>;
}

export interface DesktopDaemonReadOptions {
  readonly expectedSocketPath?: string;
  readonly requireOwnerOnlyPermissions?: boolean;
  readonly platform?: NodeJS.Platform;
}

const DEFAULT_DAEMON_INFO_TIMEOUT_MS = 1_500;
const DEFAULT_DAEMON_INFO_POLL_INTERVAL_MS = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const resolveDesktopBaseDir = (
  env: NodeJS.ProcessEnv = process.env,
  homedir = OS.homedir(),
): string => {
  const override = env.FORGE_HOME?.trim();
  return override && override.length > 0 ? override : Path.join(homedir, ".forge");
};

export const resolveDesktopDaemonPaths = (
  baseDir = resolveDesktopBaseDir(),
): DesktopDaemonPaths => ({
  baseDir,
  socketPath: Path.join(baseDir, "forge.sock"),
  daemonInfoPath: Path.join(baseDir, "daemon.json"),
});

export const toDesktopDaemonInfo = (value: unknown): DesktopDaemonInfo | undefined => {
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

const shouldRequireOwnerOnlyPermissions = (options?: DesktopDaemonReadOptions): boolean =>
  (options?.requireOwnerOnlyPermissions ?? true) &&
  (options?.platform ?? process.platform) !== "win32";

const isTrustedDaemonInfo = (
  daemonInfo: DesktopDaemonInfo,
  mode: number,
  options?: DesktopDaemonReadOptions,
): boolean => {
  if (
    options?.expectedSocketPath !== undefined &&
    !hasExpectedDaemonSocketPath(daemonInfo, options.expectedSocketPath)
  ) {
    return false;
  }

  if (shouldRequireOwnerOnlyPermissions(options) && !hasOwnerOnlyFileMode(mode)) {
    return false;
  }

  return true;
};

export const readDaemonInfo = async (
  daemonInfoPath: string,
  options?: DesktopDaemonReadOptions,
): Promise<DesktopDaemonInfo | undefined> => {
  try {
    const [raw, stat] = await Promise.all([
      FSP.readFile(daemonInfoPath, "utf8"),
      FSP.stat(daemonInfoPath),
    ]);
    const daemonInfo = toDesktopDaemonInfo(JSON.parse(raw));
    if (daemonInfo === undefined) {
      return undefined;
    }
    return isTrustedDaemonInfo(daemonInfo, stat.mode, options) ? daemonInfo : undefined;
  } catch {
    return undefined;
  }
};

export const readDaemonInfoSync = (
  daemonInfoPath: string,
  options?: DesktopDaemonReadOptions,
): DesktopDaemonInfo | undefined => {
  try {
    const raw = FS.readFileSync(daemonInfoPath, "utf8");
    const stat = FS.statSync(daemonInfoPath);
    const daemonInfo = toDesktopDaemonInfo(JSON.parse(raw));
    if (daemonInfo === undefined) {
      return undefined;
    }
    return isTrustedDaemonInfo(daemonInfo, stat.mode, options) ? daemonInfo : undefined;
  } catch {
    return undefined;
  }
};

export const buildDaemonWsUrl = (info: DesktopDaemonInfo): string =>
  `ws://127.0.0.1:${info.wsPort}/?token=${encodeURIComponent(info.wsToken)}`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createDesktopWsUrlResolver = (input?: {
  readonly paths?: DesktopDaemonPaths;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly readDaemonInfo?: (daemonInfoPath: string) => Promise<DesktopDaemonInfo | undefined>;
  readonly readDaemonInfoSync?: (daemonInfoPath: string) => DesktopDaemonInfo | undefined;
  readonly sleep?: (ms: number) => Promise<void>;
}): DesktopWsUrlResolver => {
  const paths = input?.paths ?? resolveDesktopDaemonPaths();
  const readAsync = input?.readDaemonInfo ?? readDaemonInfo;
  const readSync = input?.readDaemonInfoSync ?? readDaemonInfoSync;
  const sleepFn = input?.sleep ?? sleep;
  const readOptions = {
    expectedSocketPath: paths.socketPath,
    requireOwnerOnlyPermissions: true,
  } satisfies DesktopDaemonReadOptions;
  const initialDaemonInfo = readSync(paths.daemonInfoPath, readOptions);
  let cachedWsUrl = initialDaemonInfo !== undefined ? buildDaemonWsUrl(initialDaemonInfo) : null;
  let primePromise: Promise<string | null> | undefined;

  const getWsUrl = (): string | null => {
    if (cachedWsUrl !== null) {
      return cachedWsUrl;
    }

    const daemonInfo = readSync(paths.daemonInfoPath, readOptions);
    if (daemonInfo === undefined) {
      return null;
    }

    cachedWsUrl = buildDaemonWsUrl(daemonInfo);
    return cachedWsUrl;
  };

  const prime = (): Promise<string | null> => {
    if (primePromise !== undefined) {
      return primePromise;
    }

    primePromise = (async () => {
      if (cachedWsUrl !== null) {
        return cachedWsUrl;
      }

      const deadline = Date.now() + (input?.timeoutMs ?? DEFAULT_DAEMON_INFO_TIMEOUT_MS);
      while (Date.now() < deadline) {
        const daemonInfo = await readAsync(paths.daemonInfoPath, readOptions);
        if (daemonInfo !== undefined) {
          cachedWsUrl = buildDaemonWsUrl(daemonInfo);
          return cachedWsUrl;
        }
        await sleepFn(input?.pollIntervalMs ?? DEFAULT_DAEMON_INFO_POLL_INTERVAL_MS);
      }

      return getWsUrl();
    })();

    return primePromise;
  };

  return {
    getWsUrl,
    prime,
  };
};
