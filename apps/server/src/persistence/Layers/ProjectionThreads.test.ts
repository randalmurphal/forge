import {
  PhaseRunId,
  ProjectId,
  ThreadId,
  WorkflowId,
  WorkflowPhaseId,
} from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const workflowSnapshot = {
  id: WorkflowId.makeUnsafe("workflow-thread-projection"),
  name: "implement",
  description: "Thread workflow snapshot",
  projectId: null,
  phases: [
    {
      id: WorkflowPhaseId.makeUnsafe("phase-thread-projection"),
      name: "implement",
      type: "single-agent" as const,
      agent: {
        prompt: "Implement the requested change.",
        output: {
          type: "conversation" as const,
        },
      },
      sandboxMode: "workspace-write" as const,
      gate: {
        after: "done" as const,
        onFail: "stop" as const,
        maxRetries: 0,
      },
    },
  ],
  builtIn: false,
  createdAt: "2026-04-05T17:00:00.000Z",
  updatedAt: "2026-04-05T17:00:00.000Z",
};

layer("ProjectionThreadRepository", (it) => {
  it.effect("round-trips the additive thread extension columns", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;

      yield* repository.upsert({
        threadId: ThreadId.makeUnsafe("thread-projection-extended"),
        projectId: ProjectId.makeUnsafe("project-projection-extended"),
        title: "Extended thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: "feature/extended-thread",
        worktreePath: "/tmp/extended-thread",
        latestTurnId: null,
        createdAt: "2026-04-05T17:00:00.000Z",
        updatedAt: "2026-04-05T17:10:00.000Z",
        archivedAt: null,
        deletedAt: null,
        parentThreadId: ThreadId.makeUnsafe("thread-projection-parent"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-projection"),
        workflowId: WorkflowId.makeUnsafe("workflow-thread-projection"),
        workflowSnapshot,
        currentPhaseId: WorkflowPhaseId.makeUnsafe("phase-thread-projection"),
        patternId: "ping-pong-review",
        role: "reviewer",
        deliberationState: {
          strategy: "ping-pong",
          currentSpeaker: ThreadId.makeUnsafe("thread-projection-extended"),
          turnCount: 1,
          maxTurns: 4,
          conclusionProposals: {},
          concluded: false,
          lastPostTimestamp: {
            "thread-projection-extended": "2026-04-05T17:05:00.000Z",
          },
          nudgeCount: {
            "thread-projection-extended": 0,
          },
          maxNudges: 3,
          stallTimeoutMs: 120000,
        },
        bootstrapStatus: "running",
        completedAt: "2026-04-05T17:20:00.000Z",
        transcriptArchived: true,
      });

      const persisted = yield* repository.getById({
        threadId: ThreadId.makeUnsafe("thread-projection-extended"),
      });

      assert.deepStrictEqual(Option.getOrNull(persisted), {
        threadId: ThreadId.makeUnsafe("thread-projection-extended"),
        projectId: ProjectId.makeUnsafe("project-projection-extended"),
        title: "Extended thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: "feature/extended-thread",
        worktreePath: "/tmp/extended-thread",
        latestTurnId: null,
        createdAt: "2026-04-05T17:00:00.000Z",
        updatedAt: "2026-04-05T17:10:00.000Z",
        archivedAt: null,
        deletedAt: null,
        parentThreadId: ThreadId.makeUnsafe("thread-projection-parent"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-projection"),
        workflowId: WorkflowId.makeUnsafe("workflow-thread-projection"),
        workflowSnapshot,
        currentPhaseId: WorkflowPhaseId.makeUnsafe("phase-thread-projection"),
        patternId: "ping-pong-review",
        role: "reviewer",
        deliberationState: {
          strategy: "ping-pong",
          currentSpeaker: ThreadId.makeUnsafe("thread-projection-extended"),
          turnCount: 1,
          maxTurns: 4,
          conclusionProposals: {},
          concluded: false,
          lastPostTimestamp: {
            "thread-projection-extended": "2026-04-05T17:05:00.000Z",
          },
          nudgeCount: {
            "thread-projection-extended": 0,
          },
          maxNudges: 3,
          stallTimeoutMs: 120000,
        },
        bootstrapStatus: "running",
        completedAt: "2026-04-05T17:20:00.000Z",
        transcriptArchived: true,
      });

      const listed = yield* repository.listByProjectId({
        projectId: ProjectId.makeUnsafe("project-projection-extended"),
      });
      assert.deepStrictEqual(listed, [Option.getOrNull(persisted)!]);
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored workflow snapshot json is invalid", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at,
          parent_thread_id,
          phase_run_id,
          workflow_id,
          workflow_snapshot_json,
          current_phase_id,
          pattern_id,
          role,
          deliberation_state_json,
          bootstrap_status,
          completed_at,
          transcript_archived
        )
        VALUES (
          ${ThreadId.makeUnsafe("thread-projection-invalid-json")},
          ${ProjectId.makeUnsafe("project-projection-invalid-json")},
          ${"Invalid JSON thread"},
          ${'{"provider":"codex","model":"gpt-5.4"}'},
          ${"full-access"},
          ${"default"},
          ${null},
          ${null},
          ${null},
          ${"2026-04-05T17:30:00.000Z"},
          ${"2026-04-05T17:30:00.000Z"},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${"{not-valid-json"},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${0}
        )
      `;

      const result = yield* Effect.result(
        repository.getById({
          threadId: ThreadId.makeUnsafe("thread-projection-invalid-json"),
        }),
      );

      assert.deepStrictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(result.failure));
        assert.strictEqual(
          result.failure.operation,
          "ProjectionThreadRepository.getById:decodeRow",
        );
      }
    }),
  );
});
