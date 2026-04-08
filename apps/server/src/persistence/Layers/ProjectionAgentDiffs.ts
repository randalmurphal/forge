import { OrchestrationCheckpointFile } from "@forgetools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionAgentDiff,
  ProjectionAgentDiffByTurnInput,
  ProjectionAgentDiffDeleteByThreadInput,
  ProjectionAgentDiffListByThreadInput,
  ProjectionAgentDiffRepository,
  type ProjectionAgentDiffRepositoryShape,
} from "../Services/ProjectionAgentDiffs.ts";

const ProjectionAgentDiffDbRowSchema = ProjectionAgentDiff.mapFields(
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

const makeProjectionAgentDiffRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionAgentDiffRow = SqlSchema.void({
    Request: ProjectionAgentDiffDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO projection_agent_diffs (
          thread_id,
          turn_id,
          diff,
          files_json,
          source,
          coverage,
          completed_at
        )
        VALUES (
          ${row.threadId},
          ${row.turnId},
          ${row.diff},
          ${row.files},
          ${row.source},
          ${row.coverage},
          ${row.completedAt}
        )
        ON CONFLICT (thread_id, turn_id)
        DO UPDATE SET
          diff = excluded.diff,
          files_json = excluded.files_json,
          source = excluded.source,
          coverage = excluded.coverage,
          completed_at = excluded.completed_at
      `,
  });

  const listProjectionAgentDiffRows = SqlSchema.findAll({
    Request: ProjectionAgentDiffListByThreadInput,
    Result: ProjectionAgentDiffDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          diff,
          files_json AS "files",
          source,
          coverage,
          completed_at AS "completedAt"
        FROM projection_agent_diffs
        WHERE thread_id = ${threadId}
        ORDER BY completed_at ASC, turn_id ASC
      `,
  });

  const getProjectionAgentDiffRow = SqlSchema.findOneOption({
    Request: ProjectionAgentDiffByTurnInput,
    Result: ProjectionAgentDiffDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          diff,
          files_json AS "files",
          source,
          coverage,
          completed_at AS "completedAt"
        FROM projection_agent_diffs
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
      `,
  });

  const deleteProjectionAgentDiffRows = SqlSchema.void({
    Request: ProjectionAgentDiffDeleteByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_agent_diffs
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionAgentDiffRepositoryShape["upsert"] = (row) =>
    upsertProjectionAgentDiffRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionAgentDiffRepository.upsert:query",
          "ProjectionAgentDiffRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionAgentDiffRepositoryShape["listByThreadId"] = (input) =>
    listProjectionAgentDiffRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionAgentDiffRepository.listByThreadId:query",
          "ProjectionAgentDiffRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionAgentDiff>>),
    );

  const getByTurnId: ProjectionAgentDiffRepositoryShape["getByTurnId"] = (input) =>
    getProjectionAgentDiffRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionAgentDiffRepository.getByTurnId:query",
          "ProjectionAgentDiffRepository.getByTurnId:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionAgentDiff>)),
        }),
      ),
    );

  const deleteByThreadId: ProjectionAgentDiffRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionAgentDiffRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionAgentDiffRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    getByTurnId,
    deleteByThreadId,
  } satisfies ProjectionAgentDiffRepositoryShape;
});

export const ProjectionAgentDiffRepositoryLive = Layer.effect(
  ProjectionAgentDiffRepository,
  makeProjectionAgentDiffRepository,
);
