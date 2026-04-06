/**
 * ProjectionPhaseOutputRepository - Projection repository interface for phase outputs.
 *
 * Owns persistence operations for materialized workflow phase outputs stored in
 * the `phase_outputs` projection table.
 *
 * @module ProjectionPhaseOutputRepository
 */
import { IsoDateTime, PhaseRunId, TrimmedNonEmptyString } from "@forgetools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

const ProjectionPhaseOutputMetadata = Schema.Record(Schema.String, Schema.Unknown);

export const ProjectionPhaseOutput = Schema.Struct({
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
  content: Schema.String,
  sourceType: TrimmedNonEmptyString,
  sourceId: Schema.NullOr(TrimmedNonEmptyString),
  metadata: Schema.NullOr(ProjectionPhaseOutputMetadata),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionPhaseOutput = typeof ProjectionPhaseOutput.Type;

export const QueryProjectionPhaseOutputsByPhaseRunIdInput = Schema.Struct({
  phaseRunId: PhaseRunId,
});
export type QueryProjectionPhaseOutputsByPhaseRunIdInput =
  typeof QueryProjectionPhaseOutputsByPhaseRunIdInput.Type;

export const QueryProjectionPhaseOutputByKeyInput = Schema.Struct({
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
});
export type QueryProjectionPhaseOutputByKeyInput = typeof QueryProjectionPhaseOutputByKeyInput.Type;

/**
 * ProjectionPhaseOutputRepositoryShape - Service API for persisted phase-output rows.
 */
export interface ProjectionPhaseOutputRepositoryShape {
  /**
   * Insert or replace a phase-output row.
   *
   * Upserts by the `(phaseRunId, outputKey)` composite key.
   */
  readonly upsert: (row: ProjectionPhaseOutput) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List all phase outputs for a phase run.
   *
   * Returned in deterministic output-key order.
   */
  readonly queryByPhaseRunId: (
    input: QueryProjectionPhaseOutputsByPhaseRunIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionPhaseOutput>, ProjectionRepositoryError>;

  /**
   * Read a single phase output by its composite key.
   */
  readonly queryByKey: (
    input: QueryProjectionPhaseOutputByKeyInput,
  ) => Effect.Effect<Option.Option<ProjectionPhaseOutput>, ProjectionRepositoryError>;
}

/**
 * ProjectionPhaseOutputRepository - Service tag for phase-output projection persistence.
 */
export class ProjectionPhaseOutputRepository extends ServiceMap.Service<
  ProjectionPhaseOutputRepository,
  ProjectionPhaseOutputRepositoryShape
>()("forge/persistence/Services/ProjectionPhaseOutputs/ProjectionPhaseOutputRepository") {}
