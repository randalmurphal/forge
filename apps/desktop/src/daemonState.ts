import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  isTrustedDaemonManifest,
  parseDaemonManifest,
  type DaemonManifestTrustOptions,
  type ForgeDaemonManifest,
} from "@forgetools/shared/daemon";

export interface DesktopDaemonPaths {
  readonly baseDir: string;
  readonly socketPath: string;
  readonly daemonInfoPath: string;
}

export type DesktopDaemonInfo = ForgeDaemonManifest;

export interface DesktopWsUrlResolver {
  readonly getWsUrl: () => string | null;
  readonly prime: () => Promise<string | null>;
}

export interface DesktopDaemonReadOptions extends DaemonManifestTrustOptions {}

const DEFAULT_DAEMON_INFO_TIMEOUT_MS = 1_500;
const DEFAULT_DAEMON_INFO_POLL_INTERVAL_MS = 50;

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

export const toDesktopDaemonInfo = parseDaemonManifest;

export const readDaemonInfo = async (
  daemonInfoPath: string,
  options?: DesktopDaemonReadOptions,
): Promise<DesktopDaemonInfo | undefined> => {
  try {
    const [raw, stat] = await Promise.all([
      FSP.readFile(daemonInfoPath, "utf8"),
      FSP.stat(daemonInfoPath),
    ]);
    const daemonInfo = parseDaemonManifest(JSON.parse(raw));
    if (daemonInfo === undefined) {
      return undefined;
    }
    return isTrustedDaemonManifest(daemonInfo, stat.mode, options) ? daemonInfo : undefined;
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
    const daemonInfo = parseDaemonManifest(JSON.parse(raw));
    if (daemonInfo === undefined) {
      return undefined;
    }
    return isTrustedDaemonManifest(daemonInfo, stat.mode, options) ? daemonInfo : undefined;
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
