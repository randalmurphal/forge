import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_thread_proposed_plans RENAME TO projection_thread_proposed_plans_legacy`;

  yield* sql`
    CREATE TABLE projection_thread_proposed_plans (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      plan_markdown TEXT NOT NULL,
      implemented_at TEXT,
      implementation_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_proposed_plans (
      plan_id,
      thread_id,
      turn_id,
      plan_markdown,
      implemented_at,
      implementation_thread_id,
      created_at,
      updated_at
    )
    SELECT
      plan_id,
      thread_id,
      turn_id,
      plan_markdown,
      implemented_at,
      implementation_thread_id,
      created_at,
      updated_at
    FROM projection_thread_proposed_plans_legacy
    ORDER BY updated_at ASC, created_at ASC, plan_id ASC
  `;

  yield* sql`DROP TABLE projection_thread_proposed_plans_legacy`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_updated
    ON projection_thread_proposed_plans(thread_id, updated_at, created_at, plan_id, row_id)
  `;
});
