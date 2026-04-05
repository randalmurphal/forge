import { ChannelId, ChannelMessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import {
  ProjectionChannelMessageRepository,
  QueryProjectionChannelMessagesByChannelIdInput,
} from "../Services/ProjectionChannelMessages.ts";
import { ProjectionChannelReadRepository } from "../Services/ProjectionChannelReads.ts";
import { ProjectionChannelMessageRepositoryLive } from "./ProjectionChannelMessages.ts";
import { ProjectionChannelReadRepositoryLive } from "./ProjectionChannelReads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(ProjectionChannelMessageRepositoryLive, ProjectionChannelReadRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("ProjectionChannelMessageRepository", (it) => {
  it.effect("decodes the default query limit without unchecked casts", () =>
    Effect.gen(function* () {
      const parsed = yield* Schema.decodeUnknownEffect(
        QueryProjectionChannelMessagesByChannelIdInput,
      )({
        channelId: " channel-default-limit ",
      });

      assert.strictEqual(parsed.channelId, "channel-default-limit");
      assert.strictEqual(parsed.limit, 50);
    }),
  );

  it.effect("stores channel messages, paginates by sequence cursor, and counts unread rows", () =>
    Effect.gen(function* () {
      const messages = yield* ProjectionChannelMessageRepository;
      const reads = yield* ProjectionChannelReadRepository;
      const channelId = ChannelId.makeUnsafe("channel-deliberation-pagination");
      const readerThreadId = ThreadId.makeUnsafe("thread-reader");

      yield* messages.insert({
        messageId: ChannelMessageId.makeUnsafe("message-1"),
        channelId,
        sequence: 0 as any,
        fromType: "human",
        fromId: "human",
        fromRole: null,
        content: "Need another pass",
        metadata: null,
        createdAt: "2026-04-05T14:10:00.000Z",
        deletedAt: null,
      });

      yield* messages.insert({
        messageId: ChannelMessageId.makeUnsafe("message-2"),
        channelId,
        sequence: 1 as any,
        fromType: "agent",
        fromId: "thread-child-reviewer",
        fromRole: "reviewer",
        content: "I found one issue",
        metadata: { severity: "high" },
        createdAt: "2026-04-05T14:11:00.000Z",
        deletedAt: null,
      });

      yield* messages.insert({
        messageId: ChannelMessageId.makeUnsafe("message-3"),
        channelId,
        sequence: 2 as any,
        fromType: "agent",
        fromId: "thread-child-implementer",
        fromRole: "implementer",
        content: "Applying the fix now",
        metadata: { source: "retry" },
        createdAt: "2026-04-05T14:12:00.000Z",
        deletedAt: null,
      });

      yield* messages.insert({
        messageId: ChannelMessageId.makeUnsafe("message-soft-deleted"),
        channelId,
        sequence: 3 as any,
        fromType: "system",
        fromId: "system",
        fromRole: null,
        content: "Retracted message",
        metadata: null,
        createdAt: "2026-04-05T14:13:00.000Z",
        deletedAt: "2026-04-05T14:14:00.000Z",
      });

      yield* messages.insert({
        messageId: ChannelMessageId.makeUnsafe("message-other-channel"),
        channelId: ChannelId.makeUnsafe("channel-other-pagination"),
        sequence: 0 as any,
        fromType: "system",
        fromId: "system",
        fromRole: null,
        content: "Other channel",
        metadata: null,
        createdAt: "2026-04-05T14:15:00.000Z",
        deletedAt: null,
      });

      const firstPage = yield* messages.queryByChannelId({
        channelId,
        limit: 2 as any,
      });
      assert.deepStrictEqual(
        firstPage.map((message) => message.sequence),
        [0, 1],
      );

      const secondPage = yield* messages.queryByChannelId({
        channelId,
        cursor: 1 as any,
        limit: 2 as any,
      });
      assert.deepStrictEqual(
        secondPage.map((message) => message.sequence),
        [2, 3],
      );

      const byId = yield* messages.queryById({
        messageId: ChannelMessageId.makeUnsafe("message-2"),
      });
      assert.deepStrictEqual(Option.getOrNull(byId), {
        messageId: ChannelMessageId.makeUnsafe("message-2"),
        channelId,
        sequence: 1,
        fromType: "agent",
        fromId: "thread-child-reviewer",
        fromRole: "reviewer",
        content: "I found one issue",
        metadata: { severity: "high" },
        createdAt: "2026-04-05T14:11:00.000Z",
        deletedAt: null,
      });

      const unreadBeforeCursor = yield* messages.getUnreadCount({
        channelId,
        threadId: readerThreadId,
      });
      assert.strictEqual(unreadBeforeCursor, 3);

      yield* reads.updateCursor({
        channelId,
        threadId: readerThreadId,
        lastReadSequence: 1 as any,
        updatedAt: "2026-04-05T14:16:00.000Z",
      });

      const unreadAfterCursor = yield* messages.getUnreadCount({
        channelId,
        threadId: readerThreadId,
      });
      assert.strictEqual(unreadAfterCursor, 1);
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored metadata json is invalid", () =>
    Effect.gen(function* () {
      const messages = yield* ProjectionChannelMessageRepository;
      const sql = yield* SqlClient.SqlClient;
      const channelId = ChannelId.makeUnsafe("channel-invalid-json");

      yield* sql`
        INSERT INTO channel_messages (
          message_id,
          channel_id,
          sequence,
          from_type,
          from_id,
          from_role,
          content,
          metadata_json,
          created_at,
          deleted_at
        )
        VALUES (
          ${ChannelMessageId.makeUnsafe("message-invalid-json")},
          ${channelId},
          ${0},
          ${"system"},
          ${"system"},
          ${null},
          ${"Broken metadata"},
          ${"{"},
          ${"2026-04-05T18:40:00.000Z"},
          ${null}
        )
      `;

      const result = yield* Effect.result(
        messages.queryByChannelId({
          channelId,
          limit: 10 as any,
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(result.failure));
        assert.ok(
          result.failure.operation.includes(
            "ProjectionChannelMessageRepository.queryByChannelId:decodeRows",
          ),
        );
      }
    }),
  );
});
