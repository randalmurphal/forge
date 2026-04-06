import * as OS from "node:os";
import * as Path from "node:path";

import {
  parseDaemonManifest,
  readTrustedDaemonManifest,
  readTrustedDaemonManifestSync,
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
): Promise<DesktopDaemonInfo | undefined> => readTrustedDaemonManifest(daemonInfoPath, options);

export const readDaemonInfoSync = (
  daemonInfoPath: string,
  options?: DesktopDaemonReadOptions,
): DesktopDaemonInfo | undefined => readTrustedDaemonManifestSync(daemonInfoPath, options);

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

  const readLatestWsUrl = (): string | null => {
    const daemonInfo = readSync(paths.daemonInfoPath, readOptions);
    if (daemonInfo === undefined) {
      return null;
    }

    const nextWsUrl = buildDaemonWsUrl(daemonInfo);
    cachedWsUrl = nextWsUrl;
    return nextWsUrl;
  };

  const getWsUrl = (): string | null => {
    const latestWsUrl = readLatestWsUrl();
    if (latestWsUrl !== null) {
      return latestWsUrl;
    }

    return cachedWsUrl;
  };

  const prime = (): Promise<string | null> => {
    if (primePromise !== undefined) {
      return primePromise;
    }

    primePromise = (async () => {
      const latestWsUrl = readLatestWsUrl();
      if (latestWsUrl !== null) {
        return latestWsUrl;
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
    })().finally(() => {
      primePromise = undefined;
    });

    return primePromise;
  };

  return {
    getWsUrl,
    prime,
  };
};
