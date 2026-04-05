import { Schema, SchemaIssue } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export class WorkflowRegistryFileError extends Schema.TaggedErrorClass<WorkflowRegistryFileError>()(
  "WorkflowRegistryFileError",
  {
    path: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Workflow registry file error in ${this.operation} (${this.path}): ${this.detail}`;
  }
}

export class WorkflowRegistryParseError extends Schema.TaggedErrorClass<WorkflowRegistryParseError>()(
  "WorkflowRegistryParseError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Workflow registry YAML parse error (${this.path}): ${this.detail}`;
  }
}

export class WorkflowRegistryDecodeError extends Schema.TaggedErrorClass<WorkflowRegistryDecodeError>()(
  "WorkflowRegistryDecodeError",
  {
    path: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Workflow registry decode error (${this.path}): ${this.issue}`;
  }
}

export class WorkflowRegistryInvariantError extends Schema.TaggedErrorClass<WorkflowRegistryInvariantError>()(
  "WorkflowRegistryInvariantError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Workflow registry invariant failed (${this.path}): ${this.detail}`;
  }
}

export type WorkflowRegistryError =
  | ProjectionRepositoryError
  | WorkflowRegistryFileError
  | WorkflowRegistryParseError
  | WorkflowRegistryDecodeError
  | WorkflowRegistryInvariantError;

export function toWorkflowRegistryDecodeError(path: string) {
  return (error: Schema.SchemaError): WorkflowRegistryDecodeError =>
    new WorkflowRegistryDecodeError({
      path,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}
