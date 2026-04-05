import { Schema } from "effect";
import {
  ChannelId,
  ChannelMessageId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const ChannelType = Schema.Literals(["guidance", "deliberation", "review", "system"]);
export type ChannelType = typeof ChannelType.Type;

export const ChannelStatus = Schema.Literals(["open", "concluded", "closed"]);
export type ChannelStatus = typeof ChannelStatus.Type;

export const ChannelParticipantType = Schema.Literals(["human", "agent", "system"]);
export type ChannelParticipantType = typeof ChannelParticipantType.Type;

export const ChannelMessage = Schema.Struct({
  id: ChannelMessageId,
  channelId: ChannelId,
  sequence: NonNegativeInt,
  fromType: ChannelParticipantType,
  fromId: TrimmedNonEmptyString,
  fromRole: Schema.optional(TrimmedNonEmptyString),
  content: Schema.String,
  createdAt: IsoDateTime,
});
export type ChannelMessage = typeof ChannelMessage.Type;

export const Channel = Schema.Struct({
  id: ChannelId,
  threadId: ThreadId,
  phaseRunId: Schema.optional(TrimmedNonEmptyString),
  type: ChannelType,
  status: ChannelStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Channel = typeof Channel.Type;

export const DeliberationStrategy = Schema.Literals(["ping-pong"]);
export type DeliberationStrategy = typeof DeliberationStrategy.Type;

export const InjectionStatus = Schema.Literals(["injected", "response-received", "persisted"]);
export type InjectionStatus = typeof InjectionStatus.Type;

export const InjectionState = Schema.Struct({
  sessionId: ThreadId,
  injectedAtSequence: NonNegativeInt,
  turnCorrelationId: Schema.optional(TrimmedNonEmptyString),
  status: InjectionStatus,
});
export type InjectionState = typeof InjectionState.Type;

const decodeNonNegativeInt = Schema.decodeUnknownSync(NonNegativeInt);
const decodePositiveInt = Schema.decodeUnknownSync(PositiveInt);
const DEFAULT_DELIBERATION_STRATEGY: DeliberationStrategy = "ping-pong";
const DEFAULT_MAX_NUDGES = decodeNonNegativeInt(3);
const DEFAULT_STALL_TIMEOUT_MS = decodeNonNegativeInt(120000);
const INITIAL_TURN_COUNT = decodeNonNegativeInt(0);

export const DeliberationState = Schema.Struct({
  strategy: DeliberationStrategy,
  currentSpeaker: Schema.NullOr(ThreadId),
  turnCount: NonNegativeInt,
  maxTurns: PositiveInt,
  conclusionProposals: Schema.Record(Schema.String, Schema.String),
  concluded: Schema.Boolean,
  lastPostTimestamp: Schema.Record(Schema.String, IsoDateTime),
  nudgeCount: Schema.Record(Schema.String, NonNegativeInt),
  maxNudges: NonNegativeInt.pipe(Schema.withDecodingDefault(() => DEFAULT_MAX_NUDGES)),
  stallTimeoutMs: NonNegativeInt.pipe(Schema.withDecodingDefault(() => DEFAULT_STALL_TIMEOUT_MS)),
  injectionState: Schema.optional(InjectionState),
});
export type DeliberationState = typeof DeliberationState.Type;

export function createInitialDeliberationState(maxTurns: number): DeliberationState {
  return {
    strategy: DEFAULT_DELIBERATION_STRATEGY,
    currentSpeaker: null,
    turnCount: INITIAL_TURN_COUNT,
    maxTurns: decodePositiveInt(maxTurns),
    conclusionProposals: {},
    concluded: false,
    lastPostTimestamp: {},
    nudgeCount: {},
    maxNudges: DEFAULT_MAX_NUDGES,
    stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
  };
}
