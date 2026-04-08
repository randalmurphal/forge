import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (columnNames.has("discussion_id")) {
    return;
  }

  if (!columnNames.has("pattern_id")) {
    // Neither column exists — add the new one directly.
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN discussion_id TEXT
    `;
    return;
  }

  // SQLite does not support ALTER TABLE RENAME COLUMN until 3.25.0.
  // The bun:sqlite driver ships >= 3.38, so this is safe.
  yield* sql`
    ALTER TABLE projection_threads
    RENAME COLUMN pattern_id TO discussion_id
  `;
});
