import { Schema } from "effect";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export class ChannelServiceChannelNotFoundError extends Schema.TaggedErrorClass<ChannelServiceChannelNotFoundError>()(
  "ChannelServiceChannelNotFoundError",
  {
    channelId: Schema.String,
  },
) {
  override get message(): string {
    return `Channel service could not find channel '${this.channelId}'.`;
  }
}

export class ChannelServiceMessageNotFoundError extends Schema.TaggedErrorClass<ChannelServiceMessageNotFoundError>()(
  "ChannelServiceMessageNotFoundError",
  {
    messageId: Schema.String,
    channelId: Schema.String,
  },
) {
  override get message(): string {
    return `Channel service could not read message '${this.messageId}' for channel '${this.channelId}'.`;
  }
}

export class DeliberationEngineChannelNotFoundError extends Schema.TaggedErrorClass<DeliberationEngineChannelNotFoundError>()(
  "DeliberationEngineChannelNotFoundError",
  {
    channelId: Schema.String,
  },
) {
  override get message(): string {
    return `Deliberation engine could not find channel '${this.channelId}'.`;
  }
}

export class DeliberationEngineThreadNotFoundError extends Schema.TaggedErrorClass<DeliberationEngineThreadNotFoundError>()(
  "DeliberationEngineThreadNotFoundError",
  {
    threadId: Schema.String,
    channelId: Schema.String,
  },
) {
  override get message(): string {
    return `Deliberation engine could not resolve thread '${this.threadId}' for channel '${this.channelId}'.`;
  }
}

export class DeliberationEnginePhaseRunNotFoundError extends Schema.TaggedErrorClass<DeliberationEnginePhaseRunNotFoundError>()(
  "DeliberationEnginePhaseRunNotFoundError",
  {
    phaseRunId: Schema.String,
    channelId: Schema.String,
  },
) {
  override get message(): string {
    return `Deliberation engine could not resolve phase run '${this.phaseRunId}' for channel '${this.channelId}'.`;
  }
}

export class DeliberationEngineParticipantsInvalidError extends Schema.TaggedErrorClass<DeliberationEngineParticipantsInvalidError>()(
  "DeliberationEngineParticipantsInvalidError",
  {
    channelId: Schema.String,
    actual: Schema.Number,
  },
) {
  override get message(): string {
    return `Deliberation engine expected at least 2 participants for channel '${this.channelId}' but found ${this.actual}.`;
  }
}

export class DeliberationEngineParticipantNotFoundError extends Schema.TaggedErrorClass<DeliberationEngineParticipantNotFoundError>()(
  "DeliberationEngineParticipantNotFoundError",
  {
    channelId: Schema.String,
    participantThreadId: Schema.String,
  },
) {
  override get message(): string {
    return `Deliberation engine could not find participant '${this.participantThreadId}' on channel '${this.channelId}'.`;
  }
}

export class DeliberationEngineStateNotInitializedError extends Schema.TaggedErrorClass<DeliberationEngineStateNotInitializedError>()(
  "DeliberationEngineStateNotInitializedError",
  {
    channelId: Schema.String,
  },
) {
  override get message(): string {
    return `Deliberation engine state has not been initialized for channel '${this.channelId}'.`;
  }
}

export type ChannelServiceError =
  | OrchestrationDispatchError
  | ProjectionRepositoryError
  | ChannelServiceChannelNotFoundError
  | ChannelServiceMessageNotFoundError;

export type DeliberationEngineError =
  | ProjectionRepositoryError
  | DeliberationEngineChannelNotFoundError
  | DeliberationEngineThreadNotFoundError
  | DeliberationEnginePhaseRunNotFoundError
  | DeliberationEngineParticipantsInvalidError
  | DeliberationEngineParticipantNotFoundError
  | DeliberationEngineStateNotInitializedError;
