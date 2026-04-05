import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("021_ChannelTables", (it) => {
  it.effect("creates channel projection tables and indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 20 });
      yield* runMigrations({ toMigrationInclusive: 21 });

      const channelColumns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(channels)
      `;
      assert.deepStrictEqual(
        channelColumns.map((column) => column.name),
        ["channel_id", "thread_id", "phase_run_id", "type", "status", "created_at", "updated_at"],
      );

      const channelIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(channels)
      `;
      assert.ok(channelIndexes.some((index) => index.name === "idx_channels_thread"));
      assert.ok(channelIndexes.some((index) => index.name === "idx_channels_phase_run"));

      const channelThreadIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_channels_thread')
      `;
      assert.deepStrictEqual(
        channelThreadIndexColumns.map((column) => column.name),
        ["thread_id"],
      );

      const channelPhaseRunIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_channels_phase_run')
      `;
      assert.deepStrictEqual(
        channelPhaseRunIndexColumns.map((column) => column.name),
        ["phase_run_id"],
      );

      const channelMessageColumns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(channel_messages)
      `;
      assert.deepStrictEqual(
        channelMessageColumns.map((column) => column.name),
        [
          "message_id",
          "channel_id",
          "sequence",
          "from_type",
          "from_id",
          "from_role",
          "content",
          "metadata_json",
          "created_at",
          "deleted_at",
        ],
      );

      const channelMessageIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(channel_messages)
      `;
      assert.ok(
        channelMessageIndexes.some((index) => index.name === "idx_channel_messages_channel"),
      );
      assert.ok(channelMessageIndexes.some((index) => index.name === "idx_channel_messages_time"));

      const uniqueChannelSequenceIndex = channelMessageIndexes.find(
        (index) => index.unique === 1 && index.origin === "u",
      );
      assert.ok(uniqueChannelSequenceIndex);

      const channelReadsColumns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(channel_reads)
      `;
      assert.deepStrictEqual(
        channelReadsColumns.map((column) => column.name),
        ["channel_id", "thread_id", "last_read_sequence", "updated_at"],
      );
      assert.deepStrictEqual(
        channelReadsColumns.map((column) => column.pk),
        [1, 2, 0, 0],
      );

      const toolCallResultColumns = yield* sql<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
      }>`
        PRAGMA table_info(tool_call_results)
      `;
      assert.deepStrictEqual(
        toolCallResultColumns.map((column) => column.name),
        ["provider", "thread_id", "call_id", "tool_name", "result_json", "created_at"],
      );
      assert.deepStrictEqual(
        toolCallResultColumns.map((column) => column.pk),
        [1, 2, 3, 0, 0, 0],
      );
    }),
  );
});
