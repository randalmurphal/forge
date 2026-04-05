import { TrimmedNonEmptyString, WorkflowDefinition, WorkflowId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { WorkflowRegistryError } from "../Errors.ts";

export const QueryWorkflowByIdInput = Schema.Struct({
  workflowId: WorkflowId,
});
export type QueryWorkflowByIdInput = typeof QueryWorkflowByIdInput.Type;

export const QueryWorkflowByNameInput = Schema.Struct({
  name: TrimmedNonEmptyString,
});
export type QueryWorkflowByNameInput = typeof QueryWorkflowByNameInput.Type;

export interface WorkflowRegistryShape {
  readonly queryAll: () => Effect.Effect<ReadonlyArray<WorkflowDefinition>, WorkflowRegistryError>;
  readonly queryById: (
    input: QueryWorkflowByIdInput,
  ) => Effect.Effect<Option.Option<WorkflowDefinition>, WorkflowRegistryError>;
  readonly queryByName: (
    input: QueryWorkflowByNameInput,
  ) => Effect.Effect<Option.Option<WorkflowDefinition>, WorkflowRegistryError>;
}

export class WorkflowRegistry extends ServiceMap.Service<WorkflowRegistry, WorkflowRegistryShape>()(
  "t3/workflow/Services/WorkflowRegistry",
) {}
