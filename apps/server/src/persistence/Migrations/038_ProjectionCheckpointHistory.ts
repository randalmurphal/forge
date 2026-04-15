import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_checkpoints (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      checkpoint_turn_count INTEGER NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      checkpoint_status TEXT NOT NULL,
      checkpoint_files_json TEXT NOT NULL,
      assistant_message_id TEXT,
      completed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_checkpoints (
      thread_id,
      turn_id,
      checkpoint_turn_count,
      checkpoint_ref,
      checkpoint_status,
      checkpoint_files_json,
      assistant_message_id,
      completed_at
    )
    SELECT
      thread_id,
      turn_id,
      checkpoint_turn_count,
      checkpoint_ref,
      checkpoint_status,
      checkpoint_files_json,
      assistant_message_id,
      completed_at
    FROM projection_turns
    WHERE checkpoint_turn_count IS NOT NULL
    ORDER BY completed_at ASC, checkpoint_turn_count ASC, turn_id ASC
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_checkpoints_thread_completed
    ON projection_checkpoints(thread_id, completed_at, checkpoint_turn_count, row_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_checkpoints_thread_turn_count_latest
    ON projection_checkpoints(thread_id, checkpoint_turn_count, completed_at, row_id)
  `;
});
