import { createHash } from "node:crypto";

import {
  ChannelId,
  ProjectId,
  ThreadId,
  type Channel,
  type ChannelMessage,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, ManagedRuntime, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ChannelServiceShape } from "../Services/ChannelService.ts";
import { ChannelService } from "../Services/ChannelService.ts";
import { makeMcpChannelServer } from "./McpChannelServer.ts";

const channelId = ChannelId.makeUnsafe("channel-mcp");
const projectId = ProjectId.makeUnsafe("project-mcp");
const parentThreadId = ThreadId.makeUnsafe("thread-parent");
const participantAId = ThreadId.makeUnsafe("thread-participant-a");
const participantBId = ThreadId.makeUnsafe("thread-participant-b");
const createdAt = "2026-04-05T20:00:00.000Z";
const TOOL_CALL_PROVIDER = "claudeAgent";

function idempotencyKey(
  sessionId: ThreadId,
  toolName: string,
  args: unknown,
  channelStreamVersion: number,
): string {
  return createHash("sha256")
    .update(`${sessionId}:${toolName}:${JSON.stringify(args)}:${channelStreamVersion}`)
    .digest("hex");
}

function buildReadModel(channel: Channel): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: createdAt,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: parentThreadId,
        projectId,
        title: "Parent",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        deletedAt: null,
        parentThreadId: null,
        phaseRunId: null,
        workflowId: null,
        currentPhaseId: null,
        patternId: null,
        role: null,
        childThreadIds: [participantAId, participantBId],
        bootstrapStatus: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
      {
        id: participantAId,
        projectId,
        title: "Participant A",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        deletedAt: null,
        parentThreadId,
        phaseRunId: null,
        workflowId: null,
        currentPhaseId: null,
        patternId: null,
        role: "advocate",
        childThreadIds: [],
        bootstrapStatus: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
      {
        id: participantBId,
        projectId,
        title: "Participant B",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        deletedAt: null,
        parentThreadId,
        phaseRunId: null,
        workflowId: null,
        currentPhaseId: null,
        patternId: null,
        role: "critic",
        childThreadIds: [],
        bootstrapStatus: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    phaseRuns: [],
    channels: [channel],
    pendingRequests: [],
    workflows: [],
  };
}

