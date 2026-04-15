import { OrchestrationCheckpointFile } from "@forgetools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteByThreadIdInput,
  GetByThreadAndTurnCountInput,
  ListByThreadIdInput,
  ProjectionCheckpoint,
  ProjectionCheckpointRepository,
  type ProjectionCheckpointRepositoryShape,
} from "../Services/ProjectionCheckpoints.ts";

const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionCheckpointRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendProjectionCheckpointRow = SqlSchema.void({
    Request: ProjectionCheckpointDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO projection_checkpoints (
          thread_id,
          turn_id,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json,
          assistant_message_id,
          completed_at
        )
        VALUES (
          ${row.threadId},
          ${row.turnId},
          ${row.checkpointTurnCount},
          ${row.checkpointRef},
          ${row.status},
          ${row.files},
          ${row.assistantMessageId},
          ${row.completedAt}
        )
      `,
  });

  const listProjectionCheckpointRows = SqlSchema.findAll({
    Request: ListByThreadIdInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_checkpoints
        WHERE thread_id = ${threadId}
        ORDER BY completed_at ASC, checkpoint_turn_count ASC, row_id ASC
      `,
  });

  const getProjectionCheckpointRow = SqlSchema.findOneOption({
    Request: GetByThreadAndTurnCountInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_checkpoints
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
        ORDER BY completed_at DESC, row_id DESC
        LIMIT 1
      `,
  });

  const deleteProjectionCheckpointRows = SqlSchema.void({
    Request: DeleteByThreadIdInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_checkpoints
        WHERE thread_id = ${threadId}
      `,
  });

  const append: ProjectionCheckpointRepositoryShape["append"] = (row) =>
    appendProjectionCheckpointRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.append:query",
          "ProjectionCheckpointRepository.append:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionCheckpointRepositoryShape["listByThreadId"] = (input) =>
    listProjectionCheckpointRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.listByThreadId:query",
          "ProjectionCheckpointRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionCheckpoint>>),
    );

  const getByThreadAndTurnCount: ProjectionCheckpointRepositoryShape["getByThreadAndTurnCount"] = (
    input,
  ) =>
    getProjectionCheckpointRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionCheckpointRepository.getByThreadAndTurnCount:query",
          "ProjectionCheckpointRepository.getByThreadAndTurnCount:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionCheckpoint>)),
        }),
      ),
    );

  const deleteByThreadId: ProjectionCheckpointRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionCheckpointRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionCheckpointRepository.deleteByThreadId:query"),
      ),
    );

  return {
    append,
    listByThreadId,
    getByThreadAndTurnCount,
    deleteByThreadId,
  } satisfies ProjectionCheckpointRepositoryShape;
});

export const ProjectionCheckpointRepositoryLive = Layer.effect(
  ProjectionCheckpointRepository,
  makeProjectionCheckpointRepository,
);
