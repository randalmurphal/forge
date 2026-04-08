import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN spawn_mode TEXT
  `;

  yield* sql`
    UPDATE projection_threads
    SET
      spawn_branch = CASE
        WHEN json_type(
          (
            SELECT orchestration_events.payload_json
            FROM orchestration_events
            WHERE orchestration_events.event_type = 'thread.created'
              AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
            ORDER BY orchestration_events.sequence ASC
            LIMIT 1
          ),
          '$.spawnBranch'
        ) IS NOT NULL
          THEN json_extract(
            (
              SELECT orchestration_events.payload_json
              FROM orchestration_events
              WHERE orchestration_events.event_type = 'thread.created'
                AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
              ORDER BY orchestration_events.sequence ASC
              LIMIT 1
            ),
            '$.spawnBranch'
          )
        ELSE COALESCE(
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
        )
      END,
      spawn_worktree_path = CASE
        WHEN json_type(
          (
            SELECT orchestration_events.payload_json
            FROM orchestration_events
            WHERE orchestration_events.event_type = 'thread.created'
              AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
            ORDER BY orchestration_events.sequence ASC
            LIMIT 1
          ),
          '$.spawnWorktreePath'
        ) IS NOT NULL
          THEN json_extract(
            (
              SELECT orchestration_events.payload_json
              FROM orchestration_events
              WHERE orchestration_events.event_type = 'thread.created'
                AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
              ORDER BY orchestration_events.sequence ASC
              LIMIT 1
            ),
            '$.spawnWorktreePath'
          )
        ELSE COALESCE(
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
      END,
      spawn_mode = COALESCE(
        json_extract(
          (
            SELECT orchestration_events.payload_json
            FROM orchestration_events
            WHERE orchestration_events.event_type = 'thread.created'
              AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
            ORDER BY orchestration_events.sequence ASC
            LIMIT 1
          ),
          '$.spawnMode'
        ),
        CASE
          WHEN (
            CASE
              WHEN json_type(
                (
                  SELECT orchestration_events.payload_json
                  FROM orchestration_events
                  WHERE orchestration_events.event_type = 'thread.created'
                    AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
                  ORDER BY orchestration_events.sequence ASC
                  LIMIT 1
                ),
                '$.spawnWorktreePath'
              ) IS NOT NULL
                THEN json_extract(
                  (
                    SELECT orchestration_events.payload_json
                    FROM orchestration_events
                    WHERE orchestration_events.event_type = 'thread.created'
                      AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
                    ORDER BY orchestration_events.sequence ASC
                    LIMIT 1
                  ),
                  '$.spawnWorktreePath'
                )
              ELSE COALESCE(
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
            END
          ) IS NOT NULL
            THEN 'worktree'
          ELSE 'local'
        END
      )
    WHERE spawn_mode IS NULL
      OR spawn_branch IS NOT (
        CASE
          WHEN json_type(
            (
              SELECT orchestration_events.payload_json
              FROM orchestration_events
              WHERE orchestration_events.event_type = 'thread.created'
                AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
              ORDER BY orchestration_events.sequence ASC
              LIMIT 1
            ),
            '$.spawnBranch'
          ) IS NOT NULL
            THEN json_extract(
              (
                SELECT orchestration_events.payload_json
                FROM orchestration_events
                WHERE orchestration_events.event_type = 'thread.created'
                  AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
                ORDER BY orchestration_events.sequence ASC
                LIMIT 1
              ),
              '$.spawnBranch'
            )
          ELSE COALESCE(
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
          )
        END
      )
      OR spawn_worktree_path IS NOT (
        CASE
          WHEN json_type(
            (
              SELECT orchestration_events.payload_json
              FROM orchestration_events
              WHERE orchestration_events.event_type = 'thread.created'
                AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
              ORDER BY orchestration_events.sequence ASC
              LIMIT 1
            ),
            '$.spawnWorktreePath'
          ) IS NOT NULL
            THEN json_extract(
              (
                SELECT orchestration_events.payload_json
                FROM orchestration_events
                WHERE orchestration_events.event_type = 'thread.created'
                  AND json_extract(orchestration_events.payload_json, '$.threadId') = projection_threads.thread_id
                ORDER BY orchestration_events.sequence ASC
                LIMIT 1
              ),
              '$.spawnWorktreePath'
            )
          ELSE COALESCE(
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
        END
      )
  `;
});
