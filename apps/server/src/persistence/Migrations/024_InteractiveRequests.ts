import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS interactive_requests (
      request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      child_thread_id TEXT,
      phase_run_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      resolved_with_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      stale_reason TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_interactive_requests_thread
    ON interactive_requests(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_interactive_requests_status
    ON interactive_requests(status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_interactive_requests_phase_run
    ON interactive_requests(phase_run_id)
  `;
});
