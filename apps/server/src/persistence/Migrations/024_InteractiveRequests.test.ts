import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("024_InteractiveRequests", (it) => {
  it.effect("creates the interactive request projection table and indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 23 });
      yield* runMigrations({ toMigrationInclusive: 24 });

      const requestColumns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(interactive_requests)
      `;
      assert.deepStrictEqual(
        requestColumns.map((column) => column.name),
        [
          "request_id",
          "thread_id",
          "child_thread_id",
          "phase_run_id",
          "type",
          "status",
          "payload_json",
          "resolved_with_json",
          "created_at",
          "resolved_at",
          "stale_reason",
        ],
      );

      const requestIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(interactive_requests)
      `;
      assert.ok(requestIndexes.some((index) => index.name === "idx_interactive_requests_thread"));
      assert.ok(requestIndexes.some((index) => index.name === "idx_interactive_requests_status"));
      assert.ok(
        requestIndexes.some((index) => index.name === "idx_interactive_requests_phase_run"),
      );
    }),
  );
});
