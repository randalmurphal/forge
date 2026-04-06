import { Schema } from "effect";

export class DaemonLockError extends Schema.TaggedErrorClass<DaemonLockError>()("DaemonLockError", {
  path: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `Daemon lock error (${this.path}): ${this.detail}`;
  }
}

export class DaemonStateFileError extends Schema.TaggedErrorClass<DaemonStateFileError>()(
  "DaemonStateFileError",
  {
    path: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Daemon state file error in ${this.operation} (${this.path}): ${this.detail}`;
  }
}

export class DaemonSocketError extends Schema.TaggedErrorClass<DaemonSocketError>()(
  "DaemonSocketError",
  {
    path: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Daemon socket error in ${this.operation} (${this.path}): ${this.detail}`;
  }
}

export class DaemonShutdownError extends Schema.TaggedErrorClass<DaemonShutdownError>()(
  "DaemonShutdownError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Daemon shutdown error: ${this.detail}`;
  }
}

export type DaemonServiceError =
  | DaemonLockError
  | DaemonStateFileError
  | DaemonSocketError
  | DaemonShutdownError;
