import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_agent_diffs (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      diff TEXT NOT NULL,
      files_json TEXT NOT NULL,
      source TEXT NOT NULL,
      coverage TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_agent_diffs_thread_completed
    ON projection_agent_diffs(thread_id, completed_at, turn_id)
  `;
});
