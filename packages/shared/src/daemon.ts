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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const hasOwnerOnlyFileMode = (mode: number): boolean =>
  (mode & 0o777) === OWNER_ONLY_FILE_MODE;

export const hasExpectedDaemonSocketPath = (
  manifest: DaemonManifestLike,
  expectedSocketPath: string,
): boolean => manifest.socketPath === expectedSocketPath;

export const shouldRequireOwnerOnlyPermissions = (options?: DaemonManifestTrustOptions): boolean =>
  (options?.requireOwnerOnlyPermissions ?? true) &&
  (options?.platform ?? process.platform) !== "win32";

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
