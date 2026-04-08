import {
  type OrchestrationAgentDiffCoverage,
  type OrchestrationCheckpointFile,
  OrchestrationGetFullThreadAgentDiffResult,
  OrchestrationGetTurnAgentDiffResult,
} from "@forgetools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionAgentDiffRepository } from "../../persistence/Services/ProjectionAgentDiffs.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { AgentDiffQuery, type AgentDiffQueryShape } from "../Services/AgentDiffQuery.ts";

function mergeFileSummaries(
  rows: ReadonlyArray<ReadonlyArray<OrchestrationCheckpointFile>>,
): ReadonlyArray<OrchestrationCheckpointFile> {
  const files = new Map<string, OrchestrationCheckpointFile>();
  for (const row of rows) {
    for (const file of row) {
      const existing = files.get(file.path);
      if (existing) {
        files.set(file.path, {
          ...existing,
          additions: existing.additions + file.additions,
          deletions: existing.deletions + file.deletions,
        });
        continue;
      }
      files.set(file.path, file);
    }
  }
  return Array.from(files.values()).toSorted((left, right) => left.path.localeCompare(right.path));
}

function mergeCoverage(
  coverages: ReadonlyArray<OrchestrationAgentDiffCoverage>,
): OrchestrationAgentDiffCoverage {
  if (coverages.length === 0) {
    return "unavailable";
  }
  if (coverages.every((coverage) => coverage === "unavailable")) {
    return "unavailable";
  }
  if (coverages.some((coverage) => coverage === "partial")) {
    return "partial";
  }
  if (coverages.every((coverage) => coverage === "complete")) {
    return "complete";
  }
  return "partial";
}

const isTurnAgentDiffResult = Schema.is(OrchestrationGetTurnAgentDiffResult);
const isFullThreadAgentDiffResult = Schema.is(OrchestrationGetFullThreadAgentDiffResult);

const make = Effect.gen(function* () {
  const projectionAgentDiffRepository = yield* ProjectionAgentDiffRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

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

  const getFullThreadAgentDiff: AgentDiffQueryShape["getFullThreadAgentDiff"] = Effect.fn(
    "getFullThreadAgentDiff",
  )(function* (input) {
    const [turns, agentDiffs] = yield* Effect.all([
      projectionTurnRepository.listByThreadId({ threadId: input.threadId }),
      projectionAgentDiffRepository.listByThreadId({ threadId: input.threadId }),
    ]);

    const agentDiffByTurnId = new Map(agentDiffs.map((row) => [row.turnId, row] as const));
    // Preserve the canonical turn order from projection_turns. Agent diff rows can
    // be backfilled or replayed after the turn completed, so completedAt alone is
    // not stable enough to reconstruct the conversation-wide patch ordering.
    const orderedRows = turns
      .filter((turn) => turn.turnId !== null)
      .map((turn) => (turn.turnId === null ? null : (agentDiffByTurnId.get(turn.turnId) ?? null)))
      .filter((row) => row !== null);

    const uniqueRows = Array.from(
      new Map(orderedRows.map((row) => [row.turnId, row] as const)).values(),
    );
    const result = {
      threadId: input.threadId,
      diff: uniqueRows
        .map((row) => row.diff.trim())
        .filter((diff) => diff.length > 0)
        .join("\n\n"),
      files: mergeFileSummaries(uniqueRows.map((row) => row.files)),
      coverage: mergeCoverage(uniqueRows.map((row) => row.coverage)),
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
