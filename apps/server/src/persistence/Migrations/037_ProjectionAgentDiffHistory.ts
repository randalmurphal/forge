import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_agent_diffs RENAME TO projection_agent_diffs_legacy`;

  yield* sql`
    CREATE TABLE projection_agent_diffs (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      diff TEXT NOT NULL,
      files_json TEXT NOT NULL,
      source TEXT NOT NULL,
      coverage TEXT NOT NULL,
      assistant_message_id TEXT,
      completed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_agent_diffs (
      thread_id,
      turn_id,
      diff,
      files_json,
      source,
      coverage,
      assistant_message_id,
      completed_at
    )
    SELECT
      thread_id,
      turn_id,
      diff,
      files_json,
      source,
      coverage,
      assistant_message_id,
      completed_at
    FROM projection_agent_diffs_legacy
    ORDER BY completed_at ASC, turn_id ASC
  `;

  yield* sql`DROP TABLE projection_agent_diffs_legacy`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_agent_diffs_thread_completed
    ON projection_agent_diffs(thread_id, completed_at, turn_id, row_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_agent_diffs_thread_turn_latest
    ON projection_agent_diffs(thread_id, turn_id, completed_at, row_id)
  `;
});
