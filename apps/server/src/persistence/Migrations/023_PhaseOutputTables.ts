import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS phase_outputs (
      phase_run_id TEXT NOT NULL,
      output_key TEXT NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(phase_run_id, output_key)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_synthesis (
      session_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      generated_by_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_dependencies (
      session_id TEXT NOT NULL,
      depends_on_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, depends_on_session_id),
      CHECK(session_id != depends_on_session_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_session_deps_blocked
    ON session_dependencies(depends_on_session_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_links (
      link_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      linked_session_id TEXT,
      link_type TEXT NOT NULL,
      external_id TEXT,
      external_url TEXT,
      external_status TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_session_links_session
    ON session_links(session_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_session_links_linked
    ON session_links(linked_session_id)
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_links_unique_internal
    ON session_links(session_id, link_type, linked_session_id)
    WHERE linked_session_id IS NOT NULL
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_links_unique_external
    ON session_links(session_id, link_type, external_id)
    WHERE external_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS phase_run_provenance (
      phase_run_id TEXT PRIMARY KEY,
      prompt_template_id TEXT,
      prompt_template_source TEXT,
      prompt_template_hash TEXT,
      prompt_context_hash TEXT,
      model_used TEXT,
      knowledge_snapshot_ids TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS phase_run_outcomes (
      phase_run_id TEXT PRIMARY KEY,
      outcome_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_knowledge (
      knowledge_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_session_id TEXT,
      confidence TEXT NOT NULL DEFAULT 'suggested',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_knowledge_project
    ON project_knowledge(project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS attention_signals (
      signal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT NOT NULL,
      summary TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT,
      snoozed_until TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_signals_status
    ON attention_signals(status)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_signals_project
    ON attention_signals(project_id)
  `;
});
