export interface ThreadSpawnWorkspaceLike {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly spawnMode?: "local" | "worktree" | undefined;
  readonly spawnBranch?: string | null | undefined;
  readonly spawnWorktreePath?: string | null | undefined;
}

export interface ResolvedThreadSpawnWorkspace {
  readonly mode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export function resolveThreadSpawnMode(input: ThreadSpawnWorkspaceLike): "local" | "worktree" {
  if (input.spawnMode !== undefined) {
    return input.spawnMode;
  }

  const worktreePath =
    input.spawnWorktreePath !== undefined ? input.spawnWorktreePath : input.worktreePath;
  return worktreePath ? "worktree" : "local";
}

export function resolveThreadSpawnWorkspace(
  input: ThreadSpawnWorkspaceLike,
): ResolvedThreadSpawnWorkspace {
  const mode = resolveThreadSpawnMode(input);
  return {
    mode,
    branch: input.spawnBranch !== undefined ? input.spawnBranch : (input.branch ?? null),
    worktreePath:
      input.spawnWorktreePath !== undefined
        ? input.spawnWorktreePath
        : (input.worktreePath ?? null),
  };
}
