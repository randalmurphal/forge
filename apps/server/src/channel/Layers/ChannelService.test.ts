import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChannelId,
  ChannelMessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  PhaseRunId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionChannelMessageRepositoryLive } from "../../persistence/Layers/ProjectionChannelMessages.ts";
import { ProjectionChannelReadRepositoryLive } from "../../persistence/Layers/ProjectionChannelReads.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ChannelService } from "../Services/ChannelService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { ChannelServiceLive } from "./ChannelService.ts";

const projectId = ProjectId.makeUnsafe("project-channel-service");
const parentThreadId = ThreadId.makeUnsafe("thread-parent-channel");
const participantAId = ThreadId.makeUnsafe("thread-participant-a");
const participantBId = ThreadId.makeUnsafe("thread-participant-b");
const phaseRunId = PhaseRunId.makeUnsafe("phase-run-channel");
const createdAt = "2026-04-05T18:00:00.000Z";

async function createChannelServiceSystem() {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "forge-channel-service-test-",
  });
  const dependenciesLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    ),
    ProjectionChannelMessageRepositoryLive,
    ProjectionChannelReadRepositoryLive,
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const layer = ChannelServiceLive.pipe(Layer.provideMerge(dependenciesLayer));

  const runtime = ManagedRuntime.make(layer);
  const channelService = await runtime.runPromise(Effect.service(ChannelService));
  const orchestrationEngine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

  return {
    channelService,
    orchestrationEngine,
    dispose: () => runtime.dispose(),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
  };
}

function postChannelMessage(
  system: Awaited<ReturnType<typeof createChannelServiceSystem>>,
  ...args: Parameters<(typeof system.channelService)["postMessage"]>
) {
  return system.channelService.postMessage(...args);
}

async function seedProjectAndThreads(
  system: Awaited<ReturnType<typeof createChannelServiceSystem>>,
) {
  await system.run(
    system.orchestrationEngine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create-channel-service"),
      projectId,
      title: "Channel Service Project",
      workspaceRoot: "/tmp/channel-service-project",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      createdAt,
    }),
  );

  for (const threadId of [parentThreadId, participantAId, participantBId]) {
    await system.run(
      system.orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`cmd-thread-create:${threadId}`),
        threadId,
        projectId,
        title: `Thread ${threadId}`,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
  }
}

it.effect("creates a channel and returns the materialized row", () =>
  Effect.promise(async () => {
    const system = await createChannelServiceSystem();
    try {
      await seedProjectAndThreads(system);

      const channel = await system.run(
        system.channelService.createChannel({
          threadId: parentThreadId,
          type: "deliberation",
          phaseRunId,
          channelId: ChannelId.makeUnsafe("channel-created-by-service"),
          createdAt,
        }),
      );

      assert.deepStrictEqual(channel, {
        id: ChannelId.makeUnsafe("channel-created-by-service"),
        threadId: parentThreadId,
        phaseRunId,
        type: "deliberation",
        status: "open",
        createdAt,
        updatedAt: createdAt,
      });
    } finally {
      await system.dispose();
    }
  }),
);

it.effect("posts messages, paginates by sequence cursor, and keeps reads pure", () =>
  Effect.promise(async () => {
    const system = await createChannelServiceSystem();
    try {
      await seedProjectAndThreads(system);

      const channel = await system.run(
        system.channelService.createChannel({
          threadId: parentThreadId,
          type: "deliberation",
          channelId: ChannelId.makeUnsafe("channel-pagination"),
          createdAt,
        }),
      );

      const first = await system.run(
        postChannelMessage(system, {
          channelId: channel.id,
          fromType: "agent",
          fromId: participantAId,
          fromRole: "advocate",
          content: "First response",
          createdAt: "2026-04-05T18:01:00.000Z",
        }),
      );
      const second = await system.run(
        postChannelMessage(system, {
          channelId: channel.id,
          fromType: "agent",
          fromId: participantBId,
          fromRole: "critic",
          content: "Second response",
          createdAt: "2026-04-05T18:02:00.000Z",
        }),
      );

      assert.strictEqual(second.sequence, first.sequence + 1);

      const allMessages = await system.run(
        system.channelService.getMessages({
          channelId: channel.id,
        }),
      );
      assert.deepStrictEqual(
        allMessages.map((message) => ({
          id: message.id,
          sequence: message.sequence,
          fromId: message.fromId,
        })),
        [
          {
            id: first.id,
            sequence: first.sequence,
            fromId: participantAId,
          },
          {
            id: second.id,
            sequence: second.sequence,
            fromId: participantBId,
          },
        ],
      );

      const pagedMessages = await system.run(
        system.channelService.getMessages({
          channelId: channel.id,
          afterSequence: first.sequence,
          limit: 1,
        }),
      );
      assert.deepStrictEqual(pagedMessages, [second]);

      const untouchedCursor = await system.run(
        system.channelService.getCursor({
          channelId: channel.id,
          sessionId: parentThreadId,
        }),
      );
      assert.strictEqual(untouchedCursor, -1);
    } finally {
      await system.dispose();
    }
  }),
);

