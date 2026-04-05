import { PhaseRunId, ThreadId, WorkflowId, WorkflowPhaseId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { ProjectionPhaseRunRepository } from "../Services/ProjectionPhaseRuns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionPhaseRunRepositoryLive } from "./ProjectionPhaseRuns.ts";

const layer = it.layer(
  ProjectionPhaseRunRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionPhaseRunRepository", (it) => {
  it.effect("stores and queries phase runs by id and thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPhaseRunRepository;

      yield* repository.upsert({
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
        threadId: ThreadId.makeUnsafe("thread-phase-run"),
        workflowId: WorkflowId.makeUnsafe("workflow-implement"),
        phaseId: WorkflowPhaseId.makeUnsafe("phase-plan"),
        phaseName: "plan",
        phaseType: "single-agent",
        sandboxMode: "workspace-write",
        iteration: 1 as any,
        status: "running",
        gateResult: null,
        qualityChecks: null,
        deliberationState: null,
        startedAt: "2026-04-05T12:00:00.000Z",
        completedAt: null,
      });

      yield* repository.upsert({
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-review"),
        threadId: ThreadId.makeUnsafe("thread-phase-run"),
        workflowId: WorkflowId.makeUnsafe("workflow-implement"),
        phaseId: WorkflowPhaseId.makeUnsafe("phase-review"),
        phaseName: "review",
        phaseType: "multi-agent",
        sandboxMode: "read-only",
        iteration: 2 as any,
        status: "completed",
        gateResult: {
          status: "passed",
          qualityCheckResults: [{ check: "typecheck", passed: true }],
          evaluatedAt: "2026-04-05T12:20:00.000Z",
        },
        qualityChecks: [{ check: "typecheck", passed: true, output: "ok" }],
        deliberationState: {
          strategy: "ping-pong",
          currentSpeaker: null,
          turnCount: 2 as any,
          maxTurns: 6 as any,
          conclusionProposals: {
            reviewer: "Ship it",
          },
          concluded: true,
          lastPostTimestamp: {
            reviewer: "2026-04-05T12:18:00.000Z",
          },
          nudgeCount: {
            reviewer: 0 as any,
          },
          maxNudges: 3 as any,
          stallTimeoutMs: 120000 as any,
        },
        startedAt: "2026-04-05T12:10:00.000Z",
        completedAt: "2026-04-05T12:20:00.000Z",
      });

      const byId = yield* repository.queryById({
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-review"),
      });
      assert.deepStrictEqual(Option.getOrNull(byId), {
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-review"),
        threadId: ThreadId.makeUnsafe("thread-phase-run"),
        workflowId: WorkflowId.makeUnsafe("workflow-implement"),
        phaseId: WorkflowPhaseId.makeUnsafe("phase-review"),
        phaseName: "review",
        phaseType: "multi-agent",
        sandboxMode: "read-only",
        iteration: 2,
        status: "completed",
        gateResult: {
          status: "passed",
          qualityCheckResults: [{ check: "typecheck", passed: true }],
          evaluatedAt: "2026-04-05T12:20:00.000Z",
        },
        qualityChecks: [{ check: "typecheck", passed: true, output: "ok" }],
        deliberationState: {
          strategy: "ping-pong",
          currentSpeaker: null,
          turnCount: 2,
          maxTurns: 6,
          conclusionProposals: {
            reviewer: "Ship it",
          },
          concluded: true,
          lastPostTimestamp: {
            reviewer: "2026-04-05T12:18:00.000Z",
          },
          nudgeCount: {
            reviewer: 0,
          },
          maxNudges: 3,
          stallTimeoutMs: 120000,
        },
        startedAt: "2026-04-05T12:10:00.000Z",
        completedAt: "2026-04-05T12:20:00.000Z",
      });

      const byThreadId = yield* repository.queryByThreadId({
        threadId: ThreadId.makeUnsafe("thread-phase-run"),
      });
      const relevantRuns = byThreadId.filter(
        (phaseRun) =>
          phaseRun.phaseRunId === "phase-run-plan" || phaseRun.phaseRunId === "phase-run-review",
      );
      assert.deepStrictEqual(
        relevantRuns.map((phaseRun) => phaseRun.phaseRunId),
        [PhaseRunId.makeUnsafe("phase-run-plan"), PhaseRunId.makeUnsafe("phase-run-review")],
      );
    }),
  );

  it.effect("updates phase-run status while preserving omitted materialized fields", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPhaseRunRepository;

      yield* repository.upsert({
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-status"),
        threadId: ThreadId.makeUnsafe("thread-phase-status"),
        workflowId: WorkflowId.makeUnsafe("workflow-status"),
        phaseId: WorkflowPhaseId.makeUnsafe("phase-status"),
        phaseName: "implement",
        phaseType: "single-agent",
        sandboxMode: "workspace-write",
        iteration: 1 as any,
        status: "pending",
        gateResult: null,
        qualityChecks: null,
        deliberationState: {
          strategy: "ping-pong",
          currentSpeaker: ThreadId.makeUnsafe("thread-child-1"),
          turnCount: 1 as any,
          maxTurns: 4 as any,
          conclusionProposals: {},
          concluded: false,
          lastPostTimestamp: {
            "thread-child-1": "2026-04-05T13:00:00.000Z",
          },
          nudgeCount: {
            "thread-child-1": 1 as any,
          },
          maxNudges: 3 as any,
          stallTimeoutMs: 120000 as any,
        },
        startedAt: null,
        completedAt: null,
      });

      yield* repository.updateStatus({
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-status"),
        status: "running",
        startedAt: "2026-04-05T13:05:00.000Z",
      });

      yield* repository.updateStatus({
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-status"),
        status: "completed",
        gateResult: {
          status: "passed",
          humanDecision: "approve",
          evaluatedAt: "2026-04-05T13:20:00.000Z",
        },
        qualityChecks: [{ check: "lint", passed: true, output: "clean" }],
        completedAt: "2026-04-05T13:20:00.000Z",
      });

      const persisted = yield* repository.queryById({
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-status"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted), {
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-status"),
        threadId: ThreadId.makeUnsafe("thread-phase-status"),
        workflowId: WorkflowId.makeUnsafe("workflow-status"),
        phaseId: WorkflowPhaseId.makeUnsafe("phase-status"),
        phaseName: "implement",
        phaseType: "single-agent",
        sandboxMode: "workspace-write",
        iteration: 1,
        status: "completed",
        gateResult: {
          status: "passed",
          humanDecision: "approve",
          evaluatedAt: "2026-04-05T13:20:00.000Z",
        },
        qualityChecks: [{ check: "lint", passed: true, output: "clean" }],
        deliberationState: {
          strategy: "ping-pong",
          currentSpeaker: ThreadId.makeUnsafe("thread-child-1"),
          turnCount: 1,
          maxTurns: 4,
          conclusionProposals: {},
          concluded: false,
          lastPostTimestamp: {
            "thread-child-1": "2026-04-05T13:00:00.000Z",
          },
          nudgeCount: {
            "thread-child-1": 1,
          },
          maxNudges: 3,
          stallTimeoutMs: 120000,
        },
        startedAt: "2026-04-05T13:05:00.000Z",
        completedAt: "2026-04-05T13:20:00.000Z",
      });
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored gate result json is invalid", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPhaseRunRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO phase_runs (
          phase_run_id,
          thread_id,
          workflow_id,
          phase_id,
          phase_name,
          phase_type,
          sandbox_mode,
          iteration,
          status,
          gate_result_json,
          quality_checks_json,
          deliberation_state_json,
          started_at,
          completed_at
        )
        VALUES (
          ${PhaseRunId.makeUnsafe("phase-run-invalid-json")},
          ${ThreadId.makeUnsafe("thread-invalid-json")},
          ${WorkflowId.makeUnsafe("workflow-invalid-json")},
          ${WorkflowPhaseId.makeUnsafe("phase-invalid-json")},
          ${"review"},
          ${"single-agent"},
          ${"workspace-write"},
          ${1},
          ${"failed"},
          ${"{"},
          ${null},
          ${null},
          ${"2026-04-05T18:10:00.000Z"},
          ${null}
        )
      `;

      const result = yield* Effect.result(
        repository.queryById({
          phaseRunId: PhaseRunId.makeUnsafe("phase-run-invalid-json"),
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(result.failure));
        assert.ok(
          result.failure.operation.includes("ProjectionPhaseRunRepository.queryById:decodeRow"),
        );
      }
    }),
  );
});
