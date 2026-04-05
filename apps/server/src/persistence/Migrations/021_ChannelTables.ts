import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      phase_run_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_channels_thread
    ON channels(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_channels_phase_run
    ON channels(phase_run_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_messages (
      message_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      from_type TEXT NOT NULL,
      from_id TEXT NOT NULL,
      from_role TEXT,
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE(channel_id, sequence)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_channel_messages_channel
    ON channel_messages(channel_id, sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_channel_messages_time
    ON channel_messages(channel_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS channel_reads (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      last_read_sequence INTEGER NOT NULL DEFAULT -1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(channel_id, thread_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tool_call_results (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(provider, thread_id, call_id)
    )
  `;
});
