import { ProjectId, ThreadId, TurnId } from "@forgetools/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import {
  ProjectionAgentDiffRepository,
  type ProjectionAgentDiffRepositoryShape,
} from "../../persistence/Services/ProjectionAgentDiffs.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../../persistence/Services/ProjectionThreads.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../../persistence/Services/ProjectionTurns.ts";
import { AgentDiffQueryLive } from "./AgentDiffQuery.ts";
import { AgentDiffQuery } from "../Services/AgentDiffQuery.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

describe("AgentDiffQueryLive", () => {
  it("uses the checkpoint-backed net diff for full-thread queries when available", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const projectId = ProjectId.makeUnsafe("project-1");
    const latestCheckpointRef = checkpointRefForThreadTurn(threadId, 2);
    const diff = [
      "diff --git a/src/kept.ts b/src/kept.ts",
      "--- a/src/kept.ts",
      "+++ b/src/kept.ts",
      "@@ -1 +1,2 @@",
      " export const kept = true;",
      "+export const stillHere = true;",
      "",
    ].join("\n");

    const projectionTurnRepository: ProjectionTurnRepositoryShape = {
      upsertByTurnId: () => Effect.void,
      replacePendingTurnStart: () => Effect.void,
      getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
      deletePendingTurnStartByThreadId: () => Effect.void,
      listByThreadId: () =>
        Effect.succeed([
          {
            threadId,
            turnId: TurnId.makeUnsafe("turn-1"),
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "completed",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            checkpointTurnCount: 1,
            checkpointRef: checkpointRefForThreadTurn(threadId, 1),
            checkpointStatus: "ready",
            checkpointFiles: [],
          },
        ]),
      getByTurnId: () => Effect.succeed(Option.none()),
      clearCheckpointTurnConflict: () => Effect.void,
      deleteByThreadId: () => Effect.void,
    };

    const projectionAgentDiffRepository: ProjectionAgentDiffRepositoryShape = {
      upsert: () => Effect.void,
      listByThreadId: () =>
        Effect.succeed([
          {
            threadId,
            turnId: TurnId.makeUnsafe("turn-1"),
            diff: "diff --git a/src/created-then-deleted.ts b/src/created-then-deleted.ts\n+transient\n",
            files: [
              {
                path: "src/created-then-deleted.ts",
                kind: "modified",
                additions: 1,
                deletions: 0,
              },
            ],
            source: "native_turn_diff",
            coverage: "complete",
            assistantMessageId: null,
            completedAt: "2026-01-01T00:00:01.000Z",
          },
        ]),
      getByTurnId: () => Effect.succeed(Option.none()),
      deleteByThreadId: () => Effect.void,
    };

    const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
      getSnapshot: () => Effect.die("unused"),
      getCommandOutput: () => Effect.succeed(Option.none()),
      getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      getThreadCheckpointContext: () =>
        Effect.succeed(
          Option.some({
            threadId,
            projectId,
            workspaceRoot: "/tmp/workspace",
            worktreePath: null,
            checkpoints: [
              {
                turnId: TurnId.makeUnsafe("turn-2"),
                checkpointTurnCount: 2,
                checkpointRef: latestCheckpointRef,
                status: "ready",
                files: [],
                assistantMessageId: null,
                completedAt: "2026-01-01T00:00:02.000Z",
              },
            ],
          }),
        ),
    };

    const projectionThreadRepository: Pick<ProjectionThreadRepositoryShape, "getChildThreadIds"> = {
      getChildThreadIds: () => Effect.succeed([]),
    };

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(diff),
      diffCheckpointToWorkspace: () => Effect.succeed(diff),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = AgentDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(ProjectionTurnRepository, projectionTurnRepository)),
      Layer.provideMerge(
        Layer.succeed(ProjectionAgentDiffRepository, projectionAgentDiffRepository),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionThreadRepository,
          projectionThreadRepository as ProjectionThreadRepositoryShape,
        ),
      ),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery)),
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* AgentDiffQuery;
        return yield* query.getFullThreadAgentDiff({ threadId });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({
      threadId,
      diff,
      files: [{ path: "src/kept.ts", kind: "modified", additions: 1, deletions: 0 }],
      coverage: "complete",
    });
  });

  it("returns unavailable when no checkpoint-backed net diff is available", async () => {
    const threadId = ThreadId.makeUnsafe("thread-2");
    const turnId = TurnId.makeUnsafe("turn-1");

    const projectionTurnRepository: ProjectionTurnRepositoryShape = {
      upsertByTurnId: () => Effect.void,
      replacePendingTurnStart: () => Effect.void,
      getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
      deletePendingTurnStartByThreadId: () => Effect.void,
      listByThreadId: () =>
        Effect.succeed([
          {
            threadId,
            turnId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "completed",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          },
        ]),
      getByTurnId: () => Effect.succeed(Option.none()),
      clearCheckpointTurnConflict: () => Effect.void,
      deleteByThreadId: () => Effect.void,
    };

    const projectionAgentDiffRepository: ProjectionAgentDiffRepositoryShape = {
      upsert: () => Effect.void,
      listByThreadId: () =>
        Effect.succeed([
          {
            threadId,
            turnId,
            diff: "diff --git a/src/fallback.ts b/src/fallback.ts\n+fallback\n",
            files: [{ path: "src/fallback.ts", kind: "modified", additions: 1, deletions: 0 }],
            source: "native_turn_diff",
            coverage: "partial",
            assistantMessageId: null,
            completedAt: "2026-01-01T00:00:01.000Z",
          },
        ]),
      getByTurnId: () => Effect.succeed(Option.none()),
      deleteByThreadId: () => Effect.void,
    };

    const projectionSnapshotQuery: ProjectionSnapshotQueryShape = {
      getSnapshot: () => Effect.die("unused"),
      getCommandOutput: () => Effect.succeed(Option.none()),
      getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    };

    const projectionThreadRepository: Pick<ProjectionThreadRepositoryShape, "getChildThreadIds"> = {
      getChildThreadIds: () => Effect.succeed([]),
    };

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(false),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      diffCheckpointToWorkspace: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = AgentDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(ProjectionTurnRepository, projectionTurnRepository)),
      Layer.provideMerge(
        Layer.succeed(ProjectionAgentDiffRepository, projectionAgentDiffRepository),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionThreadRepository,
          projectionThreadRepository as ProjectionThreadRepositoryShape,
        ),
      ),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projectionSnapshotQuery)),
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* AgentDiffQuery;
        return yield* query.getFullThreadAgentDiff({ threadId });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({
      threadId,
      diff: "",
      files: [],
      coverage: "unavailable",
    });
  });
});
