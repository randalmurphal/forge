/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/unstable/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import path from "node:path";
import { randomUUID } from "node:crypto";

import { Effect, Layer, FileSystem, Path } from "effect";

import { CheckpointInvariantError } from "../Errors.ts";
import { GitCommandError } from "@forgetools/contracts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@forgetools/contracts";

function normalizeRelativeGitPath(value: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (trimmed.length === 0) {
    return null;
  }

  const normalized = path.posix.normalize(trimmed).replace(/^\.\/+/, "");
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

function splitNullSeparatedPaths(value: string): string[] {
  return value
    .split("\0")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitCore;

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.code === 0));

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    git
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.captureCheckpoint";

    yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "forge-fs-checkpoint-" }),
      Effect.fn("captureCheckpoint.withTempDirectory")(function* (tempDir) {
        const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
        const commitEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_INDEX_FILE: tempIndexPath,
          GIT_AUTHOR_NAME: "Forge",
          GIT_AUTHOR_EMAIL: "forge@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Forge",
          GIT_COMMITTER_EMAIL: "forge@users.noreply.github.com",
        };

        const headExists = yield* hasHeadCommit(input.cwd);
        if (headExists) {
          yield* git.execute({
            operation,
            cwd: input.cwd,
            args: ["read-tree", "HEAD"],
            env: commitEnv,
          });
        }

        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["add", "-A", "--", "."],
          env: commitEnv,
        });

        const writeTreeResult = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new GitCommandError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        const message = `forge checkpoint ref=${input.checkpointRef}`;
        const commitTreeResult = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["commit-tree", treeOid, "-m", message],
          env: commitEnv,
        });
        const commitOid = commitTreeResult.stdout.trim();
        if (commitOid.length === 0) {
          return yield* new GitCommandError({
            operation,
            command: "git commit-tree",
            cwd: input.cwd,
            detail: "git commit-tree returned an empty commit oid.",
          });
        }

        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", input.checkpointRef, commitOid],
        });
      }),
      (tempDir) => fs.remove(tempDir, { recursive: true }),
    ).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.fail(
            new CheckpointInvariantError({
              operation: "CheckpointStore.captureCheckpoint",
              detail: "Failed to capture checkpoint.",
              cause: error,
            }),
          ),
      }),
    );
  });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.restoreCheckpoint";

    let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

    if (!commitOid && input.fallbackToHead === true) {
      commitOid = yield* resolveHeadCommit(input.cwd);
    }

    if (!commitOid) {
      return false;
    }

    yield* git.execute({
      operation,
      cwd: input.cwd,
      args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
    });
    yield* git.execute({
      operation,
      cwd: input.cwd,
      args: ["clean", "-fd", "--", "."],
    });

    const headExists = yield* hasHeadCommit(input.cwd);
    if (headExists) {
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["reset", "--quiet", "--", "."],
      });
    }

    return true;
  });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = Effect.fn("diffCheckpoints")(
    function* (input) {
      const operation = "CheckpointStore.diffCheckpoints";

      let fromCommitOid = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      const toCommitOid = yield* resolveCheckpointCommit(input.cwd, input.toCheckpointRef);

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const result = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["diff", "--patch", "--minimal", "--no-color", fromCommitOid, toCommitOid],
      });

      return result.stdout;
    },
  );

  const diffCheckpointToWorkspace: CheckpointStoreShape["diffCheckpointToWorkspace"] = Effect.fn(
    "diffCheckpointToWorkspace",
  )(function* (input) {
    const operation = "CheckpointStore.diffCheckpointToWorkspace";
    const checkpointCommitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

    if (!checkpointCommitOid) {
      return yield* new GitCommandError({
        operation,
        command: "git diff",
        cwd: input.cwd,
        detail: "Checkpoint ref is unavailable for diff operation.",
      });
    }

    const relativePaths = [
      ...new Set(input.paths.map(normalizeRelativeGitPath).filter(Boolean)),
    ].toSorted() as string[];
    if (relativePaths.length === 0) {
      return "";
    }

    const trackedDiffResult = yield* git.execute({
      operation,
      cwd: input.cwd,
      args: [
        "diff",
        "--patch",
        "--minimal",
        "--no-color",
        checkpointCommitOid,
        "--",
        ...relativePaths,
      ],
    });

    const untrackedPathsResult = yield* git.execute({
      operation,
      cwd: input.cwd,
      args: ["ls-files", "--others", "--exclude-standard", "-z", "--", ...relativePaths],
      allowNonZeroExit: true,
    });
    const untrackedPaths =
      untrackedPathsResult.code === 0 ? splitNullSeparatedPaths(untrackedPathsResult.stdout) : [];

    const untrackedDiffs = yield* Effect.forEach(
      untrackedPaths,
      (relativePath) =>
        git
          .execute({
            operation,
            cwd: input.cwd,
            args: [
              "diff",
              "--no-index",
              "--patch",
              "--minimal",
              "--no-color",
              "--",
              "/dev/null",
              relativePath,
            ],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.flatMap((result) =>
              result.code === 0 || result.code === 1
                ? Effect.succeed(result.stdout.trim())
                : Effect.fail(
                    new GitCommandError({
                      operation,
                      command: "git diff --no-index",
                      cwd: input.cwd,
                      detail:
                        result.stderr.trim().length > 0
                          ? result.stderr.trim()
                          : `git diff for untracked file '${relativePath}' failed`,
                    }),
                  ),
            ),
          ),
      { concurrency: 4 },
    );

    return [trackedDiffResult.stdout.trim(), ...untrackedDiffs]
      .filter((chunk) => chunk.length > 0)
      .join("\n\n");
  });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const operation = "CheckpointStore.deleteCheckpointRefs";

    yield* Effect.forEach(
      input.checkpointRefs,
      (checkpointRef) =>
        git.execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", "-d", checkpointRef],
          allowNonZeroExit: true,
        }),
      { discard: true },
    );
  });

  return {
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    diffCheckpointToWorkspace,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
