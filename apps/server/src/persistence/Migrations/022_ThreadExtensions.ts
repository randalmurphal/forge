import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }

  if (!columnNames.has("phase_run_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN phase_run_id TEXT
    `;
  }

  if (!columnNames.has("workflow_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workflow_id TEXT
    `;
  }

  if (!columnNames.has("workflow_snapshot_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workflow_snapshot_json TEXT
    `;
  }

  if (!columnNames.has("current_phase_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN current_phase_id TEXT
    `;
  }

  if (!columnNames.has("pattern_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pattern_id TEXT
    `;
  }

  if (!columnNames.has("role")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN role TEXT
    `;
  }

  if (!columnNames.has("deliberation_state_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN deliberation_state_json TEXT
    `;
  }

  if (!columnNames.has("bootstrap_status")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN bootstrap_status TEXT
    `;
  }

  if (!columnNames.has("completed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN completed_at TEXT
    `;
  }

  if (!columnNames.has("transcript_archived")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN transcript_archived INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread_id
    ON projection_threads(parent_thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_phase_run_id
    ON projection_threads(phase_run_id)
  `;
});
