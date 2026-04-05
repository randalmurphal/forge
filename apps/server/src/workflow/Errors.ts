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

export class PromptResolverFileError extends Schema.TaggedErrorClass<PromptResolverFileError>()(
  "PromptResolverFileError",
  {
    path: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Prompt resolver file error in ${this.operation} (${this.path}): ${this.detail}`;
  }
}

export class PromptResolverParseError extends Schema.TaggedErrorClass<PromptResolverParseError>()(
  "PromptResolverParseError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Prompt resolver YAML parse error (${this.path}): ${this.detail}`;
  }
}

export class PromptResolverDecodeError extends Schema.TaggedErrorClass<PromptResolverDecodeError>()(
  "PromptResolverDecodeError",
  {
    path: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Prompt resolver decode error (${this.path}): ${this.issue}`;
  }
}

export class PromptResolverInvariantError extends Schema.TaggedErrorClass<PromptResolverInvariantError>()(
  "PromptResolverInvariantError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Prompt resolver invariant failed (${this.path}): ${this.detail}`;
  }
}

export class PromptTemplateNotFoundError extends Schema.TaggedErrorClass<PromptTemplateNotFoundError>()(
  "PromptTemplateNotFoundError",
  {
    name: Schema.String,
    searchedPaths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Prompt template '${this.name}' was not found in any configured prompt directory.`;
  }
}

export class QualityCheckRunnerFileError extends Schema.TaggedErrorClass<QualityCheckRunnerFileError>()(
  "QualityCheckRunnerFileError",
  {
    path: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Quality check runner file error in ${this.operation} (${this.path}): ${this.detail}`;
  }
}

export class QualityCheckRunnerParseError extends Schema.TaggedErrorClass<QualityCheckRunnerParseError>()(
  "QualityCheckRunnerParseError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Quality check runner parse error (${this.path}): ${this.detail}`;
  }
}

export class QualityCheckRunnerDecodeError extends Schema.TaggedErrorClass<QualityCheckRunnerDecodeError>()(
  "QualityCheckRunnerDecodeError",
  {
    path: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Quality check runner decode error (${this.path}): ${this.issue}`;
  }
}

export type WorkflowRegistryError =
  | ProjectionRepositoryError
  | WorkflowRegistryFileError
  | WorkflowRegistryParseError
  | WorkflowRegistryDecodeError
  | WorkflowRegistryInvariantError;

export type PromptResolverError =
  | PromptResolverFileError
  | PromptResolverParseError
  | PromptResolverDecodeError
  | PromptResolverInvariantError
  | PromptTemplateNotFoundError;

export type QualityCheckRunnerError =
  | QualityCheckRunnerFileError
  | QualityCheckRunnerParseError
  | QualityCheckRunnerDecodeError;

export function toWorkflowRegistryDecodeError(path: string) {
  return (error: Schema.SchemaError): WorkflowRegistryDecodeError =>
    new WorkflowRegistryDecodeError({
      path,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}

export function toPromptResolverDecodeError(path: string) {
  return (error: Schema.SchemaError): PromptResolverDecodeError =>
    new PromptResolverDecodeError({
      path,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}

export function toQualityCheckRunnerDecodeError(path: string) {
  return (error: Schema.SchemaError): QualityCheckRunnerDecodeError =>
    new QualityCheckRunnerDecodeError({
      path,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}
