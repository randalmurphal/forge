import {
  ChannelId,
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  type ForgeEvent,
  InteractiveRequestId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const makeProjectionPipelinePrefixedTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* Effect.result(fileSystem.stat(filePath));
    return fileInfo._tag === "Success";
  });

const BaseTestLayer = makeProjectionPipelinePrefixedTestLayer("t3-projection-pipeline-test-");

function makeForgeEvent(input: {
  sequence: number;
  type: ForgeEvent["type"];
  aggregateKind: ForgeEvent["aggregateKind"];
  aggregateId: string;
  occurredAt: string;
  commandId: string | null;
  payload: unknown;
}): ForgeEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`forge-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.makeUnsafe(input.aggregateId)
        : input.aggregateKind === "channel"
          ? ChannelId.makeUnsafe(input.aggregateId)
          : input.aggregateKind === "request"
            ? InteractiveRequestId.makeUnsafe(input.aggregateId)
            : ThreadId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    causationEventId: null,
    correlationId: input.commandId === null ? null : CorrelationId.makeUnsafe(input.commandId),
    metadata: {},
    payload: input.payload as never,
  } as ForgeEvent;
}

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("bootstraps all projection states and writes projection rows", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-1"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const projectRows = yield* sql<{
        readonly projectId: string;
        readonly title: string;
        readonly scriptsJson: string;
      }>`
        SELECT
          project_id AS "projectId",
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
      `;
      assert.deepEqual(projectRows, [
        { projectId: "project-1", title: "Project 1", scriptsJson: "[]" },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly text: string;
      }>`
        SELECT
          message_id AS "messageId",
          text
        FROM projection_thread_messages
      `;
      assert.deepEqual(messageRows, [{ messageId: "message-1", text: "hello" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        ORDER BY projector ASC
      `;
      assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, 3);
      }
    }),
  );

  it.effect("projects phase runs, channels, messages, outputs, and interactive requests", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-04-05T15:00:00.000Z";
      const phaseStartedAt = "2026-04-05T15:01:00.000Z";
      const phaseCompletedAt = "2026-04-05T15:02:00.000Z";
      const channelCreatedAt = "2026-04-05T15:03:00.000Z";
      const channelMessageAt = "2026-04-05T15:04:00.000Z";
      const requestOpenedAt = "2026-04-05T15:05:00.000Z";
      const requestResolvedAt = "2026-04-05T15:06:00.000Z";

      const savedProjectCreated = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-foundation-project"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-foundation"),
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-foundation-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-foundation-project"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-foundation"),
          title: "Foundation project",
          workspaceRoot: "/tmp/foundation-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* projectionPipeline.projectEvent(savedProjectCreated);

      const savedThreadCreated = yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-foundation-thread"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-foundation"),
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-foundation-thread"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-foundation-thread"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-foundation"),
          projectId: ProjectId.makeUnsafe("project-foundation"),
          title: "Foundation thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* projectionPipeline.projectEvent(savedThreadCreated);

      yield* sql`
        UPDATE projection_threads
        SET workflow_id = 'workflow-foundation'
        WHERE thread_id = 'thread-foundation'
      `;

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 3,
          type: "thread.phase-started",
          aggregateKind: "thread",
          aggregateId: "thread-foundation",
          occurredAt: phaseStartedAt,
          commandId: "cmd-phase-started",
          payload: {
            threadId: "thread-foundation",
            phaseRunId: "phase-run-foundation",
            phaseId: "phase-plan",
            phaseName: "Plan",
            phaseType: "single-agent",
            iteration: 1,
            startedAt: phaseStartedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 4,
          type: "thread.phase-completed",
          aggregateKind: "thread",
          aggregateId: "thread-foundation",
          occurredAt: phaseCompletedAt,
          commandId: "cmd-phase-completed",
          payload: {
            threadId: "thread-foundation",
            phaseRunId: "phase-run-foundation",
            outputs: [
              {
                key: "summary",
                content: "Phase summary",
                sourceType: "agent",
              },
            ],
            completedAt: phaseCompletedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 5,
          type: "channel.created",
          aggregateKind: "thread",
          aggregateId: "thread-foundation",
          occurredAt: channelCreatedAt,
          commandId: "cmd-channel-created",
          payload: {
            channelId: "channel-foundation",
            threadId: "thread-foundation",
            channelType: "guidance",
            phaseRunId: "phase-run-foundation",
            createdAt: channelCreatedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 6,
          type: "channel.message-posted",
          aggregateKind: "thread",
          aggregateId: "thread-foundation",
          occurredAt: channelMessageAt,
          commandId: "cmd-channel-message",
          payload: {
            channelId: "channel-foundation",
            messageId: "channel-message-foundation",
            sequence: 0,
            fromType: "human",
            fromId: "user-1",
            fromRole: null,
            content: "Refine the plan",
            createdAt: channelMessageAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 7,
          type: "request.opened",
          aggregateKind: "thread",
          aggregateId: "thread-foundation",
          occurredAt: requestOpenedAt,
          commandId: "cmd-request-opened",
          payload: {
            requestId: "request-foundation",
            threadId: "thread-foundation",
            childThreadId: null,
            phaseRunId: "phase-run-foundation",
            requestType: "user-input",
            payload: {
              type: "user-input",
              questions: [{ id: "scope", question: "Ship it?" }],
            },
            createdAt: requestOpenedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 8,
          type: "request.resolved",
          aggregateKind: "thread",
          aggregateId: "thread-foundation",
          occurredAt: requestResolvedAt,
          commandId: "cmd-request-resolved",
          payload: {
            requestId: "request-foundation",
            resolvedWith: {
              answers: {
                scope: "yes",
              },
            },
            resolvedAt: requestResolvedAt,
          },
        }),
      );

      const phaseRunRows = yield* sql<{
        readonly phaseRunId: string;
        readonly workflowId: string;
        readonly status: string;
      }>`
        SELECT
          phase_run_id AS "phaseRunId",
          workflow_id AS "workflowId",
          status
        FROM phase_runs
        WHERE phase_run_id = 'phase-run-foundation'
      `;
      assert.deepEqual(phaseRunRows, [
        {
          phaseRunId: "phase-run-foundation",
          workflowId: "workflow-foundation",
          status: "completed",
        },
      ]);

      const phaseOutputRows = yield* sql<{
        readonly outputKey: string;
        readonly content: string;
      }>`
        SELECT
          output_key AS "outputKey",
          content
        FROM phase_outputs
        WHERE phase_run_id = 'phase-run-foundation'
      `;
      assert.deepEqual(phaseOutputRows, [
        {
          outputKey: "summary",
          content: "Phase summary",
        },
      ]);

      const channelRows = yield* sql<{
        readonly channelId: string;
        readonly status: string;
      }>`
        SELECT
          channel_id AS "channelId",
          status
        FROM channels
        WHERE channel_id = 'channel-foundation'
      `;
      assert.deepEqual(channelRows, [
        {
          channelId: "channel-foundation",
          status: "open",
        },
      ]);

      const channelMessageRows = yield* sql<{
        readonly messageId: string;
        readonly content: string;
      }>`
        SELECT
          message_id AS "messageId",
          content
        FROM channel_messages
        WHERE message_id = 'channel-message-foundation'
      `;
      assert.deepEqual(channelMessageRows, [
        {
          messageId: "channel-message-foundation",
          content: "Refine the plan",
        },
      ]);

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 9,
          type: "channel.messages-read",
          aggregateKind: "channel",
          aggregateId: "channel-foundation",
          occurredAt: requestResolvedAt,
          commandId: "cmd-channel-read",
          payload: {
            channelId: "channel-foundation",
            threadId: "thread-child",
            upToSequence: 0,
            readAt: requestResolvedAt,
          },
        }),
      );

      const channelReadRows = yield* sql<{
        readonly channelId: string;
        readonly threadId: string;
        readonly lastReadSequence: number;
      }>`
        SELECT
          channel_id AS "channelId",
          thread_id AS "threadId",
          last_read_sequence AS "lastReadSequence"
        FROM channel_reads
        WHERE channel_id = 'channel-foundation'
      `;
      assert.deepEqual(channelReadRows, [
        {
          channelId: "channel-foundation",
          threadId: "thread-child",
          lastReadSequence: 0,
        },
      ]);

      const requestRows = yield* sql<{
        readonly requestId: string;
        readonly status: string;
        readonly resolvedAt: string | null;
      }>`
        SELECT
          request_id AS "requestId",
          status,
          resolved_at AS "resolvedAt"
        FROM interactive_requests
        WHERE request_id = 'request-foundation'
      `;
      assert.deepEqual(requestRows, [
        {
          requestId: "request-foundation",
          status: "resolved",
          resolvedAt: requestResolvedAt,
        },
      ]);
    }),
  );

  it.effect("keeps channel read cursors monotonic when later events report an older sequence", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-04-05T15:10:00.000Z";
      const firstReadAt = "2026-04-05T15:11:00.000Z";
      const staleReadAt = "2026-04-05T15:12:00.000Z";

      yield* projectionPipeline.projectEvent(
        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-channel-read-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-channel-read"),
          occurredAt: createdAt,
          commandId: CommandId.makeUnsafe("cmd-channel-read-project"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-channel-read-project"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-channel-read"),
            title: "Channel read project",
            workspaceRoot: "/tmp/channel-read-project",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.makeUnsafe("evt-channel-read-thread"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-channel-read-parent"),
          occurredAt: createdAt,
          commandId: CommandId.makeUnsafe("cmd-channel-read-thread"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-channel-read-thread"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-channel-read-parent"),
            projectId: ProjectId.makeUnsafe("project-channel-read"),
            title: "Channel read thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 3,
          type: "channel.created",
          aggregateKind: "channel",
          aggregateId: "channel-read-monotonic",
          occurredAt: createdAt,
          commandId: "cmd-channel-read-created",
          payload: {
            channelId: "channel-read-monotonic",
            threadId: "thread-channel-read-parent",
            channelType: "guidance",
            phaseRunId: null,
            createdAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 4,
          type: "channel.messages-read",
          aggregateKind: "channel",
          aggregateId: "channel-read-monotonic",
          occurredAt: firstReadAt,
          commandId: "cmd-channel-read-high",
          payload: {
            channelId: "channel-read-monotonic",
            threadId: "thread-channel-read-child",
            upToSequence: 7,
            readAt: firstReadAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 5,
          type: "channel.messages-read",
          aggregateKind: "channel",
          aggregateId: "channel-read-monotonic",
          occurredAt: staleReadAt,
          commandId: "cmd-channel-read-stale",
          payload: {
            channelId: "channel-read-monotonic",
            threadId: "thread-channel-read-child",
            upToSequence: 3,
            readAt: staleReadAt,
          },
        }),
      );

      const channelReadRows = yield* sql<{
        readonly channelId: string;
        readonly threadId: string;
        readonly lastReadSequence: number;
        readonly updatedAt: string;
      }>`
        SELECT
          channel_id AS "channelId",
          thread_id AS "threadId",
          last_read_sequence AS "lastReadSequence",
          updated_at AS "updatedAt"
        FROM channel_reads
        WHERE channel_id = 'channel-read-monotonic'
      `;
      assert.deepEqual(channelReadRows, [
        {
          channelId: "channel-read-monotonic",
          threadId: "thread-channel-read-child",
          lastReadSequence: 7,
          updatedAt: firstReadAt,
        },
      ]);
    }),
  );

  it.effect(
    "projects staged turn and checkpoint lifecycle events into thread and turn tables",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const createdAt = "2026-04-05T15:20:00.000Z";
        const startedAt = "2026-04-05T15:20:05.000Z";
        const completedAt = "2026-04-05T15:20:07.000Z";
        const capturedAt = "2026-04-05T15:20:08.000Z";
        const revertedAt = "2026-04-05T15:20:09.000Z";

        yield* projectionPipeline.projectEvent(
          yield* eventStore.append({
            type: "project.created",
            eventId: EventId.makeUnsafe("evt-staged-turn-project"),
            aggregateKind: "project",
            aggregateId: ProjectId.makeUnsafe("project-staged-turn"),
            occurredAt: createdAt,
            commandId: CommandId.makeUnsafe("cmd-staged-turn-project"),
            causationEventId: null,
            correlationId: CommandId.makeUnsafe("cmd-staged-turn-project"),
            metadata: {},
            payload: {
              projectId: ProjectId.makeUnsafe("project-staged-turn"),
              title: "staged turn project",
              workspaceRoot: "/tmp/staged-turn-project",
              defaultModelSelection: null,
              scripts: [],
              createdAt,
              updatedAt: createdAt,
            },
          }),
        );

        yield* projectionPipeline.projectEvent(
          yield* eventStore.append({
            type: "thread.created",
            eventId: EventId.makeUnsafe("evt-staged-turn-thread"),
            aggregateKind: "thread",
            aggregateId: ThreadId.makeUnsafe("thread-staged-turn"),
            occurredAt: createdAt,
            commandId: CommandId.makeUnsafe("cmd-staged-turn-thread"),
            causationEventId: null,
            correlationId: CommandId.makeUnsafe("cmd-staged-turn-thread"),
            metadata: {},
            payload: {
              threadId: ThreadId.makeUnsafe("thread-staged-turn"),
              projectId: ProjectId.makeUnsafe("project-staged-turn"),
              title: "staged turn thread",
              modelSelection: {
                provider: "codex",
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
              updatedAt: createdAt,
            },
          }),
        );

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 3,
            type: "thread.turn-started",
            aggregateKind: "thread",
            aggregateId: "thread-staged-turn",
            occurredAt: startedAt,
            commandId: "cmd-staged-turn-started",
            payload: {
              threadId: "thread-staged-turn",
              turnId: "turn-staged-1",
              startedAt,
            },
          }),
        );

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 4,
            type: "thread.turn-completed",
            aggregateKind: "thread",
            aggregateId: "thread-staged-turn",
            occurredAt: completedAt,
            commandId: "cmd-staged-turn-completed",
            payload: {
              threadId: "thread-staged-turn",
              turnId: "turn-staged-1",
              completedAt,
            },
          }),
        );

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 5,
            type: "thread.checkpoint-captured",
            aggregateKind: "thread",
            aggregateId: "thread-staged-turn",
            occurredAt: capturedAt,
            commandId: "cmd-staged-turn-captured",
            payload: {
              threadId: "thread-staged-turn",
              turnId: "turn-staged-1",
              turnCount: 1,
              ref: "refs/t3/checkpoints/thread-staged-turn/turn/1",
              capturedAt,
            },
          }),
        );

        const threadRowsBeforeRevert = yield* sql<{
          readonly latestTurnId: string | null;
          readonly updatedAt: string;
        }>`
        SELECT
          latest_turn_id AS "latestTurnId",
          updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-staged-turn'
      `;
        assert.deepEqual(threadRowsBeforeRevert, [
          {
            latestTurnId: "turn-staged-1",
            updatedAt: capturedAt,
          },
        ]);

        const turnRowsBeforeRevert = yield* sql<{
          readonly turnId: string | null;
          readonly state: string;
          readonly checkpointTurnCount: number | null;
          readonly checkpointRef: string | null;
          readonly checkpointStatus: string | null;
          readonly startedAt: string | null;
          readonly completedAt: string | null;
        }>`
        SELECT
          turn_id AS "turnId",
          state,
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          started_at AS "startedAt",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = 'thread-staged-turn'
      `;
        assert.deepEqual(turnRowsBeforeRevert, [
          {
            turnId: "turn-staged-1",
            state: "completed",
            checkpointTurnCount: 1,
            checkpointRef: "refs/t3/checkpoints/thread-staged-turn/turn/1",
            checkpointStatus: "ready",
            startedAt,
            completedAt: capturedAt,
          },
        ]);

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 6,
            type: "thread.checkpoint-reverted",
            aggregateKind: "thread",
            aggregateId: "thread-staged-turn",
            occurredAt: revertedAt,
            commandId: "cmd-staged-turn-reverted",
            payload: {
              threadId: "thread-staged-turn",
              turnCount: 0,
              revertedAt,
            },
          }),
        );

        const threadRowsAfterRevert = yield* sql<{
          readonly latestTurnId: string | null;
          readonly updatedAt: string;
        }>`
        SELECT
          latest_turn_id AS "latestTurnId",
          updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-staged-turn'
      `;
        assert.deepEqual(threadRowsAfterRevert, [
          {
            latestTurnId: null,
            updatedAt: revertedAt,
          },
        ]);

        const turnRowsAfterRevert = yield* sql<{ readonly turnId: string | null }>`
        SELECT turn_id AS "turnId"
        FROM projection_turns
        WHERE thread_id = 'thread-staged-turn'
      `;
        assert.deepEqual(turnRowsAfterRevert, []);
      }),
  );

  it.effect(
    "persists additive thread projection columns for promotion, bootstrap, and phase lifecycle events",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const createdAt = "2026-04-05T16:00:00.000Z";
        const promotedAt = "2026-04-05T16:01:00.000Z";
        const bootstrapStartedAt = "2026-04-05T16:02:00.000Z";
        const phaseStartedAt = "2026-04-05T16:03:00.000Z";
        const phaseCompletedAt = "2026-04-05T16:04:00.000Z";

        for (const threadId of ["thread-parent-columns", "thread-child-columns"] as const) {
          yield* projectionPipeline.projectEvent(
            yield* eventStore.append({
              type: "thread.created",
              eventId: EventId.makeUnsafe(`evt-${threadId}`),
              aggregateKind: "thread",
              aggregateId: ThreadId.makeUnsafe(threadId),
              occurredAt: createdAt,
              commandId: CommandId.makeUnsafe(`cmd-${threadId}`),
              causationEventId: null,
              correlationId: CommandId.makeUnsafe(`cmd-${threadId}`),
              metadata: {},
              payload: {
                threadId: ThreadId.makeUnsafe(threadId),
                projectId: ProjectId.makeUnsafe("project-columns"),
                title: threadId,
                modelSelection: {
                  provider: "codex",
                  model: "gpt-5-codex",
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
                updatedAt: createdAt,
              },
            }),
          );
        }

        yield* sql`
        UPDATE projection_threads
        SET workflow_id = 'workflow-columns'
        WHERE thread_id = 'thread-child-columns'
      `;

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 10,
            type: "thread.promoted",
            aggregateKind: "thread",
            aggregateId: "thread-parent-columns",
            occurredAt: promotedAt,
            commandId: "cmd-promoted-columns",
            payload: {
              sourceThreadId: "thread-parent-columns",
              targetThreadId: "thread-child-columns",
              promotedAt,
            },
          }),
        );

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 11,
            type: "thread.bootstrap-started",
            aggregateKind: "thread",
            aggregateId: "thread-child-columns",
            occurredAt: bootstrapStartedAt,
            commandId: "cmd-bootstrap-columns",
            payload: {
              threadId: "thread-child-columns",
              startedAt: bootstrapStartedAt,
            },
          }),
        );

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 12,
            type: "thread.phase-started",
            aggregateKind: "thread",
            aggregateId: "thread-child-columns",
            occurredAt: phaseStartedAt,
            commandId: "cmd-phase-started-columns",
            payload: {
              threadId: "thread-child-columns",
              phaseRunId: "phase-run-columns",
              phaseId: "phase-columns",
              phaseName: "Columns",
              phaseType: "single-agent",
              iteration: 1,
              startedAt: phaseStartedAt,
            },
          }),
        );

        let threadRows = yield* sql<{
          readonly threadId: string;
          readonly parentThreadId: string | null;
          readonly phaseRunId: string | null;
          readonly currentPhaseId: string | null;
          readonly bootstrapStatus: string | null;
          readonly updatedAt: string;
        }>`
        SELECT
          thread_id AS "threadId",
          parent_thread_id AS "parentThreadId",
          phase_run_id AS "phaseRunId",
          current_phase_id AS "currentPhaseId",
          bootstrap_status AS "bootstrapStatus",
          updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id IN ('thread-parent-columns', 'thread-child-columns')
        ORDER BY thread_id ASC
      `;
        assert.deepEqual(threadRows, [
          {
            threadId: "thread-child-columns",
            parentThreadId: "thread-parent-columns",
            phaseRunId: "phase-run-columns",
            currentPhaseId: "phase-columns",
            bootstrapStatus: "running",
            updatedAt: phaseStartedAt,
          },
          {
            threadId: "thread-parent-columns",
            parentThreadId: null,
            phaseRunId: null,
            currentPhaseId: null,
            bootstrapStatus: null,
            updatedAt: promotedAt,
          },
        ]);

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 13,
            type: "thread.phase-completed",
            aggregateKind: "thread",
            aggregateId: "thread-child-columns",
            occurredAt: phaseCompletedAt,
            commandId: "cmd-phase-completed-columns",
            payload: {
              threadId: "thread-child-columns",
              phaseRunId: "phase-run-columns",
              outputs: [],
              completedAt: phaseCompletedAt,
            },
          }),
        );

        threadRows = yield* sql<{
          readonly threadId: string;
          readonly parentThreadId: string | null;
          readonly phaseRunId: string | null;
          readonly currentPhaseId: string | null;
          readonly bootstrapStatus: string | null;
          readonly updatedAt: string;
        }>`
        SELECT
          thread_id AS "threadId",
          parent_thread_id AS "parentThreadId",
          phase_run_id AS "phaseRunId",
          current_phase_id AS "currentPhaseId",
          bootstrap_status AS "bootstrapStatus",
          updated_at AS "updatedAt"
        FROM projection_threads
        WHERE thread_id = 'thread-child-columns'
      `;
        assert.deepEqual(threadRows, [
          {
            threadId: "thread-child-columns",
            parentThreadId: "thread-parent-columns",
            phaseRunId: null,
            currentPhaseId: null,
            bootstrapStatus: "running",
            updatedAt: phaseCompletedAt,
          },
        ]);
      }),
  );

  it.effect("persists additive lifecycle updates for outputs, channels, and stale requests", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-04-05T16:00:00.000Z";
      const phaseStartedAt = "2026-04-05T16:01:00.000Z";
      const phaseCompletedAt = "2026-04-05T16:02:00.000Z";
      const outputEditedAt = "2026-04-05T16:03:00.000Z";
      const channelCreatedAt = "2026-04-05T16:04:00.000Z";
      const channelConcludedAt = "2026-04-05T16:05:00.000Z";
      const channelClosedAt = "2026-04-05T16:06:00.000Z";
      const requestOpenedAt = "2026-04-05T16:07:00.000Z";
      const requestStaleAt = "2026-04-05T16:08:00.000Z";

      const savedProjectCreated = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-lifecycle-project"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-lifecycle"),
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-lifecycle-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-lifecycle-project"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-lifecycle"),
          title: "Lifecycle project",
          workspaceRoot: "/tmp/lifecycle-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* projectionPipeline.projectEvent(savedProjectCreated);

      const savedThreadCreated = yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-lifecycle-thread"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-lifecycle"),
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-lifecycle-thread"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-lifecycle-thread"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-lifecycle"),
          projectId: ProjectId.makeUnsafe("project-lifecycle"),
          title: "Lifecycle thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* projectionPipeline.projectEvent(savedThreadCreated);

      yield* sql`
        UPDATE projection_threads
        SET workflow_id = 'workflow-lifecycle'
        WHERE thread_id = 'thread-lifecycle'
      `;

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 3,
          type: "thread.phase-started",
          aggregateKind: "thread",
          aggregateId: "thread-lifecycle",
          occurredAt: phaseStartedAt,
          commandId: "cmd-lifecycle-phase-started",
          payload: {
            threadId: "thread-lifecycle",
            phaseRunId: "phase-run-lifecycle",
            phaseId: "phase-review",
            phaseName: "Review",
            phaseType: "single-agent",
            iteration: 1,
            startedAt: phaseStartedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 4,
          type: "thread.phase-completed",
          aggregateKind: "thread",
          aggregateId: "thread-lifecycle",
          occurredAt: phaseCompletedAt,
          commandId: "cmd-lifecycle-phase-completed",
          payload: {
            threadId: "thread-lifecycle",
            phaseRunId: "phase-run-lifecycle",
            outputs: [
              {
                key: "summary",
                content: "Initial summary",
                sourceType: "agent",
              },
            ],
            completedAt: phaseCompletedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 5,
          type: "thread.phase-output-edited",
          aggregateKind: "thread",
          aggregateId: "thread-lifecycle",
          occurredAt: outputEditedAt,
          commandId: "cmd-lifecycle-output-edited",
          payload: {
            threadId: "thread-lifecycle",
            phaseRunId: "phase-run-lifecycle",
            outputKey: "summary",
            newContent: "Edited summary",
            editedBy: "human",
            editedAt: outputEditedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 6,
          type: "channel.created",
          aggregateKind: "thread",
          aggregateId: "thread-lifecycle",
          occurredAt: channelCreatedAt,
          commandId: "cmd-lifecycle-channel-created",
          payload: {
            channelId: "channel-lifecycle",
            threadId: "thread-lifecycle",
            channelType: "review",
            phaseRunId: "phase-run-lifecycle",
            createdAt: channelCreatedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 7,
          type: "channel.concluded",
          aggregateKind: "thread",
          aggregateId: "thread-lifecycle",
          occurredAt: channelConcludedAt,
          commandId: "cmd-lifecycle-channel-concluded",
          payload: {
            channelId: "channel-lifecycle",
            threadId: "thread-lifecycle",
            conclusion: "Consensus reached",
            concludedAt: channelConcludedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 8,
          type: "channel.closed",
          aggregateKind: "thread",
          aggregateId: "thread-lifecycle",
          occurredAt: channelClosedAt,
          commandId: "cmd-lifecycle-channel-closed",
          payload: {
            channelId: "channel-lifecycle",
            threadId: "thread-lifecycle",
            closedAt: channelClosedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 9,
          type: "request.opened",
          aggregateKind: "thread",
          aggregateId: "thread-lifecycle",
          occurredAt: requestOpenedAt,
          commandId: "cmd-lifecycle-request-opened",
          payload: {
            requestId: "request-lifecycle",
            threadId: "thread-lifecycle",
            childThreadId: null,
            phaseRunId: "phase-run-lifecycle",
            requestType: "bootstrap-failed",
            payload: {
              type: "bootstrap-failed",
              error: "bootstrap.sh exited 1",
              stdout: "bootstrap output",
              command: "bun run bootstrap",
            },
            createdAt: requestOpenedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 10,
          type: "request.stale",
          aggregateKind: "thread",
          aggregateId: "thread-lifecycle",
          occurredAt: requestStaleAt,
          commandId: "cmd-lifecycle-request-stale",
          payload: {
            requestId: "request-lifecycle",
            reason: "phase advanced",
            staleAt: requestStaleAt,
          },
        }),
      );

      const phaseOutputRows = yield* sql<{
        readonly content: string;
        readonly sourceType: string;
        readonly updatedAt: string;
      }>`
        SELECT
          content,
          source_type AS "sourceType",
          updated_at AS "updatedAt"
        FROM phase_outputs
        WHERE phase_run_id = 'phase-run-lifecycle'
          AND output_key = 'summary'
      `;
      assert.deepEqual(phaseOutputRows, [
        {
          content: "Edited summary",
          sourceType: "agent",
          updatedAt: outputEditedAt,
        },
      ]);

      const channelRows = yield* sql<{
        readonly status: string;
        readonly updatedAt: string;
      }>`
        SELECT
          status,
          updated_at AS "updatedAt"
        FROM channels
        WHERE channel_id = 'channel-lifecycle'
      `;
      assert.deepEqual(channelRows, [
        {
          status: "closed",
          updatedAt: channelClosedAt,
        },
      ]);

      const requestRows = yield* sql<{
        readonly status: string;
        readonly staleReason: string | null;
      }>`
        SELECT
          status,
          stale_reason AS "staleReason"
        FROM interactive_requests
        WHERE request_id = 'request-lifecycle'
      `;
      assert.deepEqual(requestRows, [
        {
          status: "stale",
          staleReason: "phase advanced",
        },
      ]);
    }),
  );

  it.effect("persists queued corrections into the guidance channel projection", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-04-05T17:00:00.000Z";
      const correctionQueuedAt = "2026-04-05T17:01:00.000Z";
      const correctionQueuedAgainAt = "2026-04-05T17:02:00.000Z";

      const savedProjectCreated = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-correction-project"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-correction"),
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-correction-project"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-correction-project"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-correction"),
          title: "Correction project",
          workspaceRoot: "/tmp/correction-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* projectionPipeline.projectEvent(savedProjectCreated);

      const savedThreadCreated = yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-correction-thread"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-correction"),
        occurredAt: createdAt,
        commandId: CommandId.makeUnsafe("cmd-correction-thread"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-correction-thread"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-correction"),
          projectId: ProjectId.makeUnsafe("project-correction"),
          title: "Correction thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      });
      yield* projectionPipeline.projectEvent(savedThreadCreated);

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 3,
          type: "thread.correction-queued",
          aggregateKind: "thread",
          aggregateId: "thread-correction",
          occurredAt: correctionQueuedAt,
          commandId: "cmd-correction-queued-1",
          payload: {
            threadId: "thread-correction",
            content: "Please tighten the review notes.",
            channelId: "channel-guidance-correction",
            messageId: "channel-message-correction-1",
            createdAt: correctionQueuedAt,
          },
        }),
      );

      yield* projectionPipeline.projectEvent(
        makeForgeEvent({
          sequence: 4,
          type: "thread.correction-queued",
          aggregateKind: "thread",
          aggregateId: "thread-correction",
          occurredAt: correctionQueuedAgainAt,
          commandId: "cmd-correction-queued-2",
          payload: {
            threadId: "thread-correction",
            content: "Also add the missing failure mode.",
            channelId: "channel-guidance-correction",
            messageId: "channel-message-correction-2",
            createdAt: correctionQueuedAgainAt,
          },
        }),
      );

      const channelRows = yield* sql<{
        readonly channelId: string;
        readonly threadId: string;
        readonly type: string;
        readonly status: string;
      }>`
        SELECT
          channel_id AS "channelId",
          thread_id AS "threadId",
          type,
          status
        FROM channels
        WHERE channel_id = 'channel-guidance-correction'
      `;
      assert.deepEqual(channelRows, [
        {
          channelId: "channel-guidance-correction",
          threadId: "thread-correction",
          type: "guidance",
          status: "open",
        },
      ]);

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly sequence: number;
        readonly fromType: string;
        readonly fromId: string;
        readonly content: string;
      }>`
        SELECT
          message_id AS "messageId",
          sequence,
          from_type AS "fromType",
          from_id AS "fromId",
          content
        FROM channel_messages
        WHERE channel_id = 'channel-guidance-correction'
        ORDER BY sequence ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "channel-message-correction-1",
          sequence: 0,
          fromType: "human",
          fromId: "human",
          content: "Please tighten the review notes.",
        },
        {
          messageId: "channel-message-correction-2",
          sequence: 1,
          fromType: "human",
          fromId: "human",
          content: "Also add the missing failure mode.",
        },
      ]);
    }),
  );

  it.effect(
    "appends queued corrections to an existing guidance channel without rewriting creation metadata",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const createdAt = "2026-04-05T18:00:00.000Z";
        const channelCreatedAt = "2026-04-05T18:01:00.000Z";
        const correctionQueuedAt = "2026-04-05T18:02:00.000Z";

        const savedProjectCreated = yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-existing-guidance-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-existing-guidance"),
          occurredAt: createdAt,
          commandId: CommandId.makeUnsafe("cmd-existing-guidance-project"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-existing-guidance-project"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-existing-guidance"),
            title: "Existing guidance project",
            workspaceRoot: "/tmp/existing-guidance-project",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
        });
        yield* projectionPipeline.projectEvent(savedProjectCreated);

        const savedThreadCreated = yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.makeUnsafe("evt-existing-guidance-thread"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-existing-guidance"),
          occurredAt: createdAt,
          commandId: CommandId.makeUnsafe("cmd-existing-guidance-thread"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-existing-guidance-thread"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-existing-guidance"),
            projectId: ProjectId.makeUnsafe("project-existing-guidance"),
            title: "Existing guidance thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
        yield* projectionPipeline.projectEvent(savedThreadCreated);

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 3,
            type: "channel.created",
            aggregateKind: "channel",
            aggregateId: "channel-guidance-existing",
            occurredAt: channelCreatedAt,
            commandId: "cmd-existing-guidance-channel-created",
            payload: {
              channelId: "channel-guidance-existing",
              threadId: "thread-existing-guidance",
              phaseRunId: null,
              channelType: "guidance",
              createdAt: channelCreatedAt,
            },
          }),
        );

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 4,
            type: "channel.message-posted",
            aggregateKind: "channel",
            aggregateId: "channel-guidance-existing",
            occurredAt: channelCreatedAt,
            commandId: "cmd-existing-guidance-message-0",
            payload: {
              channelId: "channel-guidance-existing",
              messageId: "channel-message-existing-0",
              sequence: 0,
              fromType: "human",
              fromId: "human",
              fromRole: null,
              content: "Initial guidance note.",
              createdAt: channelCreatedAt,
            },
          }),
        );

        yield* projectionPipeline.projectEvent(
          makeForgeEvent({
            sequence: 5,
            type: "thread.correction-queued",
            aggregateKind: "thread",
            aggregateId: "thread-existing-guidance",
            occurredAt: correctionQueuedAt,
            commandId: "cmd-existing-guidance-correction",
            payload: {
              threadId: "thread-existing-guidance",
              content: "Follow up with the missing rollback detail.",
              channelId: "channel-guidance-existing",
              messageId: "channel-message-existing-1",
              createdAt: correctionQueuedAt,
            },
          }),
        );

        const channelRows = yield* sql<{
          readonly channelId: string;
          readonly status: string;
          readonly createdAt: string;
          readonly updatedAt: string;
        }>`
        SELECT
          channel_id AS "channelId",
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM channels
        WHERE channel_id = 'channel-guidance-existing'
      `;
        assert.deepEqual(channelRows, [
          {
            channelId: "channel-guidance-existing",
            status: "open",
            createdAt: channelCreatedAt,
            updatedAt: correctionQueuedAt,
          },
        ]);

        const messageRows = yield* sql<{
          readonly messageId: string;
          readonly sequence: number;
          readonly content: string;
        }>`
        SELECT
          message_id AS "messageId",
          sequence,
          content
        FROM channel_messages
        WHERE channel_id = 'channel-guidance-existing'
        ORDER BY sequence ASC, message_id ASC
      `;
        assert.deepEqual(messageRows, [
          {
            messageId: "channel-message-existing-0",
            sequence: 0,
            content: "Initial guidance note.",
          },
          {
            messageId: "channel-message-existing-1",
            sequence: 1,
            content: "Follow up with the missing rollback detail.",
          },
        ]);
      }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-base-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("stores message attachment references without mutating payloads", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-attachments"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-attachments"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-attachments"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-attachments"),
            messageId: MessageId.makeUnsafe("message-attachments"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-att-1",
                name: "example.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments'
          `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-safe-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("preserves mixed image attachment metadata as-is", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-attachments-safe"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-attachments-safe"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-attachments-safe"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-attachments-safe"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-attachments-safe"),
            messageId: MessageId.makeUnsafe("message-attachments-safe"),
            role: "user",
            text: "Inspect this",
            attachments: [
              {
                type: "image",
                id: "thread-attachments-safe-att-1",
                name: "untrusted.exe",
                mimeType: "image/x-unknown",
                sizeBytes: 5,
              },
              {
                type: "image",
                id: "thread-attachments-safe-att-2",
                name: "not-image.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
            SELECT
              attachments_json AS "attachmentsJson"
            FROM projection_thread_messages
            WHERE message_id = 'message-attachments-safe'
          `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
          {
            type: "image",
            id: "thread-attachments-safe-att-1",
            name: "untrusted.exe",
            mimeType: "image/x-unknown",
            sizeBytes: 5,
          },
          {
            type: "image",
            id: "thread-attachments-safe-att-2",
            name: "not-image.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ]);
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect(
    "passes explicit empty attachment arrays through the projection pipeline to clear attachments",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        const later = new Date(Date.now() + 1_000).toISOString();

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-clear-attachments-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-1"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-clear-attachments"),
            title: "Project Clear Attachments",
            workspaceRoot: "/tmp/project-clear-attachments",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.makeUnsafe("evt-clear-attachments-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-2"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            projectId: ProjectId.makeUnsafe("project-clear-attachments"),
            title: "Thread Clear Attachments",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "Has attachments",
            attachments: [
              {
                type: "image",
                id: "thread-clear-attachments-att-1",
                name: "clear.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-clear-attachments-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-clear-attachments"),
          occurredAt: later,
          commandId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          causationEventId: null,
          correlationId: CommandId.makeUnsafe("cmd-clear-attachments-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-clear-attachments"),
            messageId: MessageId.makeUnsafe("message-clear-attachments"),
            role: "user",
            text: "",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: later,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{
          readonly attachmentsJson: string | null;
        }>`
          SELECT
            attachments_json AS "attachmentsJson"
          FROM projection_thread_messages
          WHERE message_id = 'message-clear-attachments'
        `;
        assert.equal(rows.length, 1);
        assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), []);
      }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("overwrites stored attachment references when a message updates attachments", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();
      const later = new Date(Date.now() + 1_000).toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-overwrite-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-1"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-overwrite"),
          title: "Project Overwrite",
          workspaceRoot: "/tmp/project-overwrite",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-overwrite-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-2"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          projectId: ProjectId.makeUnsafe("project-overwrite"),
          title: "Thread Overwrite",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-overwrite-3"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "first image",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-1",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-overwrite-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-overwrite"),
        occurredAt: later,
        commandId: CommandId.makeUnsafe("cmd-overwrite-4"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-overwrite-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-overwrite"),
          messageId: MessageId.makeUnsafe("message-overwrite"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "thread-overwrite-att-2",
              name: "file.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: later,
        },
      });

      yield* projectionPipeline.bootstrap;

      const rows = yield* sql<{
        readonly attachmentsJson: string | null;
      }>`
              SELECT attachments_json AS "attachmentsJson"
              FROM projection_thread_messages
              WHERE message_id = 'message-overwrite'
            `;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0]?.attachmentsJson ?? "null"), [
        {
          type: "image",
          id: "thread-overwrite-att-2",
          name: "file.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ]);
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-rollback-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("does not persist attachment files when projector transaction rolls back", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-rollback-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-rollback"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-rollback-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-rollback-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-rollback"),
          title: "Project Rollback",
          workspaceRoot: "/tmp/project-rollback",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-rollback-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-rollback"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-rollback-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-rollback-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-rollback"),
          projectId: ProjectId.makeUnsafe("project-rollback"),
          title: "Thread Rollback",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* sql`
        CREATE TRIGGER fail_thread_messages_projection_state_update
        BEFORE UPDATE ON projection_state
        WHEN NEW.projector = 'projection.thread-messages'
        BEGIN
          SELECT RAISE(ABORT, 'forced-projection-state-failure');
        END;
      `;

      const result = yield* Effect.result(
        appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-rollback-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-rollback"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-rollback-3"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-rollback-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-rollback"),
            messageId: MessageId.makeUnsafe("message-rollback"),
            role: "user",
            text: "Rollback me",
            attachments: [
              {
                type: "image",
                id: "thread-rollback-att-1",
                name: "rollback.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{
        readonly count: number;
      }>`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_messages
        WHERE message_id = 'message-rollback'
      `;
      assert.equal(rows[0]?.count ?? 0, 0);

      const { attachmentsDir } = yield* ServerConfig;
      const attachmentPath = path.join(attachmentsDir, "thread-rollback-att-1.png");
      assert.isFalse(yield* exists(attachmentPath));
      yield* sql`DROP TRIGGER IF EXISTS fail_thread_messages_projection_state_update`;
    }),
  );
});

it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-overwrite-")),
)("OrchestrationProjectionPipeline", (it) => {
  it.effect("removes unreferenced attachment files when a thread is reverted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const { attachmentsDir } = yield* ServerConfig;
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("Thread Revert.Files");
      const keepAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000001";
      const removeAttachmentId = "thread-revert-files-00000000-0000-4000-8000-000000000002";
      const otherThreadAttachmentId =
        "thread-revert-files-extra-00000000-0000-4000-8000-000000000003";

      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-revert-files-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-revert-files"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-revert-files"),
          title: "Project Revert Files",
          workspaceRoot: "/tmp/project-revert-files",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-revert-files-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-2"),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.makeUnsafe("project-revert-files"),
          title: "Thread Revert Files",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-files-3"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-3"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.makeUnsafe("turn-keep"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread-revert-files/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("message-keep"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-4"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-4"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-keep"),
          role: "assistant",
          text: "Keep",
          attachments: [
            {
              type: "image",
              id: keepAttachmentId,
              name: "keep.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-keep"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-files-5"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-5"),
        metadata: {},
        payload: {
          threadId,
          turnId: TurnId.makeUnsafe("turn-remove"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread-revert-files/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("message-remove"),
          completedAt: now,
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-files-6"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-6"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-6"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-remove"),
          role: "assistant",
          text: "Remove",
          attachments: [
            {
              type: "image",
              id: removeAttachmentId,
              name: "remove.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
          turnId: TurnId.makeUnsafe("turn-remove"),
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const keepPath = path.join(attachmentsDir, `${keepAttachmentId}.png`);
      const removePath = path.join(attachmentsDir, `${removeAttachmentId}.png`);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(keepPath, "keep");
      yield* fileSystem.writeFileString(removePath, "remove");
      const otherThreadPath = path.join(attachmentsDir, `${otherThreadAttachmentId}.png`);
      yield* fileSystem.writeFileString(otherThreadPath, "other");
      assert.isTrue(yield* exists(keepPath));
      assert.isTrue(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.makeUnsafe("evt-revert-files-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-revert-files-7"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-files-7"),
        metadata: {},
        payload: {
          threadId,
          turnCount: 1,
        },
      });

      assert.isTrue(yield* exists(keepPath));
      assert.isFalse(yield* exists(removePath));
      assert.isTrue(yield* exists(otherThreadPath));
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-revert-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("removes thread attachment directory when thread is deleted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const { attachmentsDir } = yield* ServerConfig;
        const now = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe("Thread Delete.Files");
        const attachmentId = "thread-delete-files-00000000-0000-4000-8000-000000000001";
        const otherThreadAttachmentId =
          "thread-delete-files-extra-00000000-0000-4000-8000-000000000002";

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-delete-files-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-delete-files"),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-delete-files-1"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-delete-files-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-delete-files"),
            title: "Project Delete Files",
            workspaceRoot: "/tmp/project-delete-files",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.makeUnsafe("evt-delete-files-2"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-delete-files-2"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-delete-files-2"),
          metadata: {},
          payload: {
            threadId,
            projectId: ProjectId.makeUnsafe("project-delete-files"),
            title: "Thread Delete Files",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-delete-files-3"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-delete-files-3"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-delete-files-3"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.makeUnsafe("message-delete-files"),
            role: "user",
            text: "Delete",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "delete.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        const threadAttachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        const otherThreadAttachmentPath = path.join(
          attachmentsDir,
          `${otherThreadAttachmentId}.png`,
        );
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(threadAttachmentPath, "delete");
        yield* fileSystem.writeFileString(otherThreadAttachmentPath, "other-thread");
        assert.isTrue(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));

        yield* appendAndProject({
          type: "thread.deleted",
          eventId: EventId.makeUnsafe("evt-delete-files-4"),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-delete-files-4"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-delete-files-4"),
          metadata: {},
          payload: {
            threadId,
            deletedAt: now,
          },
        });

        assert.isFalse(yield* exists(threadAttachmentPath));
        assert.isTrue(yield* exists(otherThreadAttachmentPath));
      }),
    );
  },
);

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-attachments-delete-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("ignores unsafe thread ids for attachment cleanup paths", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const now = new Date().toISOString();
        const { attachmentsDir: attachmentsRootDir, stateDir } = yield* ServerConfig;
        const attachmentsSentinelPath = path.join(attachmentsRootDir, "sentinel.txt");
        const stateDirSentinelPath = path.join(stateDir, "state-sentinel.txt");
        yield* fileSystem.makeDirectory(attachmentsRootDir, { recursive: true });
        yield* fileSystem.writeFileString(attachmentsSentinelPath, "keep-attachments-root");
        yield* fileSystem.writeFileString(stateDirSentinelPath, "keep-state-dir");

        yield* eventStore.append({
          type: "thread.deleted",
          eventId: EventId.makeUnsafe("evt-unsafe-thread-delete"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe(".."),
          occurredAt: now,
          commandId: CommandId.makeUnsafe("cmd-unsafe-thread-delete"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-unsafe-thread-delete"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe(".."),
            deletedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        assert.isTrue(yield* exists(attachmentsRootDir));
        assert.isTrue(yield* exists(attachmentsSentinelPath));
        assert.isTrue(yield* exists(stateDirSentinelPath));
      }),
    );
  },
);

it.layer(BaseTestLayer)("OrchestrationProjectionPipeline", (it) => {
  it.effect("resumes from projector last_applied_sequence without replaying older events", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-a1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Project A",
          workspaceRoot: "/tmp/project-a",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-a2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "Thread A",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-a4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-a"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-a4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-a4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-a"),
          messageId: MessageId.makeUnsafe("message-a"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages WHERE message_id = 'message-a'
      `;
      assert.deepEqual(messageRows, [{ text: "hello world" }]);

      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      const maxSequenceRows = yield* sql<{ readonly maxSequence: number }>`
        SELECT MAX(sequence) AS "maxSequence" FROM orchestration_events
      `;
      const maxSequence = maxSequenceRows[0]?.maxSequence ?? 0;
      for (const row of stateRows) {
        assert.equal(row.lastAppliedSequence, maxSequence);
      }
    }),
  );

  it.effect("keeps accumulated assistant text when completion payload text is empty", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-empty-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Project Empty",
          workspaceRoot: "/tmp/project-empty",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-empty-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          projectId: ProjectId.makeUnsafe("project-empty"),
          title: "Thread Empty",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "Hello",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: " world",
          turnId: null,
          streaming: true,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* eventStore.append({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-empty-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-empty"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-empty-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-empty-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-empty"),
          messageId: MessageId.makeUnsafe("assistant-empty"),
          role: "assistant",
          text: "",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      yield* projectionPipeline.bootstrap;

      const messageRows = yield* sql<{ readonly text: string; readonly isStreaming: unknown }>`
        SELECT
          text,
          is_streaming AS "isStreaming"
        FROM projection_thread_messages
        WHERE message_id = 'assistant-empty'
      `;
      assert.equal(messageRows.length, 1);
      assert.equal(messageRows[0]?.text, "Hello world");
      assert.isFalse(Boolean(messageRows[0]?.isStreaming));
    }),
  );

  it.effect(
    "resolves turn-count conflicts when checkpoint completion rewrites provisional turns",
    () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore
            .append(event)
            .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.makeUnsafe("evt-conflict-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.makeUnsafe("project-conflict"),
          occurredAt: "2026-02-26T13:00:00.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-1"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.makeUnsafe("project-conflict"),
            title: "Project Conflict",
            workspaceRoot: "/tmp/project-conflict",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-02-26T13:00:00.000Z",
            updatedAt: "2026-02-26T13:00:00.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.makeUnsafe("evt-conflict-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:01.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-2"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            projectId: ProjectId.makeUnsafe("project-conflict"),
            title: "Thread Conflict",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: "2026-02-26T13:00:01.000Z",
            updatedAt: "2026-02-26T13:00:01.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-interrupt-requested",
          eventId: EventId.makeUnsafe("evt-conflict-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:02.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-3"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            turnId: TurnId.makeUnsafe("turn-interrupted"),
            createdAt: "2026-02-26T13:00:02.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.makeUnsafe("evt-conflict-4"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:03.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-4"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-4"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            messageId: MessageId.makeUnsafe("assistant-conflict"),
            role: "assistant",
            text: "done",
            turnId: TurnId.makeUnsafe("turn-completed"),
            streaming: false,
            createdAt: "2026-02-26T13:00:03.000Z",
            updatedAt: "2026-02-26T13:00:03.000Z",
          },
        });

        yield* appendAndProject({
          type: "thread.turn-diff-completed",
          eventId: EventId.makeUnsafe("evt-conflict-5"),
          aggregateKind: "thread",
          aggregateId: ThreadId.makeUnsafe("thread-conflict"),
          occurredAt: "2026-02-26T13:00:04.000Z",
          commandId: CommandId.makeUnsafe("cmd-conflict-5"),
          causationEventId: null,
          correlationId: CorrelationId.makeUnsafe("cmd-conflict-5"),
          metadata: {},
          payload: {
            threadId: ThreadId.makeUnsafe("thread-conflict"),
            turnId: TurnId.makeUnsafe("turn-completed"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread-conflict/turn/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.makeUnsafe("assistant-conflict"),
            completedAt: "2026-02-26T13:00:04.000Z",
          },
        });

        const turnRows = yield* sql<{
          readonly turnId: string;
          readonly checkpointTurnCount: number | null;
          readonly status: string;
        }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          state AS "status"
        FROM projection_turns
        WHERE thread_id = 'thread-conflict'
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC
      `;
        assert.deepEqual(turnRows, [
          { turnId: "turn-completed", checkpointTurnCount: 1, status: "completed" },
          { turnId: "turn-interrupted", checkpointTurnCount: null, status: "interrupted" },
        ]);
      }),
  );

  it.effect("does not fallback-retain messages whose turnId is removed by revert", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
        eventStore
          .append(event)
          .pipe(Effect.flatMap((savedEvent) => projectionPipeline.projectEvent(savedEvent)));

      yield* appendAndProject({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-revert-1"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-revert"),
        occurredAt: "2026-02-26T12:00:00.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-1"),
        metadata: {},
        payload: {
          projectId: ProjectId.makeUnsafe("project-revert"),
          title: "Project Revert",
          workspaceRoot: "/tmp/project-revert",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-02-26T12:00:00.000Z",
          updatedAt: "2026-02-26T12:00:00.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.created",
        eventId: EventId.makeUnsafe("evt-revert-2"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-2"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          projectId: ProjectId.makeUnsafe("project-revert"),
          title: "Thread Revert",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: "2026-02-26T12:00:01.000Z",
          updatedAt: "2026-02-26T12:00:01.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-3"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-3"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-3"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          turnId: TurnId.makeUnsafe("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread-revert/turn/1"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("assistant-keep"),
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-4"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: CommandId.makeUnsafe("cmd-revert-4"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-4"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          messageId: MessageId.makeUnsafe("assistant-keep"),
          role: "assistant",
          text: "kept",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.turn-diff-completed",
        eventId: EventId.makeUnsafe("evt-revert-5"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-5"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-5"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          turnId: TurnId.makeUnsafe("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("refs/t3/checkpoints/thread-revert/turn/2"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.makeUnsafe("assistant-remove"),
          completedAt: "2026-02-26T12:00:03.000Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-6"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.050Z",
        commandId: CommandId.makeUnsafe("cmd-revert-6"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-6"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          messageId: MessageId.makeUnsafe("user-remove"),
          role: "user",
          text: "removed",
          turnId: TurnId.makeUnsafe("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.050Z",
          updatedAt: "2026-02-26T12:00:03.050Z",
        },
      });

      yield* appendAndProject({
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe("evt-revert-7"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:03.100Z",
        commandId: CommandId.makeUnsafe("cmd-revert-7"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-7"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          messageId: MessageId.makeUnsafe("assistant-remove"),
          role: "assistant",
          text: "removed",
          turnId: TurnId.makeUnsafe("turn-2"),
          streaming: false,
          createdAt: "2026-02-26T12:00:03.100Z",
          updatedAt: "2026-02-26T12:00:03.100Z",
        },
      });

      yield* appendAndProject({
        type: "thread.reverted",
        eventId: EventId.makeUnsafe("evt-revert-8"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-revert"),
        occurredAt: "2026-02-26T12:00:04.000Z",
        commandId: CommandId.makeUnsafe("cmd-revert-8"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-revert-8"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-revert"),
          turnCount: 1,
        },
      });

      const messageRows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
        readonly role: string;
      }>`
        SELECT
          message_id AS "messageId",
          turn_id AS "turnId",
          role
        FROM projection_thread_messages
        WHERE thread_id = 'thread-revert'
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.deepEqual(messageRows, [
        {
          messageId: "assistant-keep",
          turnId: "turn-1",
          role: "assistant",
        },
      ]);
    }),
  );
});

