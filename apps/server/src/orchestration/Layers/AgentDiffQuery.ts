import {
  type OrchestrationCheckpointFile,
  OrchestrationGetFullThreadAgentDiffResult,
  OrchestrationGetTurnAgentDiffResult,
  type ThreadId,
} from "@forgetools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ProjectionAgentDiffRepository } from "../../persistence/Services/ProjectionAgentDiffs.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../Services/ProjectionSnapshotQuery.ts";
import { AgentDiffQuery, type AgentDiffQueryShape } from "../Services/AgentDiffQuery.ts";

const isTurnAgentDiffResult = Schema.is(OrchestrationGetTurnAgentDiffResult);
const isFullThreadAgentDiffResult = Schema.is(OrchestrationGetFullThreadAgentDiffResult);

const make = Effect.gen(function* () {
  const projectionAgentDiffRepository = yield* ProjectionAgentDiffRepository;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const getTurnAgentDiff: AgentDiffQueryShape["getTurnAgentDiff"] = Effect.fn("getTurnAgentDiff")(
    function* (input) {
      const row = yield* projectionAgentDiffRepository.getByTurnId(input);
      if (Option.isNone(row)) {
        return {
          threadId: input.threadId,
          turnId: input.turnId,
          diff: "",
          files: [],
          source: "derived_tool_results",
          coverage: "unavailable",
          completedAt: new Date(0).toISOString(),
        } satisfies OrchestrationGetTurnAgentDiffResult;
      }

      const result = {
        threadId: row.value.threadId,
        turnId: row.value.turnId,
        diff: row.value.diff,
        files: row.value.files,
        source: row.value.source,
        coverage: row.value.coverage,
        completedAt: row.value.completedAt,
      } satisfies OrchestrationGetTurnAgentDiffResult;

      if (!isTurnAgentDiffResult(result)) {
        throw new Error("Computed turn agent diff result does not satisfy contract schema.");
      }
      return result;
    },
  );

  const tryGetCheckpointBackedThreadDiff = (input: {
    readonly threadId: ThreadId;
    readonly checkpointContext: Option.Option<ProjectionThreadCheckpointContext>;
  }) =>
    Effect.gen(function* () {
      if (Option.isNone(input.checkpointContext)) {
        return Option.none<OrchestrationGetFullThreadAgentDiffResult>();
      }

      const latestCheckpoint = [...input.checkpointContext.value.checkpoints]
        .filter((checkpoint) => checkpoint.status === "ready")
        .toSorted((left, right) => right.checkpointTurnCount - left.checkpointTurnCount)[0];
      const workspaceCwd =
        input.checkpointContext.value.worktreePath ?? input.checkpointContext.value.workspaceRoot;
      if (!latestCheckpoint || !workspaceCwd) {
        return Option.none<OrchestrationGetFullThreadAgentDiffResult>();
      }

      const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, 0);
      const [fromExists, toExists] = yield* Effect.all([
        checkpointStore.hasCheckpointRef({
          cwd: workspaceCwd,
          checkpointRef: fromCheckpointRef,
        }),
        checkpointStore.hasCheckpointRef({
          cwd: workspaceCwd,
          checkpointRef: latestCheckpoint.checkpointRef,
        }),
      ]);
      if (!fromExists || !toExists) {
        return Option.none<OrchestrationGetFullThreadAgentDiffResult>();
      }

      const diff = yield* checkpointStore.diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef: latestCheckpoint.checkpointRef,
        fallbackFromToHead: false,
      });
      const result = {
        threadId: input.threadId,
        diff,
        files: parseTurnDiffFilesFromUnifiedDiff(diff).map(
          (file): OrchestrationCheckpointFile => ({
            path: file.path,
            kind: "modified",
            additions: file.additions,
            deletions: file.deletions,
          }),
        ),
        coverage: "complete",
      } satisfies OrchestrationGetFullThreadAgentDiffResult;

      if (!isFullThreadAgentDiffResult(result)) {
        throw new Error("Computed full thread agent diff result does not satisfy contract schema.");
      }
      return Option.some(result);
    }).pipe(Effect.catch(() => Effect.succeed(Option.none())));

  const getFullThreadAgentDiff: AgentDiffQueryShape["getFullThreadAgentDiff"] = Effect.fn(
    "getFullThreadAgentDiff",
  )(function* (input) {
    const [turns, agentDiffs] = yield* Effect.all([
      projectionTurnRepository.listByThreadId({ threadId: input.threadId }),
      projectionAgentDiffRepository.listByThreadId({ threadId: input.threadId }),
    ]);

    const agentDiffByTurnId = new Map(agentDiffs.map((row) => [row.turnId, row] as const));
    // Turn rows are still loaded here because the checkpoint-backed net diff path
    // depends on thread checkpoint context even when full-thread agent diff rows
    // exist. Without a valid checkpoint comparison, we intentionally report the
    // net diff as unavailable rather than concatenating historical turn patches.
    void turns;
    void agentDiffByTurnId;

    const checkpointContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(
      input.threadId,
    );
    const parentResult = yield* tryGetCheckpointBackedThreadDiff({
      threadId: input.threadId,
      checkpointContext,
    });

    // Query child thread IDs for aggregation
    const childThreadIds = yield* projectionThreadRepository
      .getChildThreadIds({ parentThreadId: input.threadId })
      .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<ThreadId>>([])));

    // If no children, return parent result as-is (preserves original behavior)
    if (childThreadIds.length === 0) {
      if (Option.isSome(parentResult)) {
        return parentResult.value;
      }

      const result = {
        threadId: input.threadId,
        diff: "",
        files: [],
        coverage: "unavailable",
      } satisfies OrchestrationGetFullThreadAgentDiffResult;

      if (!isFullThreadAgentDiffResult(result)) {
        throw new Error("Computed full thread agent diff result does not satisfy contract schema.");
      }
      return result;
    }

    // Aggregate child thread diffs (limit to 20 for safety)
    const childIdsToQuery = childThreadIds.slice(0, 20);
    const childDiffResults = yield* Effect.all(
      childIdsToQuery.map((childThreadId) =>
        Effect.gen(function* () {
          const childCheckpointContext = yield* projectionSnapshotQuery
            .getThreadCheckpointContext(childThreadId)
            .pipe(
              Effect.catch(() => Effect.succeed(Option.none<ProjectionThreadCheckpointContext>())),
            );
          if (Option.isNone(childCheckpointContext)) {
            return Option.none<OrchestrationGetFullThreadAgentDiffResult>();
          }
          return yield* tryGetCheckpointBackedThreadDiff({
            threadId: childThreadId,
            checkpointContext: childCheckpointContext,
          });
        }),
      ),
      { concurrency: 5 },
    );

    // Combine parent + child diffs
    const allDiffs: string[] = [];
    const allFiles: OrchestrationCheckpointFile[] = [];

    if (Option.isSome(parentResult)) {
      if (parentResult.value.diff) allDiffs.push(parentResult.value.diff);
      allFiles.push(...parentResult.value.files);
    }

    for (const childResult of childDiffResults) {
      if (Option.isSome(childResult)) {
        if (childResult.value.diff) allDiffs.push(childResult.value.diff);
        allFiles.push(...childResult.value.files);
      }
    }

    if (allDiffs.length === 0) {
      const result = {
        threadId: input.threadId,
        diff: "",
        files: [],
        coverage: "unavailable",
      } satisfies OrchestrationGetFullThreadAgentDiffResult;

      if (!isFullThreadAgentDiffResult(result)) {
        throw new Error("Computed full thread agent diff result does not satisfy contract schema.");
      }
      return result;
    }

    // Deduplicate files by path, summing additions/deletions for the same path
    const filesByPath = new Map<string, OrchestrationCheckpointFile>();
    for (const file of allFiles) {
      const existing = filesByPath.get(file.path);
      if (existing) {
        filesByPath.set(file.path, {
          ...file,
          additions: ((existing.additions ?? 0) + (file.additions ?? 0)) as typeof file.additions,
          deletions: ((existing.deletions ?? 0) + (file.deletions ?? 0)) as typeof file.deletions,
        });
      } else {
        filesByPath.set(file.path, file);
      }
    }

    const result = {
      threadId: input.threadId,
      diff: allDiffs.join("\n"),
      files: [...filesByPath.values()],
      coverage: "complete",
    } satisfies OrchestrationGetFullThreadAgentDiffResult;

    if (!isFullThreadAgentDiffResult(result)) {
      throw new Error("Computed full thread agent diff result does not satisfy contract schema.");
    }
    return result;
  });

  return {
    getTurnAgentDiff,
    getFullThreadAgentDiff,
  } satisfies AgentDiffQueryShape;
});

export const AgentDiffQueryLive = Layer.effect(AgentDiffQuery, make);
