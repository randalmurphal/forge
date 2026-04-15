import {
  IsoDateTime,
  OrchestrationAgentDiffCoverage,
  OrchestrationAgentDiffSource,
  OrchestrationCheckpointFile,
  MessageId,
  ThreadId,
  TurnId,
} from "@forgetools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionAgentDiff = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  diff: Schema.String,
  files: Schema.Array(OrchestrationCheckpointFile),
  source: OrchestrationAgentDiffSource,
  coverage: OrchestrationAgentDiffCoverage,
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionAgentDiff = typeof ProjectionAgentDiff.Type;

export const ProjectionAgentDiffByTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type ProjectionAgentDiffByTurnInput = typeof ProjectionAgentDiffByTurnInput.Type;

export const ProjectionAgentDiffListByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProjectionAgentDiffListByThreadInput = typeof ProjectionAgentDiffListByThreadInput.Type;

export const ProjectionAgentDiffDeleteByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProjectionAgentDiffDeleteByThreadInput =
  typeof ProjectionAgentDiffDeleteByThreadInput.Type;

export interface ProjectionAgentDiffRepositoryShape {
  readonly append: (row: ProjectionAgentDiff) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ProjectionAgentDiffListByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionAgentDiff>, ProjectionRepositoryError>;
  readonly getLatestByTurnId: (
    input: ProjectionAgentDiffByTurnInput,
  ) => Effect.Effect<Option.Option<ProjectionAgentDiff>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: ProjectionAgentDiffDeleteByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionAgentDiffRepository extends ServiceMap.Service<
  ProjectionAgentDiffRepository,
  ProjectionAgentDiffRepositoryShape
>()("forge/persistence/Services/ProjectionAgentDiffs/ProjectionAgentDiffRepository") {}
