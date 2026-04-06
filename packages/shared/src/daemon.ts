import * as FS from "node:fs";
import * as FSP from "node:fs/promises";

export interface ForgeDaemonManifest {
  readonly pid: number;
  readonly wsPort: number;
  readonly wsToken: string;
  readonly socketPath: string;
  readonly startedAt: string;
}

export const OWNER_ONLY_FILE_MODE = 0o600;

export interface DaemonManifestLike {
  readonly socketPath: string;
}

export interface DaemonManifestTrustOptions {
  readonly expectedSocketPath?: string;
  readonly requireOwnerOnlyPermissions?: boolean;
  readonly platform?: NodeJS.Platform;
}

const DAEMON_WS_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const ISO_UTC_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NOFOLLOW_OPEN_FLAG =
  process.platform !== "win32" && typeof FS.constants.O_NOFOLLOW === "number"
    ? FS.constants.O_NOFOLLOW
    : 0;
const SAFE_DAEMON_MANIFEST_READ_FLAGS = FS.constants.O_RDONLY | NOFOLLOW_OPEN_FLAG;

const INHERITED_DAEMON_RUNTIME_ENV_KEYS = [
  "FORGE_AUTH_TOKEN",
  "FORGE_BOOTSTRAP_FD",
  "FORGE_HOST",
  "FORGE_MODE",
  "FORGE_NO_BROWSER",
  "FORGE_PORT",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isPortNumber = (value: unknown): value is number =>
  isPositiveInteger(value) && value <= 65_535;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isCanonicalIsoDateTime = (value: unknown): value is string => {
  if (typeof value !== "string" || !ISO_UTC_DATE_TIME_PATTERN.test(value)) {
    return false;
  }

  return new Date(value).toISOString() === value;
};

export const isForgeDaemonWsToken = (value: unknown): value is string =>
  typeof value === "string" && DAEMON_WS_TOKEN_PATTERN.test(value);

export const hasOwnerOnlyFileMode = (mode: number): boolean =>
  (mode & 0o777) === OWNER_ONLY_FILE_MODE;

export const hasExpectedDaemonSocketPath = (
  manifest: DaemonManifestLike,
  expectedSocketPath: string,
): boolean => manifest.socketPath === expectedSocketPath;

export const shouldRequireOwnerOnlyPermissions = (options?: DaemonManifestTrustOptions): boolean =>
  (options?.requireOwnerOnlyPermissions ?? true) &&
  (options?.platform ?? process.platform) !== "win32";

export const stripInheritedDaemonRuntimeEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const sanitizedEnv = { ...env };
  for (const key of INHERITED_DAEMON_RUNTIME_ENV_KEYS) {
    delete sanitizedEnv[key];
  }
  return sanitizedEnv;
};

export const parseDaemonManifest = (value: unknown): ForgeDaemonManifest | undefined => {
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
    !isPortNumber(wsPort) ||
    !isForgeDaemonWsToken(wsToken) ||
    !isNonEmptyString(socketPath) ||
    !isCanonicalIsoDateTime(startedAt)
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

export const isTrustedDaemonManifest = (
  manifest: DaemonManifestLike,
  mode: number,
  options?: DaemonManifestTrustOptions,
): boolean => {
  if (
    options?.expectedSocketPath !== undefined &&
    !hasExpectedDaemonSocketPath(manifest, options.expectedSocketPath)
  ) {
    return false;
  }

  if (shouldRequireOwnerOnlyPermissions(options) && !hasOwnerOnlyFileMode(mode)) {
    return false;
  }

  return true;
};

export const readTrustedDaemonManifest = async (
  daemonInfoPath: string,
  options?: DaemonManifestTrustOptions,
): Promise<ForgeDaemonManifest | undefined> => {
  let handle: FSP.FileHandle | undefined;
  try {
    handle = await FSP.open(daemonInfoPath, SAFE_DAEMON_MANIFEST_READ_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return undefined;
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const daemonInfo = parseDaemonManifest(JSON.parse(raw));
    if (daemonInfo === undefined) {
      return undefined;
    }
    return isTrustedDaemonManifest(daemonInfo, stat.mode, options) ? daemonInfo : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const readTrustedDaemonManifestSync = (
  daemonInfoPath: string,
  options?: DaemonManifestTrustOptions,
): ForgeDaemonManifest | undefined => {
  let fd: number | undefined;
  try {
    fd = FS.openSync(daemonInfoPath, SAFE_DAEMON_MANIFEST_READ_FLAGS);
    const stat = FS.fstatSync(fd);
    if (!stat.isFile()) {
      return undefined;
    }
    const raw = FS.readFileSync(fd, "utf8");
    const daemonInfo = parseDaemonManifest(JSON.parse(raw));
    if (daemonInfo === undefined) {
      return undefined;
    }
    return isTrustedDaemonManifest(daemonInfo, stat.mode, options) ? daemonInfo : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        FS.closeSync(fd);
      } catch {
        // Ignore close failures while reading daemon manifest state.
      }
    }
  }
};
