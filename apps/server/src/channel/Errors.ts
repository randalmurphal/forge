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

export type ChannelServiceError =
  | OrchestrationDispatchError
  | ProjectionRepositoryError
  | ChannelServiceChannelNotFoundError
  | ChannelServiceMessageNotFoundError;
