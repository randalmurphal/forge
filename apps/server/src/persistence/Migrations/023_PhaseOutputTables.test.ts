import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("023_PhaseOutputTables", (it) => {
  it.effect("creates phase output and related foundation tables with the expected indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 22 });
      yield* runMigrations({ toMigrationInclusive: 23 });

      const tableNames = yield* sql<{
        readonly name: string;
      }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'phase_outputs',
            'session_synthesis',
            'session_dependencies',
            'session_links',
            'phase_run_provenance',
            'phase_run_outcomes',
            'project_knowledge',
            'attention_signals'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tableNames.map((table) => table.name),
        [
          "attention_signals",
          "phase_outputs",
          "phase_run_outcomes",
          "phase_run_provenance",
          "project_knowledge",
          "session_dependencies",
          "session_links",
          "session_synthesis",
        ],
      );

      const phaseOutputColumns = yield* sql<{
        readonly name: string;
        readonly pk: number;
      }>`
        PRAGMA table_info(phase_outputs)
      `;
      assert.deepStrictEqual(
        phaseOutputColumns.map((column) => column.name),
        [
          "phase_run_id",
          "output_key",
          "content",
          "source_type",
          "source_id",
          "metadata_json",
          "created_at",
          "updated_at",
        ],
      );
      assert.deepStrictEqual(
        phaseOutputColumns.map((column) => column.pk),
        [1, 2, 0, 0, 0, 0, 0, 0],
      );

      const sessionDependencyIndexes = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_list(session_dependencies)
      `;
      assert.ok(
        sessionDependencyIndexes.some((index) => index.name === "idx_session_deps_blocked"),
      );

      const sessionLinkColumns = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA table_info(session_links)
      `;
      assert.deepStrictEqual(
        sessionLinkColumns.map((column) => column.name),
        [
          "link_id",
          "session_id",
          "linked_session_id",
          "link_type",
          "external_id",
          "external_url",
          "external_status",
          "metadata_json",
          "created_at",
          "updated_at",
        ],
      );

      const sessionLinkIndexes = yield* sql<{
        readonly name: string;
        readonly unique: number;
        readonly partial: number;
      }>`
        PRAGMA index_list(session_links)
      `;
      assert.ok(sessionLinkIndexes.some((index) => index.name === "idx_session_links_session"));
      assert.ok(sessionLinkIndexes.some((index) => index.name === "idx_session_links_linked"));
      assert.ok(
        sessionLinkIndexes.some(
          (index) =>
            index.name === "idx_session_links_unique_internal" &&
            index.unique === 1 &&
            index.partial === 1,
        ),
      );
      assert.ok(
        sessionLinkIndexes.some(
          (index) =>
            index.name === "idx_session_links_unique_external" &&
            index.unique === 1 &&
            index.partial === 1,
        ),
      );

      const projectKnowledgeIndexes = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_list(project_knowledge)
      `;
      assert.ok(projectKnowledgeIndexes.some((index) => index.name === "idx_knowledge_project"));

      const attentionSignalIndexes = yield* sql<{
        readonly name: string;
      }>`
        PRAGMA index_list(attention_signals)
      `;
      assert.ok(attentionSignalIndexes.some((index) => index.name === "idx_signals_status"));
      assert.ok(attentionSignalIndexes.some((index) => index.name === "idx_signals_project"));
    }),
  );
});
