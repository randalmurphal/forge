import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(workflows)
  `;

  if (columns.some((column) => column.name === "on_completion_json")) {
    return;
  }

  yield* sql`
    ALTER TABLE workflows
    ADD COLUMN on_completion_json TEXT
  `;
});
