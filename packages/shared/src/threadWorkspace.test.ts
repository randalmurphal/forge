import { describe, expect, it } from "vitest";

import { resolveThreadSpawnMode, resolveThreadSpawnWorkspace } from "./threadWorkspace";

describe("resolveThreadSpawnWorkspace", () => {
  it("prefers immutable spawn workspace fields when present", () => {
    expect(
      resolveThreadSpawnWorkspace({
        branch: "feature/current",
        worktreePath: "/tmp/current",
        spawnBranch: "feature/original",
        spawnWorktreePath: "/tmp/original",
      }),
    ).toEqual({
      mode: "worktree",
      branch: "feature/original",
      worktreePath: "/tmp/original",
    });
  });

  it("falls back to the current workspace when no spawn snapshot is available", () => {
    expect(
      resolveThreadSpawnWorkspace({
        branch: "feature/current",
        worktreePath: "/tmp/current",
      }),
    ).toEqual({
      mode: "worktree",
      branch: "feature/current",
      worktreePath: "/tmp/current",
    });
  });

  it("keeps an explicit local spawn mode on a branch in the main workspace", () => {
    expect(
      resolveThreadSpawnWorkspace({
        branch: "main",
        worktreePath: null,
        spawnMode: "local",
      }),
    ).toEqual({
      mode: "local",
      branch: "main",
      worktreePath: null,
    });
  });

  it("preserves explicit null spawn snapshots instead of falling back to the current workspace", () => {
    expect(
      resolveThreadSpawnWorkspace({
        branch: "feature/current",
        worktreePath: "/tmp/current",
        spawnBranch: null,
        spawnWorktreePath: null,
      }),
    ).toEqual({
      mode: "local",
      branch: null,
      worktreePath: null,
    });
  });

  it("keeps an explicit worktree spawn mode before the worktree path exists", () => {
    expect(
      resolveThreadSpawnWorkspace({
        branch: "forge/thread-123",
        worktreePath: null,
        spawnMode: "worktree",
      }),
    ).toEqual({
      mode: "worktree",
      branch: "forge/thread-123",
      worktreePath: null,
    });
  });
});

describe("resolveThreadSpawnMode", () => {
  it("returns local when no worktree path exists", () => {
    expect(
      resolveThreadSpawnMode({
        branch: "main",
        worktreePath: null,
      }),
    ).toBe("local");
  });
});
