import { ChannelId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionChannelReadRepository } from "../Services/ProjectionChannelReads.ts";
import { ProjectionChannelReadRepositoryLive } from "./ProjectionChannelReads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionChannelReadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionChannelReadRepository", (it) => {
  it.effect("reads missing cursors and upserts channel read positions", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionChannelReadRepository;
      const channelId = ChannelId.makeUnsafe("channel-read-cursor");
      const threadId = ThreadId.makeUnsafe("thread-read-cursor");

      const missing = yield* repository.getCursor({ channelId, threadId });
      assert.deepStrictEqual(Option.getOrNull(missing), null);

      yield* repository.updateCursor({
        channelId,
        threadId,
        lastReadSequence: -1,
        updatedAt: "2026-04-05T14:20:00.000Z",
      });

      yield* repository.updateCursor({
        channelId,
        threadId,
        lastReadSequence: 7,
        updatedAt: "2026-04-05T14:21:00.000Z",
      });

      const persisted = yield* repository.getCursor({ channelId, threadId });
      assert.deepStrictEqual(Option.getOrNull(persisted), {
        channelId,
        threadId,
        lastReadSequence: 7,
        updatedAt: "2026-04-05T14:21:00.000Z",
      });
    }),
  );
});
