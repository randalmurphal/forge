import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("026_WorkflowProjectScope", (it) => {
  it.effect("adds project_id and replaces the scoped workflow uniqueness index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 25 });
      yield* runMigrations({ toMigrationInclusive: 26 });
      yield* runMigrations({ toMigrationInclusive: 26 });

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

      assert.ok(workflowColumns.some((column) => column.name === "project_id"));

      const indexes = yield* sql<{
        readonly name: string;
        readonly sql: string | null;
      }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'workflows'
      `;

      const scopedIndex = indexes.find((index) => index.name === "idx_workflows_name_scope");
      assert.ok(scopedIndex);
      assert.ok(scopedIndex.sql?.includes("COALESCE(project_id, '')"));
      assert.ok(!indexes.some((index) => index.name === "idx_workflows_name_builtin"));
    }),
  );
});
