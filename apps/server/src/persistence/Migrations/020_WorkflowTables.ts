import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workflows (
      workflow_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      phases_json TEXT NOT NULL,
      built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_name_builtin
    ON workflows(name, built_in)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS phase_runs (
      phase_run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      phase_name TEXT NOT NULL,
      phase_type TEXT NOT NULL,
      sandbox_mode TEXT,
      iteration INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      gate_result_json TEXT,
      quality_checks_json TEXT,
      deliberation_state_json TEXT,
      started_at TEXT,
      completed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_phase_runs_thread
    ON phase_runs(thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_phase_runs_resolve
    ON phase_runs(thread_id, phase_name, status)
  `;
});
