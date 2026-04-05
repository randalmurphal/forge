import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ProjectionPhaseOutput,
  ProjectionPhaseOutputRepository,
  QueryProjectionPhaseOutputByKeyInput,
  QueryProjectionPhaseOutputsByPhaseRunIdInput,
  type ProjectionPhaseOutputRepositoryShape,
} from "../Services/ProjectionPhaseOutputs.ts";

const ProjectionPhaseOutputDbRow = ProjectionPhaseOutput.mapFields(
  Struct.assign({
    metadata: Schema.NullOr(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))),
  }),
);

const makeProjectionPhaseOutputRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionPhaseOutputRow = SqlSchema.void({
    Request: ProjectionPhaseOutput,
    execute: (row) =>
      sql`
        INSERT INTO phase_outputs (
          phase_run_id,
          output_key,
          content,
          source_type,
          source_id,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES (
          ${row.phaseRunId},
          ${row.outputKey},
          ${row.content},
          ${row.sourceType},
          ${row.sourceId},
          ${row.metadata === null ? null : JSON.stringify(row.metadata)},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (phase_run_id, output_key)
        DO UPDATE SET
          content = excluded.content,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const queryProjectionPhaseOutputRowsByPhaseRunId = SqlSchema.findAll({
    Request: QueryProjectionPhaseOutputsByPhaseRunIdInput,
    Result: ProjectionPhaseOutputDbRow,
    execute: ({ phaseRunId }) =>
      sql`
        SELECT
          phase_run_id AS "phaseRunId",
          output_key AS "outputKey",
          content,
          source_type AS "sourceType",
          source_id AS "sourceId",
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM phase_outputs
        WHERE phase_run_id = ${phaseRunId}
        ORDER BY output_key ASC
      `,
  });

  const queryProjectionPhaseOutputByKeyRow = SqlSchema.findOneOption({
    Request: QueryProjectionPhaseOutputByKeyInput,
    Result: ProjectionPhaseOutputDbRow,
    execute: ({ phaseRunId, outputKey }) =>
      sql`
        SELECT
          phase_run_id AS "phaseRunId",
          output_key AS "outputKey",
          content,
          source_type AS "sourceType",
          source_id AS "sourceId",
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM phase_outputs
        WHERE phase_run_id = ${phaseRunId}
          AND output_key = ${outputKey}
        LIMIT 1
      `,
  });

  const upsert: ProjectionPhaseOutputRepositoryShape["upsert"] = (row) =>
    upsertProjectionPhaseOutputRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPhaseOutputRepository.upsert:query")),
    );

  const queryByPhaseRunId: ProjectionPhaseOutputRepositoryShape["queryByPhaseRunId"] = (input) =>
    queryProjectionPhaseOutputRowsByPhaseRunId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionPhaseOutputRepository.queryByPhaseRunId:query",
          "ProjectionPhaseOutputRepository.queryByPhaseRunId:decodeRows",
        ),
      ),
    );

  const queryByKey: ProjectionPhaseOutputRepositoryShape["queryByKey"] = (input) =>
    queryProjectionPhaseOutputByKeyRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionPhaseOutputRepository.queryByKey:query",
          "ProjectionPhaseOutputRepository.queryByKey:decodeRow",
        ),
      ),
    );

  return {
    upsert,
    queryByPhaseRunId,
    queryByKey,
  } satisfies ProjectionPhaseOutputRepositoryShape;
});

export const ProjectionPhaseOutputRepositoryLive = Layer.effect(
  ProjectionPhaseOutputRepository,
  makeProjectionPhaseOutputRepository,
);