it.effect("restores pending turn-start metadata across projection pipeline restart", () =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const firstProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );
    const secondProjectionLayer = OrchestrationProjectionPipelineLive.pipe(
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(persistenceLayer),
    );

    const threadId = ThreadId.makeUnsafe("thread-restart");
    const turnId = TurnId.makeUnsafe("turn-restart");
    const messageId = MessageId.makeUnsafe("message-restart");
    const sourcePlanThreadId = ThreadId.makeUnsafe("thread-plan-source");
    const sourcePlanId = "plan-source";
    const turnStartedAt = "2026-02-26T14:00:00.000Z";
    const sessionSetAt = "2026-02-26T14:00:05.000Z";

    yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        type: "thread.turn-start-requested",
        eventId: EventId.makeUnsafe("evt-restart-1"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: turnStartedAt,
        commandId: CommandId.makeUnsafe("cmd-restart-1"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-restart-1"),
        metadata: {},
        payload: {
          threadId,
          messageId,
          sourceProposedPlan: {
            threadId: sourcePlanThreadId,
            planId: sourcePlanId,
          },
          runtimeMode: "approval-required",
          createdAt: turnStartedAt,
        },
      });

      yield* projectionPipeline.bootstrap;
    }).pipe(Effect.provide(firstProjectionLayer));

    const turnRows = yield* Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "thread.session-set",
        eventId: EventId.makeUnsafe("evt-restart-2"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: sessionSetAt,
        commandId: CommandId.makeUnsafe("cmd-restart-2"),
        causationEventId: null,
        correlationId: CorrelationId.makeUnsafe("cmd-restart-2"),
        metadata: {},
        payload: {
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: sessionSetAt,
          },
        },
      });

      yield* projectionPipeline.bootstrap;

      const pendingRows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
      `;
      assert.deepEqual(pendingRows, []);

      return yield* sql<{
        readonly turnId: string;
        readonly userMessageId: string | null;
        readonly sourceProposedPlanThreadId: string | null;
        readonly sourceProposedPlanId: string | null;
        readonly startedAt: string;
      }>`
        SELECT
          turn_id AS "turnId",
          pending_message_id AS "userMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          started_at AS "startedAt"
        FROM projection_turns
        WHERE turn_id = ${turnId}
      `;
    }).pipe(Effect.provide(secondProjectionLayer));

    assert.deepEqual(turnRows, [
      {
        turnId: "turn-restart",
        userMessageId: "message-restart",
        sourceProposedPlanThreadId: "thread-plan-source",
        sourceProposedPlanId: "plan-source",
        startedAt: turnStartedAt,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-projection-pipeline-restart-",
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-projection-pipeline-engine-dispatch-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-live-project"),
        projectId: ProjectId.makeUnsafe("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;
      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;
      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = new Date().toISOString();

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-create"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-scripts-project-update"),
        projectId: ProjectId.makeUnsafe("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;
      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"provider":"codex","model":"gpt-5"}',
        },
      ]);
    }),
  );
});
