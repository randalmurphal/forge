import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("022_ThreadExtensions", (it) => {
  it.effect("adds thread extension columns and preserves existing projection rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 21 });

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
          deleted_at
        )
        VALUES (
          'thread-existing',
          'project-existing',
          'Existing thread',
          '{"provider":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          'feature/existing',
          '/tmp/existing-thread',
          'turn-existing',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          NULL,
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 22 });

      const threadColumns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(projection_threads)
      `;
      const columnNames = new Set(threadColumns.map((column) => column.name));

      assert.ok(columnNames.has("parent_thread_id"));
      assert.ok(columnNames.has("phase_run_id"));
      assert.ok(columnNames.has("workflow_id"));
      assert.ok(columnNames.has("workflow_snapshot_json"));
      assert.ok(columnNames.has("current_phase_id"));
      assert.ok(columnNames.has("pattern_id"));
      assert.ok(columnNames.has("role"));
      assert.ok(columnNames.has("deliberation_state_json"));
      assert.ok(columnNames.has("bootstrap_status"));
      assert.ok(columnNames.has("completed_at"));
      assert.ok(columnNames.has("transcript_archived"));

      const transcriptArchivedColumn = threadColumns.find(
        (column) => column.name === "transcript_archived",
      );
      assert.ok(transcriptArchivedColumn);
      assert.strictEqual(transcriptArchivedColumn.notnull, 1);
      assert.strictEqual(transcriptArchivedColumn.dflt_value, "0");

      const threadIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.ok(
        threadIndexes.some((index) => index.name === "idx_projection_threads_parent_thread_id"),
      );
      assert.ok(
        threadIndexes.some((index) => index.name === "idx_projection_threads_phase_run_id"),
      );

      const parentThreadIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_threads_parent_thread_id')
      `;
      assert.deepStrictEqual(
        parentThreadIndexColumns.map((column) => column.name),
        ["parent_thread_id"],
      );

      const phaseRunIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_threads_phase_run_id')
      `;
      assert.deepStrictEqual(
        phaseRunIndexColumns.map((column) => column.name),
        ["phase_run_id"],
      );

      const threadRows = yield* sql<{
        readonly threadId: string;
        readonly title: string;
        readonly modelSelection: string;
        readonly runtimeMode: string;
        readonly interactionMode: string;
        readonly branch: string | null;
        readonly worktreePath: string | null;
        readonly latestTurnId: string | null;
        readonly parentThreadId: string | null;
        readonly phaseRunId: string | null;
        readonly workflowId: string | null;
        readonly workflowSnapshotJson: string | null;
        readonly currentPhaseId: string | null;
        readonly patternId: string | null;
        readonly role: string | null;
        readonly deliberationStateJson: string | null;
        readonly bootstrapStatus: string | null;
        readonly completedAt: string | null;
        readonly transcriptArchived: number;
      }>`
        SELECT
          thread_id AS "threadId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          parent_thread_id AS "parentThreadId",
          phase_run_id AS "phaseRunId",
          workflow_id AS "workflowId",
          workflow_snapshot_json AS "workflowSnapshotJson",
          current_phase_id AS "currentPhaseId",
          pattern_id AS "patternId",
          role,
          deliberation_state_json AS "deliberationStateJson",
          bootstrap_status AS "bootstrapStatus",
          completed_at AS "completedAt",
          transcript_archived AS "transcriptArchived"
        FROM projection_threads
        WHERE thread_id = 'thread-existing'
      `;
      assert.deepStrictEqual(threadRows, [
        {
          threadId: "thread-existing",
          title: "Existing thread",
          modelSelection: '{"provider":"codex","model":"gpt-5.4"}',
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/existing",
          worktreePath: "/tmp/existing-thread",
          latestTurnId: "turn-existing",
          parentThreadId: null,
          phaseRunId: null,
          workflowId: null,
          workflowSnapshotJson: null,
          currentPhaseId: null,
          patternId: null,
          role: null,
          deliberationStateJson: null,
          bootstrapStatus: null,
          completedAt: null,
          transcriptArchived: 0,
        },
      ]);
    }),
  );
});
