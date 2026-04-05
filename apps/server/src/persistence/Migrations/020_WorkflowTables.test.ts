import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("020_WorkflowTables", (it) => {
  it.effect("creates workflows and phase_runs tables with the expected indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 19 });
      yield* runMigrations({ toMigrationInclusive: 20 });

      const workflowColumns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(workflows)
      `;
      assert.deepStrictEqual(
        workflowColumns.map((column) => column.name),
        [
          "workflow_id",
          "name",
          "description",
          "phases_json",
          "built_in",
          "created_at",
          "updated_at",
        ],
      );

      const workflowIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(workflows)
      `;
      assert.ok(workflowIndexes.some((index) => index.name === "idx_workflows_name_builtin"));

      const workflowIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_workflows_name_builtin')
      `;
      assert.deepStrictEqual(
        workflowIndexColumns.map((column) => column.name),
        ["name", "built_in"],
      );

      const phaseRunColumns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(phase_runs)
      `;
      assert.deepStrictEqual(
        phaseRunColumns.map((column) => column.name),
        [
          "phase_run_id",
          "thread_id",
          "workflow_id",
          "phase_id",
          "phase_name",
          "phase_type",
          "sandbox_mode",
          "iteration",
          "status",
          "gate_result_json",
          "quality_checks_json",
          "deliberation_state_json",
          "started_at",
          "completed_at",
        ],
      );

      const phaseRunIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(phase_runs)
      `;
      assert.ok(phaseRunIndexes.some((index) => index.name === "idx_phase_runs_thread"));
      assert.ok(phaseRunIndexes.some((index) => index.name === "idx_phase_runs_resolve"));

      const phaseRunThreadIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_phase_runs_thread')
      `;
      assert.deepStrictEqual(
        phaseRunThreadIndexColumns.map((column) => column.name),
        ["thread_id"],
      );

      const phaseRunResolveIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_phase_runs_resolve')
      `;
      assert.deepStrictEqual(
        phaseRunResolveIndexColumns.map((column) => column.name),
        ["thread_id", "phase_name", "status"],
      );
    }),
  );
});
