import { Schema, SchemaIssue } from "effect";

export class DiscussionRegistryFileError extends Schema.TaggedErrorClass<DiscussionRegistryFileError>()(
  "DiscussionRegistryFileError",
  {
    path: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Discussion registry file error in ${this.operation} (${this.path}): ${this.detail}`;
  }
}

export class DiscussionRegistryParseError extends Schema.TaggedErrorClass<DiscussionRegistryParseError>()(
  "DiscussionRegistryParseError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Discussion registry YAML parse error (${this.path}): ${this.detail}`;
  }
}

export class DiscussionRegistryDecodeError extends Schema.TaggedErrorClass<DiscussionRegistryDecodeError>()(
  "DiscussionRegistryDecodeError",
  {
    path: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Discussion registry decode error (${this.path}): ${this.issue}`;
  }
}

export class DiscussionRegistryInvariantError extends Schema.TaggedErrorClass<DiscussionRegistryInvariantError>()(
  "DiscussionRegistryInvariantError",
  {
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Discussion registry invariant failed (${this.path}): ${this.detail}`;
  }
}

export class DiscussionRegistryScopeError extends Schema.TaggedErrorClass<DiscussionRegistryScopeError>()(
  "DiscussionRegistryScopeError",
  {
    scope: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Discussion registry scope error for '${this.scope}': ${this.detail}`;
  }
}

export class DiscussionNotFoundError extends Schema.TaggedErrorClass<DiscussionNotFoundError>()(
  "DiscussionNotFoundError",
  {
    name: Schema.String,
    searchedPaths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Discussion '${this.name}' was not found in any configured discussion directory.`;
  }
}

export type DiscussionRegistryError =
  | DiscussionRegistryFileError
  | DiscussionRegistryParseError
  | DiscussionRegistryDecodeError
  | DiscussionRegistryInvariantError
  | DiscussionRegistryScopeError
  | DiscussionNotFoundError;

export function toDiscussionRegistryDecodeError(path: string) {
  return (error: Schema.SchemaError): DiscussionRegistryDecodeError =>
    new DiscussionRegistryDecodeError({
      path,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}
