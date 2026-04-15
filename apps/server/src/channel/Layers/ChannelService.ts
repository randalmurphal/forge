import {
  ChannelId,
  ChannelMessage,
  ChannelMessageId,
  CommandId,
  type ForgeCommand,
  NonNegativeInt,
  ThreadId,
} from "@forgetools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionChannelMessageRepository } from "../../persistence/Services/ProjectionChannelMessages.ts";
import {
  ChannelSequenceCursor,
  QUERY_PROJECTION_CHANNEL_MESSAGES_DEFAULT_LIMIT,
} from "../../persistence/Services/ProjectionChannelMessages.ts";
import { ProjectionChannelReadRepository } from "../../persistence/Services/ProjectionChannelReads.ts";
import { ChannelService, type ChannelServiceShape } from "../Services/ChannelService.ts";
import {
  ChannelServiceChannelNotFoundError,
  ChannelServiceMessageNotFoundError,
} from "../Errors.ts";

const decodeChannelSequenceCursor = Schema.decodeSync(ChannelSequenceCursor);
const decodeNonNegativeInt = Schema.decodeSync(NonNegativeInt);
const DEFAULT_CURSOR = decodeChannelSequenceCursor(-1);

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function toChannelMessage(row: {
  readonly messageId: ChannelMessageId;
  readonly channelId: ChannelId;
  readonly sequence: ChannelMessage["sequence"];
  readonly fromType: ChannelMessage["fromType"];
  readonly fromId: ChannelMessage["fromId"];
  readonly fromRole: string | null;
  readonly content: string;
  readonly createdAt: string;
}): ChannelMessage {
  return {
    id: row.messageId,
    channelId: row.channelId,
    sequence: decodeNonNegativeInt(row.sequence),
    fromType: row.fromType,
    fromId: row.fromId,
    ...(row.fromRole === null ? {} : { fromRole: row.fromRole }),
    content: row.content,
    createdAt: row.createdAt,
  };
}

export const makeChannelService = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const channelMessages = yield* ProjectionChannelMessageRepository;
  const channelReads = yield* ProjectionChannelReadRepository;

  const dispatchForgeCommand = (command: ForgeCommand) =>
    orchestrationEngine.dispatch(
      command as unknown as Parameters<typeof orchestrationEngine.dispatch>[0],
    );

  const resolveChannel = Effect.fn("ChannelService.resolveChannel")(function* (
    channelId: ChannelId,
  ) {
    const readModel = yield* orchestrationEngine.getRuntimeReadModel();
    const channel = readModel.channels.find((entry) => entry.id === channelId);
    if (!channel) {
      return yield* new ChannelServiceChannelNotFoundError({
        channelId,
      });
    }

    return channel;
  });

  const createChannel: ChannelServiceShape["createChannel"] = (input) =>
    Effect.gen(function* () {
      const channelId = input.channelId ?? ChannelId.makeUnsafe(randomId("channel"));
      const createdAt = input.createdAt ?? nowIso();
      const commandId = input.commandId ?? CommandId.makeUnsafe(`channel:create:${channelId}`);

      yield* dispatchForgeCommand({
        type: "channel.create",
        commandId,
        channelId,
        threadId: input.threadId,
        channelType: input.type,
        ...(input.phaseRunId === undefined ? {} : { phaseRunId: input.phaseRunId }),
        createdAt,
      });

      return yield* resolveChannel(channelId);
    });

  const postMessage: ChannelServiceShape["postMessage"] = (input) =>
    Effect.gen(function* () {
      yield* resolveChannel(input.channelId);

      const messageId = input.messageId ?? ChannelMessageId.makeUnsafe(randomId("channel-message"));
      const createdAt = input.createdAt ?? nowIso();
      const commandId =
        input.commandId ?? CommandId.makeUnsafe(`channel:post-message:${messageId}`);

      const dispatchResult = yield* dispatchForgeCommand({
        type: "channel.post-message",
        commandId,
        channelId: input.channelId,
        messageId,
        fromType: input.fromType,
        fromId: input.fromId,
        ...(input.fromRole === undefined ? {} : { fromRole: input.fromRole }),
        content: input.content,
        createdAt,
      });

      const cursorThreadId =
        input.cursorThreadId ??
        (input.fromType === "agent" ? ThreadId.makeUnsafe(input.fromId) : undefined);
      if (cursorThreadId !== undefined) {
        yield* channelReads.updateCursor({
          channelId: input.channelId,
          threadId: cursorThreadId,
          lastReadSequence: decodeChannelSequenceCursor(dispatchResult.sequence),
          updatedAt: createdAt,
        });
      }

      const persistedMessage = yield* channelMessages.queryById({
        messageId,
      });
      if (Option.isNone(persistedMessage)) {
        return yield* new ChannelServiceMessageNotFoundError({
          messageId,
          channelId: input.channelId,
        });
      }

      return toChannelMessage(persistedMessage.value);
    });

  const getMessages: ChannelServiceShape["getMessages"] = (input) =>
    Effect.gen(function* () {
      yield* resolveChannel(input.channelId);

      const rows = yield* channelMessages.queryByChannelId({
        channelId: input.channelId,
        ...(input.afterSequence === undefined ? {} : { cursor: input.afterSequence }),
        limit: input.limit ?? QUERY_PROJECTION_CHANNEL_MESSAGES_DEFAULT_LIMIT,
      });

      return rows.filter((row) => row.deletedAt === null).map(toChannelMessage);
    });

  const getUnreadCount: ChannelServiceShape["getUnreadCount"] = (input) =>
    Effect.gen(function* () {
      yield* resolveChannel(input.channelId);
      return yield* channelMessages.getUnreadCount({
        channelId: input.channelId,
        threadId: input.sessionId,
      });
    });

  const getCursor: ChannelServiceShape["getCursor"] = (input) =>
    Effect.gen(function* () {
      yield* resolveChannel(input.channelId);
      const cursor = yield* channelReads.getCursor({
        channelId: input.channelId,
        threadId: input.sessionId,
      });

      return Option.match(cursor, {
        onNone: () => DEFAULT_CURSOR,
        onSome: (value) => value.lastReadSequence,
      });
    });

  const advanceCursor: ChannelServiceShape["advanceCursor"] = (input) =>
    Effect.gen(function* () {
      yield* resolveChannel(input.channelId);
      yield* channelReads.updateCursor({
        channelId: input.channelId,
        threadId: input.sessionId,
        lastReadSequence: input.sequence,
        updatedAt: input.updatedAt ?? nowIso(),
      });
    });

  return {
    createChannel,
    postMessage,
    getMessages,
    getUnreadCount,
    getCursor,
    advanceCursor,
  } satisfies ChannelServiceShape;
});

export const ChannelServiceLive = Layer.effect(ChannelService, makeChannelService);
