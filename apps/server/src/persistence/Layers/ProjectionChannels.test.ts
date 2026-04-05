import { ChannelId, PhaseRunId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionChannelRepository } from "../Services/ProjectionChannels.ts";
import { ProjectionChannelRepositoryLive } from "./ProjectionChannels.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionChannelRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionChannelRepository", (it) => {
  it.effect("creates channels, lists them by thread, and updates status", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionChannelRepository;
      const threadId = ThreadId.makeUnsafe("thread-workflow-channel");

      yield* repository.create({
        channelId: ChannelId.makeUnsafe("channel-guidance"),
        threadId,
        phaseRunId: null,
        type: "guidance",
        status: "open",
        createdAt: "2026-04-05T14:00:00.000Z",
        updatedAt: "2026-04-05T14:00:00.000Z",
      });

      yield* repository.create({
        channelId: ChannelId.makeUnsafe("channel-deliberation"),
        threadId,
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-review"),
        type: "deliberation",
        status: "open",
        createdAt: "2026-04-05T14:01:00.000Z",
        updatedAt: "2026-04-05T14:01:00.000Z",
      });

      yield* repository.create({
        channelId: ChannelId.makeUnsafe("channel-other-thread"),
        threadId: ThreadId.makeUnsafe("thread-other-channel"),
        phaseRunId: null,
        type: "system",
        status: "closed",
        createdAt: "2026-04-05T14:02:00.000Z",
        updatedAt: "2026-04-05T14:02:00.000Z",
      });

      yield* repository.updateStatus({
        channelId: ChannelId.makeUnsafe("channel-deliberation"),
        status: "concluded",
        updatedAt: "2026-04-05T14:05:00.000Z",
      });

      const persisted = yield* repository.queryByThreadId({ threadId });
      assert.deepStrictEqual(persisted, [
        {
          channelId: ChannelId.makeUnsafe("channel-guidance"),
          threadId,
          phaseRunId: null,
          type: "guidance",
          status: "open",
          createdAt: "2026-04-05T14:00:00.000Z",
          updatedAt: "2026-04-05T14:00:00.000Z",
        },
        {
          channelId: ChannelId.makeUnsafe("channel-deliberation"),
          threadId,
          phaseRunId: PhaseRunId.makeUnsafe("phase-run-review"),
          type: "deliberation",
          status: "concluded",
          createdAt: "2026-04-05T14:01:00.000Z",
          updatedAt: "2026-04-05T14:05:00.000Z",
        },
      ]);
    }),
  );
});
