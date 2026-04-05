/**
 * ProjectionPhaseRunRepository - Projection repository interface for phase runs.
 *
 * Owns persistence operations for projected workflow phase execution records in
 * the orchestration read model.
 *
 * @module ProjectionPhaseRunRepository
 */
import {
  DeliberationState,
  GateResult,
  IsoDateTime,
  PhaseRunId,
  PhaseRunStatus,
  PhaseType,
  PositiveInt,
  ProviderSandboxMode,
  QualityCheckResult,
  ThreadId,
  TrimmedNonEmptyString,
  WorkflowId,
  WorkflowPhaseId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionPhaseRun = Schema.Struct({
  phaseRunId: PhaseRunId,
  threadId: ThreadId,
  workflowId: WorkflowId,
  phaseId: WorkflowPhaseId,
  phaseName: TrimmedNonEmptyString,
  phaseType: PhaseType,
  sandboxMode: Schema.NullOr(ProviderSandboxMode),
  iteration: PositiveInt,
  status: PhaseRunStatus,
  gateResult: Schema.NullOr(GateResult),
  qualityChecks: Schema.NullOr(Schema.Array(QualityCheckResult)),
  deliberationState: Schema.NullOr(DeliberationState),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionPhaseRun = typeof ProjectionPhaseRun.Type;

export const QueryProjectionPhaseRunByIdInput = Schema.Struct({
  phaseRunId: PhaseRunId,
});
export type QueryProjectionPhaseRunByIdInput = typeof QueryProjectionPhaseRunByIdInput.Type;

export const QueryProjectionPhaseRunsByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type QueryProjectionPhaseRunsByThreadIdInput =
  typeof QueryProjectionPhaseRunsByThreadIdInput.Type;

export const UpdateProjectionPhaseRunStatusInput = Schema.Struct({
  phaseRunId: PhaseRunId,
  status: PhaseRunStatus,
  gateResult: Schema.optional(Schema.NullOr(GateResult)),
  qualityChecks: Schema.optional(Schema.NullOr(Schema.Array(QualityCheckResult))),
  deliberationState: Schema.optional(Schema.NullOr(DeliberationState)),
  startedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  completedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type UpdateProjectionPhaseRunStatusInput = typeof UpdateProjectionPhaseRunStatusInput.Type;

/**
 * ProjectionPhaseRunRepositoryShape - Service API for persisted phase-run rows.
 */
export interface ProjectionPhaseRunRepositoryShape {
  /**
   * Insert or replace a phase-run row.
   *
   * Upserts by `phaseRunId`.
   */
  readonly upsert: (row: ProjectionPhaseRun) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a phase-run row by id.
   */
  readonly queryById: (
    input: QueryProjectionPhaseRunByIdInput,
  ) => Effect.Effect<Option.Option<ProjectionPhaseRun>, ProjectionRepositoryError>;

  /**
   * List phase-run rows for a thread.
   *
   * Returned in deterministic execution order.
   */
  readonly queryByThreadId: (
    input: QueryProjectionPhaseRunsByThreadIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionPhaseRun>, ProjectionRepositoryError>;

  /**
   * Update a phase-run's status and selected materialized fields.
   *
   * Omitted optional fields preserve the existing persisted value.
   */
  readonly updateStatus: (
    input: UpdateProjectionPhaseRunStatusInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionPhaseRunRepository - Service tag for phase-run projection persistence.
 */
export class ProjectionPhaseRunRepository extends ServiceMap.Service<
  ProjectionPhaseRunRepository,
  ProjectionPhaseRunRepositoryShape
>()("t3/persistence/Services/ProjectionPhaseRuns/ProjectionPhaseRunRepository") {}
