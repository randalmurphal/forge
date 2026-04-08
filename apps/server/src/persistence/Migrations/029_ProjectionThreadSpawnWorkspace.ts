import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN spawn_branch TEXT
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN spawn_worktree_path TEXT
  `;

  yield* sql`
    UPDATE projection_threads
    SET
      spawn_branch = COALESCE(
        json_extract(
          (
            SELECT orchestration_events.payload_json
            FROM orchestration_events
            WHERE orchestration_events.event_type = 'thread.created'
              AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
            ORDER BY orchestration_events.sequence ASC
            LIMIT 1
          ),
          '$.spawnBranch'
        ),
        json_extract(
          (
            SELECT orchestration_events.payload_json
            FROM orchestration_events
            WHERE orchestration_events.event_type = 'thread.created'
              AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
            ORDER BY orchestration_events.sequence ASC
            LIMIT 1
          ),
          '$.branch'
        ),
        branch
      ),
      spawn_worktree_path = COALESCE(
        json_extract(
          (
            SELECT orchestration_events.payload_json
            FROM orchestration_events
            WHERE orchestration_events.event_type = 'thread.created'
              AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
            ORDER BY orchestration_events.sequence ASC
            LIMIT 1
          ),
          '$.spawnWorktreePath'
        ),
        json_extract(
          (
            SELECT orchestration_events.payload_json
            FROM orchestration_events
            WHERE orchestration_events.event_type = 'thread.created'
              AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
            ORDER BY orchestration_events.sequence ASC
            LIMIT 1
          ),
          '$.worktreePath'
        ),
        worktree_path
      )
    WHERE spawn_branch IS NULL
      OR spawn_worktree_path IS NULL
  `;
});
