import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("025_WorkflowOnCompletion", (it) => {
  it.effect("adds on_completion_json to workflows and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 24 });
      yield* runMigrations({ toMigrationInclusive: 25 });
      yield* runMigrations({ toMigrationInclusive: 25 });

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

      assert.ok(workflowColumns.some((column) => column.name === "on_completion_json"));
    }),
  );
});
