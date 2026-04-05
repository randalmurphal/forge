import { ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { formatChannelTranscript } from "../../channel/Utils.ts";
import { toPersistenceSqlOrDecodeError } from "../../persistence/Errors.ts";
import {
  ProjectionChannelMessageRepository,
  QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT,
} from "../../persistence/Services/ProjectionChannelMessages.ts";
import { ProjectionChannelRepository } from "../../persistence/Services/ProjectionChannels.ts";
import { ProjectionPhaseOutputRepository } from "../../persistence/Services/ProjectionPhaseOutputs.ts";
import { ProjectionPhaseRunRepository } from "../../persistence/Services/ProjectionPhaseRuns.ts";
import type { ProjectionChannelMessage } from "../../persistence/Services/ProjectionChannelMessages.ts";
import {
  InputResolverInvalidReferenceError,
  InputResolverMissingReferenceError,
} from "../Errors.ts";

const PromotedFromLinkRow = Schema.Struct({
  linkedSessionId: ThreadId,
});
const decodeTrimmedNonEmptyString = Schema.decodeSync(TrimmedNonEmptyString);

type ParsedInputReference =
  | {
      readonly _tag: "phase-output";
      readonly phaseName: string;
      readonly outputKey: string;
    }
  | {
      readonly _tag: "promoted-from-channel";
    };

function parseReference(reference: string): ParsedInputReference {
  const trimmedReference = reference.trim();
  if (trimmedReference === "promoted-from.channel") {
    return { _tag: "promoted-from-channel" };
  }

  const firstDotIndex = trimmedReference.indexOf(".");
  if (firstDotIndex <= 0 || firstDotIndex === trimmedReference.length - 1) {
    throw new InputResolverInvalidReferenceError({
      reference,
      detail: "Expected '<phaseName>.<outputKey>' or 'promoted-from.channel' inputFrom reference.",
    });
  }

  const phaseName = trimmedReference.slice(0, firstDotIndex).trim();
  const outputKey = trimmedReference.slice(firstDotIndex + 1).trim();
  if (phaseName.length === 0 || outputKey.length === 0) {
    throw new InputResolverInvalidReferenceError({
      reference,
      detail: "Expected non-empty phase and output segments in the inputFrom reference string.",
    });
  }

  return {
    _tag: "phase-output",
    phaseName,
    outputKey,
  };
}

function toTranscriptMessage(message: ProjectionChannelMessage) {
  const transcriptMessage = {
    fromType: message.fromType,
    fromId: message.fromId,
    content: message.content,
  };
  if (message.fromRole !== null) {
    return {
      ...transcriptMessage,
      fromRole: message.fromRole,
    };
  }
  return transcriptMessage;
}

export const resolveInputFrom = Effect.fn("workflow.resolveInputFrom")(function* (
  reference: string,
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const phaseRuns = yield* ProjectionPhaseRunRepository;
  const phaseOutputs = yield* ProjectionPhaseOutputRepository;
  const channels = yield* ProjectionChannelRepository;
  const channelMessages = yield* ProjectionChannelMessageRepository;

  const lookupPromotedFromLink = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: ThreadId,
    }),
    Result: PromotedFromLinkRow,
    execute: ({ threadId }) =>
      sql`
        SELECT linked_session_id AS "linkedSessionId"
        FROM session_links
        WHERE session_id = ${threadId}
          AND link_type = 'promoted-from'
          AND linked_session_id IS NOT NULL
        ORDER BY updated_at DESC, created_at DESC, link_id DESC
        LIMIT 1
      `,
  });

  const parsedReference = yield* Effect.try({
    try: () => parseReference(reference),
    catch: (cause) =>
      Schema.is(InputResolverInvalidReferenceError)(cause)
        ? cause
        : new InputResolverInvalidReferenceError({
            reference,
            detail: cause instanceof Error ? cause.message : "Invalid inputFrom reference.",
          }),
  });

  if (parsedReference._tag === "phase-output") {
    const completedPhaseRuns = yield* phaseRuns.queryByThreadId({ threadId }).pipe(
      Effect.map((rows) =>
        rows
          .filter(
            (row) => row.phaseName === parsedReference.phaseName && row.status === "completed",
          )
          .toSorted((left, right) => {
            if (left.iteration !== right.iteration) {
              return right.iteration - left.iteration;
            }
            return (right.completedAt ?? "").localeCompare(left.completedAt ?? "");
          }),
      ),
    );

    const latestCompletedPhaseRun = completedPhaseRuns[0];
    if (!latestCompletedPhaseRun) {
      return yield* new InputResolverMissingReferenceError({
        threadId,
        reference,
        detail: `No completed phase named '${parsedReference.phaseName}' was found on this thread.`,
      });
    }

    const phaseOutput = yield* phaseOutputs.queryByKey({
      phaseRunId: latestCompletedPhaseRun.phaseRunId,
      outputKey: decodeTrimmedNonEmptyString(parsedReference.outputKey),
    });
    if (Option.isNone(phaseOutput)) {
      return yield* new InputResolverMissingReferenceError({
        threadId,
        reference,
        detail: `Phase '${parsedReference.phaseName}' has no output '${parsedReference.outputKey}'.`,
      });
    }

    return phaseOutput.value.content;
  }

  const promotedFromLink = yield* lookupPromotedFromLink({ threadId }).pipe(
    Effect.mapError(
      toPersistenceSqlOrDecodeError(
        "InputResolver.lookupPromotedFromLink:query",
        "InputResolver.lookupPromotedFromLink:decodeRow",
      ),
    ),
  );

  if (Option.isNone(promotedFromLink)) {
    return yield* new InputResolverMissingReferenceError({
      threadId,
      reference,
      detail: "This thread does not have a promoted-from session link.",
    });
  }

  const promotedChannels = yield* channels.queryByThreadId({
    threadId: promotedFromLink.value.linkedSessionId,
  });
  const deliberationChannel = promotedChannels
    .toReversed()
    .find((channel) => channel.type === "deliberation");
  if (!deliberationChannel) {
    return yield* new InputResolverMissingReferenceError({
      threadId,
      reference,
      detail: "The promoted source session does not have a deliberation channel.",
    });
  }

  const allMessages: Array<ProjectionChannelMessage> = [];
  let cursor: number | undefined = undefined;
  for (;;) {
    const page: ReadonlyArray<ProjectionChannelMessage> = yield* channelMessages.queryByChannelId({
      channelId: deliberationChannel.channelId,
      ...(cursor === undefined ? {} : { cursor }),
      limit: QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT,
    });

    const visibleMessages = page.filter((message) => message.deletedAt === null);
    allMessages.push(...visibleMessages);
    if (page.length < QUERY_PROJECTION_CHANNEL_MESSAGES_MAX_LIMIT) {
      break;
    }

    cursor = page.at(-1)?.sequence;
  }

  return formatChannelTranscript(allMessages.map(toTranscriptMessage));
});
