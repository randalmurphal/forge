import { WorkflowPhase } from "@t3tools/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteProjectionWorkflowInput,
  ProjectionWorkflow,
  ProjectionWorkflowRepository,
  QueryProjectionWorkflowByIdInput,
  QueryProjectionWorkflowByNameInput,
  type ProjectionWorkflowRepositoryShape,
} from "../Services/ProjectionWorkflows.ts";

const ProjectionWorkflowDbRow = ProjectionWorkflow.mapFields(
  Struct.assign({
    phases: Schema.fromJsonString(Schema.Array(WorkflowPhase)),
    builtIn: Schema.Number,
  }),
);
type ProjectionWorkflowDbRow = typeof ProjectionWorkflowDbRow.Type;

function toProjectionWorkflow(row: ProjectionWorkflowDbRow): ProjectionWorkflow {
  return {
    workflowId: row.workflowId,
    name: row.name,
    description: row.description,
    phases: row.phases,
    builtIn: row.builtIn === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const makeProjectionWorkflowRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionWorkflowRow = SqlSchema.void({
    Request: ProjectionWorkflow,
    execute: (row) =>
      sql`
        INSERT INTO workflows (
          workflow_id,
          name,
          description,
          phases_json,
          built_in,
          created_at,
          updated_at
        )
        VALUES (
          ${row.workflowId},
          ${row.name},
          ${row.description},
          ${JSON.stringify(row.phases)},
          ${row.builtIn ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (workflow_id)
        DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          phases_json = excluded.phases_json,
          built_in = excluded.built_in,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const queryProjectionWorkflowByIdRow = SqlSchema.findOneOption({
    Request: QueryProjectionWorkflowByIdInput,
    Result: ProjectionWorkflowDbRow,
    execute: ({ workflowId }) =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          name,
          description,
          phases_json AS "phases",
          built_in AS "builtIn",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM workflows
        WHERE workflow_id = ${workflowId}
        LIMIT 1
      `,
  });

  const queryProjectionWorkflowByNameRow = SqlSchema.findOneOption({
    Request: QueryProjectionWorkflowByNameInput,
    Result: ProjectionWorkflowDbRow,
    execute: ({ name }) =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          name,
          description,
          phases_json AS "phases",
          built_in AS "builtIn",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM workflows
        WHERE name = ${name}
        ORDER BY built_in ASC, workflow_id ASC
        LIMIT 1
      `,
  });

  const queryAllProjectionWorkflowRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionWorkflowDbRow,
    execute: () =>
      sql`
        SELECT
          workflow_id AS "workflowId",
          name,
          description,
          phases_json AS "phases",
          built_in AS "builtIn",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM workflows
        ORDER BY name ASC, built_in ASC, workflow_id ASC
      `,
  });

  const deleteProjectionWorkflowRow = SqlSchema.void({
    Request: DeleteProjectionWorkflowInput,
    execute: ({ workflowId }) =>
      sql`
        DELETE FROM workflows
        WHERE workflow_id = ${workflowId}
      `,
  });

  const upsert: ProjectionWorkflowRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorkflowRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.upsert:query")),
    );

  const queryById: ProjectionWorkflowRepositoryShape["queryById"] = (input) =>
    queryProjectionWorkflowByIdRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionWorkflowRepository.queryById:query",
          "ProjectionWorkflowRepository.queryById:decodeRow",
        ),
      ),
      Effect.map(Option.map(toProjectionWorkflow)),
    );

  const queryByName: ProjectionWorkflowRepositoryShape["queryByName"] = (input) =>
    queryProjectionWorkflowByNameRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionWorkflowRepository.queryByName:query",
          "ProjectionWorkflowRepository.queryByName:decodeRow",
        ),
      ),
      Effect.map(Option.map(toProjectionWorkflow)),
    );

  const queryAll: ProjectionWorkflowRepositoryShape["queryAll"] = () =>
    queryAllProjectionWorkflowRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionWorkflowRepository.queryAll:query",
          "ProjectionWorkflowRepository.queryAll:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toProjectionWorkflow)),
    );

  const deleteWorkflow: ProjectionWorkflowRepositoryShape["delete"] = (input) =>
    deleteProjectionWorkflowRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkflowRepository.delete:query")),
    );

  return {
    upsert,
    queryById,
    queryByName,
    queryAll,
    delete: deleteWorkflow,
  } satisfies ProjectionWorkflowRepositoryShape;
});

export const ProjectionWorkflowRepositoryLive = Layer.effect(
  ProjectionWorkflowRepository,
  makeProjectionWorkflowRepository,
);