it.effect(
  "tracks unread counts and explicit cursor advancement without changing cursor on read",
  () =>
    Effect.promise(async () => {
      const system = await createChannelServiceSystem();
      try {
        await seedProjectAndThreads(system);

        const channel = await system.run(
          system.channelService.createChannel({
            threadId: parentThreadId,
            type: "review",
            channelId: ChannelId.makeUnsafe("channel-cursor"),
            createdAt,
          }),
        );

        const message = await system.run(
          postChannelMessage(system, {
            channelId: channel.id,
            fromType: "agent",
            fromId: participantAId,
            fromRole: "reviewer",
            content: "Check this change",
            createdAt: "2026-04-05T18:03:00.000Z",
          }),
        );

        const postingCursor = await system.run(
          system.channelService.getCursor({
            channelId: channel.id,
            sessionId: participantAId,
          }),
        );
        assert.strictEqual(postingCursor, message.sequence);

        const initialUnreadForParticipantB = await system.run(
          system.channelService.getUnreadCount({
            channelId: channel.id,
            sessionId: participantBId,
          }),
        );
        assert.strictEqual(initialUnreadForParticipantB, 1);

        await system.run(
          system.channelService.getMessages({
            channelId: channel.id,
          }),
        );

        const cursorAfterRead = await system.run(
          system.channelService.getCursor({
            channelId: channel.id,
            sessionId: participantBId,
          }),
        );
        assert.strictEqual(cursorAfterRead, -1);

        await system.run(
          system.channelService.advanceCursor({
            channelId: channel.id,
            sessionId: participantBId,
            sequence: message.sequence,
            updatedAt: "2026-04-05T18:04:00.000Z",
          }),
        );

        const unreadAfterAdvance = await system.run(
          system.channelService.getUnreadCount({
            channelId: channel.id,
            sessionId: participantBId,
          }),
        );
        assert.strictEqual(unreadAfterAdvance, 0);
      } finally {
        await system.dispose();
      }
    }),
);

it.effect("deduplicates reposts when the same command id is replayed", () =>
  Effect.promise(async () => {
    const system = await createChannelServiceSystem();
    try {
      await seedProjectAndThreads(system);

      const channel = await system.run(
        system.channelService.createChannel({
          threadId: parentThreadId,
          type: "deliberation",
          channelId: ChannelId.makeUnsafe("channel-idempotent"),
          createdAt,
        }),
      );

      const input = {
        channelId: channel.id,
        fromType: "agent" as const,
        fromId: participantAId,
        fromRole: "advocate",
        content: "Replay-safe message",
        messageId: ChannelMessageId.makeUnsafe("channel-message-idempotent"),
        commandId: CommandId.makeUnsafe("cmd-channel-message-idempotent"),
        createdAt: "2026-04-05T18:05:00.000Z",
      };

      const first = await system.run(postChannelMessage(system, input));
      const second = await system.run(postChannelMessage(system, input));
      assert.deepStrictEqual(second, first);

      const messages = await system.run(
        system.channelService.getMessages({
          channelId: channel.id,
        }),
      );
      assert.deepStrictEqual(messages, [first]);
    } finally {
      await system.dispose();
    }
  }),
);
