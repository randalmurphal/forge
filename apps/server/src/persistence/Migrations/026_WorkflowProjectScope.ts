import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(workflows)
  `;

  if (!columns.some((column) => column.name === "project_id")) {
    yield* sql`
      ALTER TABLE workflows
      ADD COLUMN project_id TEXT
    `;
  }

  yield* sql`
    DROP INDEX IF EXISTS idx_workflows_name_builtin
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_name_scope
    ON workflows(name, built_in, COALESCE(project_id, ''))
  `;
});
