import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";
import { ModelSelection } from "./providerSchemas";

const decodePositiveInt = Schema.decodeUnknownSync(PositiveInt);
const DEFAULT_MAX_TURNS = decodePositiveInt(20);

export const DiscussionParticipant = Schema.Struct({
  role: TrimmedNonEmptyString,
  description: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  model: Schema.optional(ModelSelection),
  system: Schema.String,
});
export type DiscussionParticipant = typeof DiscussionParticipant.Type;

export const DiscussionSettings = Schema.Struct({
  maxTurns: PositiveInt.pipe(Schema.withDecodingDefault(() => DEFAULT_MAX_TURNS)),
});
export type DiscussionSettings = typeof DiscussionSettings.Type;

export const DiscussionDefinition = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  participants: Schema.Array(DiscussionParticipant).check(Schema.isMinLength(2)),
  settings: DiscussionSettings.pipe(
    Schema.withDecodingDefault(() => ({ maxTurns: DEFAULT_MAX_TURNS })),
  ),
});
export type DiscussionDefinition = typeof DiscussionDefinition.Type;

export const DiscussionScope = Schema.Literals(["project", "global"]);
export type DiscussionScope = typeof DiscussionScope.Type;

export const DiscussionSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  participantRoles: Schema.Array(TrimmedNonEmptyString),
  scope: DiscussionScope,
});
export type DiscussionSummary = typeof DiscussionSummary.Type;

export const DiscussionRecord = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String.pipe(Schema.withDecodingDefault(() => "")),
  participants: Schema.Array(DiscussionParticipant).check(Schema.isMinLength(2)),
  settings: DiscussionSettings.pipe(
    Schema.withDecodingDefault(() => ({ maxTurns: DEFAULT_MAX_TURNS })),
  ),
  scope: DiscussionScope,
});
export type DiscussionRecord = typeof DiscussionRecord.Type;

export const DiscussionManagedSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  participantRoles: Schema.Array(TrimmedNonEmptyString),
  scope: DiscussionScope,
  effective: Schema.Boolean,
});
export type DiscussionManagedSummary = typeof DiscussionManagedSummary.Type;
