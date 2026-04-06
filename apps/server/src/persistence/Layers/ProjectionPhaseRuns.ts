import { DeliberationState, GateResult, QualityCheckResult } from "@forgetools/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  ProjectionPhaseRun,
  ProjectionPhaseRunRepository,
  QueryProjectionPhaseRunByIdInput,
  QueryProjectionPhaseRunsByThreadIdInput,
  UpdateProjectionPhaseRunStatusInput,
  type ProjectionPhaseRunRepositoryShape,
} from "../Services/ProjectionPhaseRuns.ts";

const ProjectionPhaseRunDbRow = ProjectionPhaseRun.mapFields(
  Struct.assign({
    gateResult: Schema.NullOr(Schema.fromJsonString(GateResult)),
    qualityChecks: Schema.NullOr(Schema.fromJsonString(Schema.Array(QualityCheckResult))),
    deliberationState: Schema.NullOr(Schema.fromJsonString(DeliberationState)),
  }),
);

const makeProjectionPhaseRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionPhaseRunRow = SqlSchema.void({
    Request: ProjectionPhaseRun,
    execute: (row) =>
      sql`
        INSERT INTO phase_runs (
          phase_run_id,
          thread_id,
          workflow_id,
          phase_id,
          phase_name,
          phase_type,
          sandbox_mode,
          iteration,
          status,
          gate_result_json,
          quality_checks_json,
          deliberation_state_json,
          started_at,
          completed_at
        )
        VALUES (
          ${row.phaseRunId},
          ${row.threadId},
          ${row.workflowId},
          ${row.phaseId},
          ${row.phaseName},
          ${row.phaseType},
          ${row.sandboxMode},
          ${row.iteration},
          ${row.status},
          ${row.gateResult === null ? null : JSON.stringify(row.gateResult)},
          ${row.qualityChecks === null ? null : JSON.stringify(row.qualityChecks)},
          ${row.deliberationState === null ? null : JSON.stringify(row.deliberationState)},
          ${row.startedAt},
          ${row.completedAt}
        )
        ON CONFLICT (phase_run_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          workflow_id = excluded.workflow_id,
          phase_id = excluded.phase_id,
          phase_name = excluded.phase_name,
          phase_type = excluded.phase_type,
          sandbox_mode = excluded.sandbox_mode,
          iteration = excluded.iteration,
          status = excluded.status,
          gate_result_json = excluded.gate_result_json,
          quality_checks_json = excluded.quality_checks_json,
          deliberation_state_json = excluded.deliberation_state_json,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at
      `,
  });

  const queryProjectionPhaseRunByIdRow = SqlSchema.findOneOption({
    Request: QueryProjectionPhaseRunByIdInput,
    Result: ProjectionPhaseRunDbRow,
    execute: ({ phaseRunId }) =>
      sql`
        SELECT
          phase_run_id AS "phaseRunId",
          thread_id AS "threadId",
          workflow_id AS "workflowId",
          phase_id AS "phaseId",
          phase_name AS "phaseName",
          phase_type AS "phaseType",
          sandbox_mode AS "sandboxMode",
          iteration,
          status,
          gate_result_json AS "gateResult",
          quality_checks_json AS "qualityChecks",
          deliberation_state_json AS "deliberationState",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM phase_runs
        WHERE phase_run_id = ${phaseRunId}
        LIMIT 1
      `,
  });

  const queryProjectionPhaseRunRowsByThreadId = SqlSchema.findAll({
    Request: QueryProjectionPhaseRunsByThreadIdInput,
    Result: ProjectionPhaseRunDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          phase_run_id AS "phaseRunId",
          thread_id AS "threadId",
          workflow_id AS "workflowId",
          phase_id AS "phaseId",
          phase_name AS "phaseName",
          phase_type AS "phaseType",
          sandbox_mode AS "sandboxMode",
          iteration,
          status,
          gate_result_json AS "gateResult",
          quality_checks_json AS "qualityChecks",
          deliberation_state_json AS "deliberationState",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM phase_runs
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN started_at IS NULL THEN 1 ELSE 0 END ASC,
          started_at ASC,
          iteration ASC,
          phase_run_id ASC
      `,
  });

  const updateProjectionPhaseRunStatusRow = SqlSchema.void({
    Request: UpdateProjectionPhaseRunStatusInput,
    execute: (input) => {
      const hasGateResult = Object.hasOwn(input, "gateResult");
      const hasQualityChecks = Object.hasOwn(input, "qualityChecks");
      const hasDeliberationState = Object.hasOwn(input, "deliberationState");
      const hasStartedAt = Object.hasOwn(input, "startedAt");
      const hasCompletedAt = Object.hasOwn(input, "completedAt");
      const gateResultJson = hasGateResult
        ? input.gateResult === null
          ? null
          : JSON.stringify(input.gateResult)
        : null;
      const qualityChecksJson = hasQualityChecks
        ? input.qualityChecks === null
          ? null
          : JSON.stringify(input.qualityChecks)
        : null;
      const deliberationStateJson = hasDeliberationState
        ? input.deliberationState === null
          ? null
          : JSON.stringify(input.deliberationState)
        : null;

      return sql`
        UPDATE phase_runs
        SET
          status = ${input.status},
          gate_result_json = CASE
            WHEN ${hasGateResult ? 1 : 0} = 1
              THEN ${gateResultJson}
            ELSE gate_result_json
          END,
          quality_checks_json = CASE
            WHEN ${hasQualityChecks ? 1 : 0} = 1
              THEN ${qualityChecksJson}
            ELSE quality_checks_json
          END,
          deliberation_state_json = CASE
            WHEN ${hasDeliberationState ? 1 : 0} = 1
              THEN ${deliberationStateJson}
            ELSE deliberation_state_json
          END,
          started_at = CASE
            WHEN ${hasStartedAt ? 1 : 0} = 1
              THEN ${input.startedAt ?? null}
            ELSE started_at
          END,
          completed_at = CASE
            WHEN ${hasCompletedAt ? 1 : 0} = 1
              THEN ${input.completedAt ?? null}
            ELSE completed_at
          END
        WHERE phase_run_id = ${input.phaseRunId}
      `;
    },
  });

  const upsert: ProjectionPhaseRunRepositoryShape["upsert"] = (row) =>
    upsertProjectionPhaseRunRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPhaseRunRepository.upsert:query")),
    );

  const queryById: ProjectionPhaseRunRepositoryShape["queryById"] = (input) =>
    queryProjectionPhaseRunByIdRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionPhaseRunRepository.queryById:query",
          "ProjectionPhaseRunRepository.queryById:decodeRow",
        ),
      ),
    );

  const queryByThreadId: ProjectionPhaseRunRepositoryShape["queryByThreadId"] = (input) =>
    queryProjectionPhaseRunRowsByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionPhaseRunRepository.queryByThreadId:query",
          "ProjectionPhaseRunRepository.queryByThreadId:decodeRows",
        ),
      ),
    );

  const updateStatus: ProjectionPhaseRunRepositoryShape["updateStatus"] = (input) =>
    updateProjectionPhaseRunStatusRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPhaseRunRepository.updateStatus:query")),
    );

  return {
    upsert,
    queryById,
    queryByThreadId,
    updateStatus,
  } satisfies ProjectionPhaseRunRepositoryShape;
});

export const ProjectionPhaseRunRepositoryLive = Layer.effect(
  ProjectionPhaseRunRepository,
  makeProjectionPhaseRunRepository,
);
