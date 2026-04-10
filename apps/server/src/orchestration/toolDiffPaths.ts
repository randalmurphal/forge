import path from "node:path";

const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const WINDOWS_WSL_UNC_PATH_PATTERN = /^\\\\wsl(?:\.localhost)?\\([^\\]+)\\(.+)$/i;

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeSafeRelativePath(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    WINDOWS_DRIVE_PATH_PATTERN.test(trimmed) ||
    WINDOWS_WSL_UNC_PATH_PATTERN.test(trimmed)
  ) {
    return null;
  }

  const normalized = path.posix.normalize(toPosixPath(trimmed)).replace(/^\.\/+/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }

  return normalized;
}

function toPosixAbsoluteWorkspacePath(rawPath: string, wslDistroName?: string): string | null {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const uncMatch = WINDOWS_WSL_UNC_PATH_PATTERN.exec(trimmed);
  if (uncMatch) {
    const distroName = uncMatch[1];
    const uncRest = uncMatch[2];
    if (
      typeof distroName === "string" &&
      typeof uncRest === "string" &&
      (wslDistroName === undefined || distroName.toLowerCase() === wslDistroName.toLowerCase())
    ) {
      return path.posix.resolve(`/${toPosixPath(uncRest).replace(/^\/+/, "")}`);
    }
  }

  const driveMatch = /^([a-zA-Z]):[\\/](.*)$/.exec(trimmed);
  if (driveMatch) {
    const [, driveLetter, driveRest] = driveMatch;
    return path.posix.resolve(`/mnt/${driveLetter!.toLowerCase()}/${toPosixPath(driveRest ?? "")}`);
  }

  const posixCandidate = toPosixPath(trimmed);
  if (path.posix.isAbsolute(posixCandidate)) {
    return path.posix.resolve(posixCandidate);
  }

  return null;
}

export function classifyToolDiffPaths(input: {
  readonly workspaceRoot: string;
  readonly filePaths: ReadonlyArray<string>;
  readonly wslDistroName?: string;
}): {
  readonly repoRelativePaths: ReadonlyArray<string>;
  readonly outOfRepoPaths: ReadonlyArray<string>;
} {
  const repoRelativePaths = new Set<string>();
  const outOfRepoPaths = new Set<string>();
  const workspaceRootIsWindows =
    WINDOWS_DRIVE_PATH_PATTERN.test(input.workspaceRoot) ||
    WINDOWS_WSL_UNC_PATH_PATTERN.test(input.workspaceRoot) ||
    input.workspaceRoot.startsWith("\\\\");
  const normalizedWindowsWorkspaceRoot = workspaceRootIsWindows
    ? path.win32.resolve(input.workspaceRoot)
    : null;
  const normalizedPosixWorkspaceRoot = workspaceRootIsWindows
    ? null
    : path.posix.resolve(toPosixPath(input.workspaceRoot));

  for (const rawPath of input.filePaths) {
    const normalizedRelativePath = normalizeSafeRelativePath(rawPath);
    if (normalizedRelativePath) {
      repoRelativePaths.add(normalizedRelativePath);
      continue;
    }

    if (workspaceRootIsWindows && normalizedWindowsWorkspaceRoot) {
      if (!path.win32.isAbsolute(rawPath)) {
        outOfRepoPaths.add(rawPath);
        continue;
      }
      const relativePath = toPosixPath(
        path.win32.relative(normalizedWindowsWorkspaceRoot, path.win32.resolve(rawPath)),
      );
      const safeRelativePath = normalizeSafeRelativePath(relativePath);
      if (safeRelativePath) {
        repoRelativePaths.add(safeRelativePath);
      } else {
        outOfRepoPaths.add(rawPath);
      }
      continue;
    }

    if (!normalizedPosixWorkspaceRoot) {
      outOfRepoPaths.add(rawPath);
      continue;
    }

    const candidateAbsolutePath = toPosixAbsoluteWorkspacePath(rawPath, input.wslDistroName);
    if (!candidateAbsolutePath) {
      outOfRepoPaths.add(rawPath);
      continue;
    }

    const relativePath = path.posix.relative(normalizedPosixWorkspaceRoot, candidateAbsolutePath);
    const safeRelativePath = normalizeSafeRelativePath(relativePath);
    if (safeRelativePath) {
      repoRelativePaths.add(safeRelativePath);
    } else {
      outOfRepoPaths.add(rawPath);
    }
  }

  return {
    repoRelativePaths: [...repoRelativePaths].toSorted(),
    outOfRepoPaths: [...outOfRepoPaths].toSorted(),
  };
}

function splitUnifiedDiffIntoFileChunks(diff: string): ReadonlyArray<string> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }
  if (!/^diff --git /m.test(normalized)) {
    return [normalized];
  }
  return normalized
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

function extractUnifiedDiffChunkPath(chunk: string): string | null {
  for (const line of chunk.split("\n")) {
    const diffGitMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffGitMatch) {
      return diffGitMatch[2] ?? diffGitMatch[1] ?? null;
    }

    const plusPlusPlusMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusPlusPlusMatch) {
      return plusPlusPlusMatch[1] ?? null;
    }

    const minusMinusMinusMatch = /^--- a\/(.+)$/.exec(line);
    if (minusMinusMinusMatch) {
      return minusMinusMinusMatch[1] ?? null;
    }
  }

  return null;
}

export function filterUnifiedDiffByPaths(input: {
  readonly diff: string | undefined;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly workspaceRoot: string;
  readonly wslDistroName?: string;
}): string | undefined {
  const normalized = input.diff?.trim();
  if (!normalized) {
    return undefined;
  }

  const allowedPathSet = new Set(input.allowedPaths);
  if (allowedPathSet.size === 0) {
    return undefined;
  }

  const filteredChunks = splitUnifiedDiffIntoFileChunks(normalized).filter((chunk) => {
    const chunkPath = extractUnifiedDiffChunkPath(chunk);
    if (chunkPath === null) {
      return false;
    }

    const normalizedChunkPath = classifyToolDiffPaths({
      workspaceRoot: input.workspaceRoot,
      filePaths: [chunkPath],
      ...(input.wslDistroName ? { wslDistroName: input.wslDistroName } : {}),
    }).repoRelativePaths[0];

    return normalizedChunkPath !== undefined && allowedPathSet.has(normalizedChunkPath);
  });

  if (filteredChunks.length === 0) {
    return undefined;
  }

  return filteredChunks.join("\n\n");
}
