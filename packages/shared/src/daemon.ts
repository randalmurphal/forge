export const OWNER_ONLY_FILE_MODE = 0o600;

export interface DaemonManifestLike {
  readonly socketPath: string;
}

export const hasOwnerOnlyFileMode = (mode: number): boolean =>
  (mode & 0o777) === OWNER_ONLY_FILE_MODE;

export const hasExpectedDaemonSocketPath = (
  manifest: DaemonManifestLike,
  expectedSocketPath: string,
): boolean => manifest.socketPath === expectedSocketPath;
