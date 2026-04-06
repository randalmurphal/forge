import {
  ChannelId,
  DeliberationState,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@forgetools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { DeliberationEngineError } from "../Errors.ts";

export const InitializeDeliberationInput = Schema.Struct({
  channelId: ChannelId,
  maxTurns: PositiveInt,
  initializedAt: Schema.optional(IsoDateTime),
});
export type InitializeDeliberationInput = typeof InitializeDeliberationInput.Type;

export const GetDeliberationStateInput = Schema.Struct({
  channelId: ChannelId,
});
export type GetDeliberationStateInput = typeof GetDeliberationStateInput.Type;

export const RecordDeliberationPostInput = Schema.Struct({
  channelId: ChannelId,
  participantThreadId: ThreadId,
  postedAt: IsoDateTime,
});
export type RecordDeliberationPostInput = typeof RecordDeliberationPostInput.Type;

export const RecordDeliberationConclusionInput = Schema.Struct({
  channelId: ChannelId,
  participantThreadId: ThreadId,
  summary: TrimmedNonEmptyString,
  proposedAt: IsoDateTime,
});
export type RecordDeliberationConclusionInput = typeof RecordDeliberationConclusionInput.Type;

export const RecoverDeliberationInput = Schema.Struct({
  channelId: ChannelId,
  now: Schema.optional(IsoDateTime),
});
export type RecoverDeliberationInput = typeof RecoverDeliberationInput.Type;

export const DeliberationNudgeDelivery = Schema.Literals(["queue", "inject"]);
export type DeliberationNudgeDelivery = typeof DeliberationNudgeDelivery.Type;

export const DeliberationNudge = Schema.Struct({
  participantThreadId: ThreadId,
  delivery: DeliberationNudgeDelivery,
  message: Schema.String,
});
export type DeliberationNudge = typeof DeliberationNudge.Type;

export const DeliberationReinjection = Schema.Struct({
  participantThreadId: ThreadId,
  injectedAtSequence: NonNegativeInt,
  turnCorrelationId: Schema.optional(TrimmedNonEmptyString),
});
export type DeliberationReinjection = typeof DeliberationReinjection.Type;

export const DeliberationTransition = Schema.Struct({
  state: DeliberationState,
  participantThreadIds: Schema.Array(ThreadId),
  nextSpeaker: Schema.NullOr(ThreadId),
  shouldConcludeChannel: Schema.Boolean,
  forcedConclusion: Schema.Boolean,
  nudge: Schema.optional(DeliberationNudge),
  reinjection: Schema.optional(DeliberationReinjection),
});
export type DeliberationTransition = typeof DeliberationTransition.Type;

export interface DeliberationEngineShape {
  readonly initialize: (
    input: InitializeDeliberationInput,
  ) => Effect.Effect<DeliberationState, DeliberationEngineError>;
  readonly getState: (
    input: GetDeliberationStateInput,
  ) => Effect.Effect<Option.Option<DeliberationState>, DeliberationEngineError>;
  readonly recordPost: (
    input: RecordDeliberationPostInput,
  ) => Effect.Effect<DeliberationTransition, DeliberationEngineError>;
  readonly recordConclusionProposal: (
    input: RecordDeliberationConclusionInput,
  ) => Effect.Effect<DeliberationTransition, DeliberationEngineError>;
  readonly recover: (
    input: RecoverDeliberationInput,
  ) => Effect.Effect<DeliberationTransition, DeliberationEngineError>;
}

export class DeliberationEngine extends ServiceMap.Service<
  DeliberationEngine,
  DeliberationEngineShape
>()("forge/channel/Services/DeliberationEngine") {}