async function createHarness() {
  const messages = new Map<ChannelId, Array<ChannelMessage>>([[channelId, []]]);
  const cursors = new Map<string, number>();
  const commandReceipts = new Map<string, number>();
  let eventSequence = 0;

  const channel: Channel = {
    id: channelId,
    threadId: parentThreadId,
    type: "deliberation",
    status: "open",
    createdAt,
    updatedAt: createdAt,
  };
  const readModel = buildReadModel(channel);

  const runtime = ManagedRuntime.make(SqlitePersistenceMemory);
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));

  const nextChannelStreamVersion = async () => {
    const rows = await runtime.runPromise(sql<{ readonly streamVersion: number | null }>`
      SELECT MAX(stream_version) AS "streamVersion"
      FROM orchestration_events
      WHERE aggregate_kind = 'channel'
        AND stream_id = ${channelId}
    `);
    return (rows[0]?.streamVersion ?? -1) + 1;
  };

  const appendEvent = async (
    commandId: string,
    type: "channel.message-posted" | "channel.conclusion-proposed",
    payload: unknown,
    occurredAt: string,
  ) => {
    const existingSequence = commandReceipts.get(commandId);
    if (existingSequence !== undefined) {
      return {
        sequence: existingSequence,
      };
    }

    eventSequence += 1;
    const sequence = eventSequence;
    await runtime.runPromise(sql`
      INSERT INTO orchestration_events (
        event_id,
        aggregate_kind,
        stream_id,
        stream_version,
        event_type,
        occurred_at,
        command_id,
        causation_event_id,
        correlation_id,
        actor_kind,
        payload_json,
        metadata_json
      )
      VALUES (
        ${`event-${sequence}`},
        'channel',
        ${channelId},
        ${await nextChannelStreamVersion()},
        ${type},
        ${occurredAt},
        ${commandId},
        NULL,
        NULL,
        'client',
        ${JSON.stringify(payload)},
        '{}'
      )
    `);
    commandReceipts.set(commandId, sequence);
    return {
      sequence,
    };
  };

  const orchestrationService = {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    dispatch: ((command) =>
      Effect.promise(async () => {
        const concludeCommand = command as unknown as {
          readonly type: string;
          readonly commandId: string;
          readonly channelId: ChannelId;
          readonly threadId: ThreadId;
          readonly summary: string;
          readonly createdAt: string;
        };
        if (concludeCommand.type !== "channel.conclude") {
          throw new Error(`Unexpected command: ${concludeCommand.type}`);
        }

        return appendEvent(
          concludeCommand.commandId,
          "channel.conclusion-proposed",
          {
            channelId: concludeCommand.channelId,
            threadId: concludeCommand.threadId,
            summary: concludeCommand.summary,
            proposedAt: concludeCommand.createdAt,
          },
          concludeCommand.createdAt,
        );
      })) as OrchestrationEngineShape["dispatch"],
  } satisfies OrchestrationEngineShape;

  const channelService = {
    createChannel: () => Effect.succeed(channel),
    postMessage: (input: Parameters<ChannelServiceShape["postMessage"]>[0]) =>
      Effect.promise(async () => {
        const currentMessages = messages.get(input.channelId) ?? [];
        const messageId =
          input.messageId ??
          (`generated-message-${currentMessages.length}` as ChannelMessage["id"]);
        const createdAtValue = input.createdAt ?? createdAt;
        const nextMessage: ChannelMessage = {
          id: messageId,
          channelId: input.channelId,
          sequence: currentMessages.length,
          fromType: input.fromType,
          fromId: input.fromId,
          ...(input.fromRole === undefined ? {} : { fromRole: input.fromRole }),
          content: input.content,
          createdAt: createdAtValue,
        };

        messages.set(input.channelId, [...currentMessages, nextMessage]);
        cursors.set(
          `${input.channelId}:${input.cursorThreadId ?? input.fromId}`,
          nextMessage.sequence,
        );
        await appendEvent(
          input.commandId ?? `generated-command:${messageId}`,
          "channel.message-posted",
          {
            channelId: nextMessage.channelId,
            messageId: nextMessage.id,
            sequence: nextMessage.sequence,
            fromType: nextMessage.fromType,
            fromId: nextMessage.fromId,
            fromRole: nextMessage.fromRole ?? null,
            content: nextMessage.content,
            createdAt: nextMessage.createdAt,
          },
          nextMessage.createdAt,
        );
        return nextMessage;
      }),
    getMessages: (input: Parameters<ChannelServiceShape["getMessages"]>[0]) =>
      Effect.succeed(
        (messages.get(input.channelId) ?? [])
          .filter((message) =>
            input.afterSequence === undefined ? true : message.sequence > input.afterSequence,
          )
          .slice(0, input.limit ?? Number.MAX_SAFE_INTEGER),
      ),
    getUnreadCount: (input: Parameters<ChannelServiceShape["getUnreadCount"]>[0]) =>
      Effect.succeed(
        (messages.get(input.channelId) ?? []).filter(
          (message) =>
            message.sequence > (cursors.get(`${input.channelId}:${input.sessionId}`) ?? -1),
        ).length,
      ),
    getCursor: (input: Parameters<ChannelServiceShape["getCursor"]>[0]) =>
      Effect.succeed(cursors.get(`${input.channelId}:${input.sessionId}`) ?? -1),
    advanceCursor: (input: Parameters<ChannelServiceShape["advanceCursor"]>[0]) =>
      Effect.sync(() => {
        cursors.set(`${input.channelId}:${input.sessionId}`, input.sequence);
      }),
  } satisfies ChannelServiceShape;

  const run = <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient | OrchestrationEngineService | ChannelService>,
  ) =>
    runtime.runPromise(
      effect.pipe(
        Effect.provideService(OrchestrationEngineService, orchestrationService),
        Effect.provideService(ChannelService, channelService),
      ),
    );

  const appendUnreadMessage = async (fromId: ThreadId, content: string, fromRole?: string) => {
    const currentMessages = messages.get(channelId) ?? [];
    const message: ChannelMessage = {
      id: `message-${currentMessages.length}` as ChannelMessage["id"],
      channelId,
      sequence: currentMessages.length,
      fromType: "agent",
      fromId,
      ...(fromRole === undefined ? {} : { fromRole }),
      content,
      createdAt: `2026-04-05T20:00:0${currentMessages.length}.000Z`,
    };
    messages.set(channelId, [...currentMessages, message]);
    await appendEvent(
      `seed-message-${message.sequence}`,
      "channel.message-posted",
      {
        channelId,
        messageId: message.id,
        sequence: message.sequence,
        fromType: message.fromType,
        fromId: message.fromId,
        fromRole: message.fromRole ?? null,
        content: message.content,
        createdAt: message.createdAt,
      },
      message.createdAt,
    );
    return message;
  };

  const countRows = async (table: "tool_call_results" | "orchestration_events") => {
    const query =
      table === "tool_call_results"
        ? sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM tool_call_results
          `
        : sql<{ readonly count: number }>`
            SELECT COUNT(*) AS "count"
            FROM orchestration_events
          `;
    const rows = await runtime.runPromise(query);
    return rows[0]?.count ?? 0;
  };

  const insertCachedToolResult = async (
    threadId: ThreadId,
    toolName: string,
    callId: string,
    result: unknown,
  ) => {
    await runtime.runPromise(sql`
      INSERT INTO tool_call_results (
        provider,
        thread_id,
        call_id,
        tool_name,
        result_json,
        created_at
      )
      VALUES (
        ${TOOL_CALL_PROVIDER},
        ${threadId},
        ${callId},
        ${toolName},
        ${JSON.stringify(result)},
        ${createdAt}
      )
    `);
  };

  return {
    run,
    appendUnreadMessage,
    countRows,
    insertCachedToolResult,
    dispose: () => runtime.dispose(),
  };
}

function parseToolText(result: {
  readonly content: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
  }>;
}) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

it.effect(
  "post_to_channel executes against the channel and returns persisted message metadata",
  () =>
    Effect.promise(async () => {
      const harness = await createHarness();
      try {
        const server = await harness.run(
          makeMcpChannelServer({
            channelId,
            participantThreadId: participantAId,
            participantRole: "advocate",
          }),
        );

        assert.strictEqual(server.config.type, "sdk");

        const result = await server.handlers.postToChannel({
          message: "First deliberation point",
        });
        const parsed = parseToolText(result);

        assert.strictEqual(typeof parsed.messageId, "string");
        assert.strictEqual(parsed.sequence, 0);
        assert.strictEqual(await harness.countRows("orchestration_events"), 1);
      } finally {
        await harness.dispose();
      }
    }),
);

it.effect(
  "read_channel is replay-safe for the same cursor and re-runs after channel state changes",
  () =>
    Effect.promise(async () => {
      const harness = await createHarness();
      try {
        await harness.appendUnreadMessage(participantBId, "Unread message", "critic");
        const server = await harness.run(
          makeMcpChannelServer({
            channelId,
            participantThreadId: participantAId,
            participantRole: "advocate",
          }),
        );

        const first = await server.handlers.readChannel();
        const second = await server.handlers.readChannel();
        const firstParsed = parseToolText(first);
        const secondParsed = parseToolText(second);

        assert.deepStrictEqual(secondParsed, firstParsed);
        assert.strictEqual((firstParsed.messages as Array<unknown>).length, 1);
        assert.strictEqual(await harness.countRows("tool_call_results"), 1);

        await harness.appendUnreadMessage(participantBId, "Second unread message", "critic");
        const third = await server.handlers.readChannel();
        const thirdParsed = parseToolText(third);

        assert.strictEqual((thirdParsed.messages as Array<unknown>).length, 2);
        assert.strictEqual(await harness.countRows("tool_call_results"), 2);
      } finally {
        await harness.dispose();
      }
    }),
);

it.effect("propose_conclusion requires all participants to agree before reporting concluded", () =>
  Effect.promise(async () => {
    const harness = await createHarness();
    try {
      const participantA = await harness.run(
        makeMcpChannelServer({
          channelId,
          participantThreadId: participantAId,
          participantRole: "advocate",
        }),
      );
      const participantB = await harness.run(
        makeMcpChannelServer({
          channelId,
          participantThreadId: participantBId,
          participantRole: "critic",
        }),
      );

      const first = parseToolText(
        await participantA.handlers.proposeConclusion({
          summary: "I think we can stop here.",
        }),
      );
      assert.strictEqual(first.concluded, false);
      assert.deepStrictEqual(first.participantThreadIds, [participantAId, participantBId]);

      const second = parseToolText(
        await participantB.handlers.proposeConclusion({
          summary: "Agreed.",
        }),
      );
      assert.strictEqual(second.concluded, true);
      assert.deepStrictEqual(
        Object.keys(second.conclusionProposals as Record<string, string>).toSorted(),
        [participantAId, participantBId].toSorted(),
      );
    } finally {
      await harness.dispose();
    }
  }),
);

it.effect("preloaded cached results short-circuit replayed post_to_channel calls", () =>
  Effect.promise(async () => {
    const harness = await createHarness();
    try {
      const server = await harness.run(
        makeMcpChannelServer({
          channelId,
          participantThreadId: participantAId,
          participantRole: "advocate",
        }),
      );

      const callId = idempotencyKey(
        participantAId,
        "post_to_channel",
        { message: "Replay me" },
        -1,
      );
      const cachedResult = {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              messageId: "cached-message-id",
              sequence: 42,
            }),
          },
        ],
      };
      await harness.insertCachedToolResult(participantAId, "post_to_channel", callId, cachedResult);

      const result = await server.handlers.postToChannel({
        message: "Replay me",
      });

      assert.deepStrictEqual(result, cachedResult);
      assert.strictEqual(await harness.countRows("orchestration_events"), 0);
    } finally {
      await harness.dispose();
    }
  }),
);
