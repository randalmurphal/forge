import {
  ChannelId,
  CheckpointRef,
  EventId,
  InteractiveRequestId,
  MessageId,
  PhaseRunId,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
  WorkflowId,
  WorkflowPhaseId,
} from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.makeUnsafe(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("loads tailed command output on demand", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;

      const output = Array.from({ length: 130 }, (_, index) => `line ${index + 1}`).join("\n");

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-command-1',
          'thread-command-1',
          'turn-command-1',
          'tool',
          'tool.completed',
          'Ran command',
          ${JSON.stringify({
            itemType: "command_execution",
            itemId: "tool-command-1",
            data: {
              item: {
                id: "tool-command-1",
                aggregatedOutput: output,
              },
            },
          })},
          1,
          '2026-04-10T00:00:00.000Z'
        )
      `;

      const commandOutput = yield* snapshotQuery.getCommandOutput({
        threadId: ThreadId.makeUnsafe("thread-command-1"),
        activityId: asEventId("activity-command-1"),
        toolCallId: ProviderItemId.makeUnsafe("tool-command-1"),
      });

      assert.isTrue(Option.isSome(commandOutput));
      if (Option.isSome(commandOutput)) {
        assert.deepStrictEqual(commandOutput.value, {
          threadId: ThreadId.makeUnsafe("thread-command-1"),
          activityId: asEventId("activity-command-1"),
          toolCallId: ProviderItemId.makeUnsafe("tool-command-1"),
          output: Array.from({ length: 100 }, (_, index) => `line ${index + 31}`).join("\n"),
          source: "final",
          omittedLineCount: 30,
        });
      }

      yield* sql`DELETE FROM projection_thread_activities`;
    }),
  );

  it.effect("loads recorded subagent activities on demand by correlating child command rows", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;

      const childThreadAttribution = {
        taskId: "task-child-1",
        childProviderThreadId: "child-provider-1",
      };

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-child-terminal',
            'thread-subagent-1',
            'turn-subagent-1',
            'tool',
            'tool.terminal.interaction',
            'Terminal update',
            ${JSON.stringify({
              itemId: "tool-child-1",
              processId: "process-child-1",
              childThreadAttribution,
            })},
            1,
            '2026-04-10T00:00:00.000Z'
          ),
          (
            'activity-child-command',
            'thread-subagent-1',
            'turn-subagent-1',
            'tool',
            'tool.completed',
            'Ran command',
            ${JSON.stringify({
              itemType: "command_execution",
              itemId: "tool-child-1",
              data: {
                item: {
                  id: "tool-child-1",
                  command: ["/bin/zsh", "-lc", "sleep 30"],
                  processId: "process-child-1",
                  aggregatedOutput: "started\nfinished",
                },
              },
            })},
            2,
            '2026-04-10T00:00:01.000Z'
          ),
          (
            'activity-child-complete',
            'thread-subagent-1',
            'turn-subagent-1',
            'info',
            'task.completed',
            'Task completed',
            ${JSON.stringify({
              taskId: "task-child-1",
              status: "completed",
              childThreadAttribution,
            })},
            3,
            '2026-04-10T00:00:02.000Z'
          )
      `;

      const feed = yield* snapshotQuery.getSubagentActivityFeed({
        threadId: ThreadId.makeUnsafe("thread-subagent-1"),
        childProviderThreadId: "child-provider-1",
      });

      assert.deepStrictEqual(feed, {
        threadId: ThreadId.makeUnsafe("thread-subagent-1"),
        childProviderThreadId: "child-provider-1",
        activities: [
          {
            id: asEventId("activity-child-command"),
            kind: "tool.completed",
            tone: "tool",
            summary: "Ran command",
            payload: {
              itemType: "command_execution",
              itemId: "tool-child-1",
              childThreadAttribution,
              outputSummary: {
                available: true,
                source: "final",
                byteLength: Buffer.byteLength("started\nfinished", "utf8"),
              },
              data: {
                item: {
                  id: "tool-child-1",
                  command: ["/bin/zsh", "-lc", "sleep 30"],
                  processId: "process-child-1",
                },
              },
            },
            turnId: asTurnId("turn-subagent-1"),
            createdAt: "2026-04-10T00:00:01.000Z",
            sequence: 2,
          },
        ],
        omittedActivityCount: 0,
      });

      yield* sql`DELETE FROM projection_thread_activities`;
    }),
  );

  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          spawnMode: undefined,
          spawnBranch: null,
          spawnWorktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.makeUnsafe("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          pinnedAt: null,
          archivedAt: null,
          deletedAt: null,
          parentThreadId: null,
          phaseRunId: null,
          workflowId: null,
          currentPhaseId: null,
          discussionId: null,
          role: null,
          childThreadIds: [],
          bootstrapStatus: null,
          forkedFromThreadId: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.makeUnsafe("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          agentDiffs: [],
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);
    }),
  );

  it.effect(
    "rehydrates additive workflow, channel, and pending request state from SQL projections",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM workflows`;
        yield* sql`DELETE FROM interactive_requests`;
        yield* sql`DELETE FROM channels`;
        yield* sql`DELETE FROM phase_runs`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_thread_proposed_plans`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_state`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-additive',
          'Additive Project',
          '/tmp/project-additive',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          NULL
        )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at,
          parent_thread_id,
          phase_run_id,
          workflow_id,
          current_phase_id,
          discussion_id,
          role,
          bootstrap_status
        )
        VALUES
          (
            'thread-parent',
            'project-additive',
            'Parent Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-04-05T00:00:02.000Z',
            '2026-04-05T00:00:03.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL
          ),
          (
            'thread-child',
            'project-additive',
            'Child Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-04-05T00:00:04.000Z',
            '2026-04-05T00:00:10.000Z',
            NULL,
            NULL,
            'thread-parent',
            'phase-run-1',
            'workflow-1',
            'phase-1',
            NULL,
            'reviewer',
            'running'
          )
      `;

        yield* sql`
        INSERT INTO workflows (
          workflow_id,
          name,
          description,
          phases_json,
          built_in,
          created_at,
          updated_at
        )
        VALUES (
          'workflow-1',
          'Review Workflow',
          'Workflow description',
          '[]',
          1,
          '2026-04-05T00:00:05.000Z',
          '2026-04-05T00:00:06.000Z'
        )
      `;

        yield* sql`
        INSERT INTO phase_runs (
          phase_run_id,
          thread_id,
          workflow_id,
          phase_id,
          phase_name,
          phase_type,
          iteration,
          status,
          started_at,
          completed_at
        )
        VALUES (
          'phase-run-1',
          'thread-child',
          'workflow-1',
          'phase-1',
          'Review',
          'single-agent',
          1,
          'running',
          '2026-04-05T00:00:07.000Z',
          NULL
        )
      `;

        yield* sql`
        INSERT INTO channels (
          channel_id,
          thread_id,
          phase_run_id,
          type,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'channel-1',
          'thread-child',
          'phase-run-1',
          'guidance',
          'open',
          '2026-04-05T00:00:08.000Z',
          '2026-04-05T00:00:09.000Z'
        )
      `;

        yield* sql`
        INSERT INTO interactive_requests (
          request_id,
          thread_id,
          child_thread_id,
          phase_run_id,
          type,
          status,
          payload_json,
          resolved_with_json,
          created_at,
          resolved_at,
          stale_reason
        )
        VALUES (
          'request-1',
          'thread-child',
          NULL,
          'phase-run-1',
          'user-input',
          'pending',
          '{"type":"user-input","questions":[{"id":"scope","question":"Ship it?"}]}',
          NULL,
          '2026-04-05T00:00:11.000Z',
          NULL,
          NULL
        )
      `;

        for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
          const sequence =
            projector === ORCHESTRATION_PROJECTOR_NAMES.phaseRuns
              ? 7
              : projector === ORCHESTRATION_PROJECTOR_NAMES.interactiveRequests
                ? 8
                : projector === ORCHESTRATION_PROJECTOR_NAMES.channels
                  ? 9
                  : 20;
          yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-04-05T00:00:12.000Z'
          )
        `;
        }

        const snapshot = yield* snapshotQuery.getSnapshot();

        assert.equal(snapshot.snapshotSequence, 7);
        assert.deepEqual(snapshot.workflows, [
          {
            workflowId: WorkflowId.makeUnsafe("workflow-1"),
            name: "Review Workflow",
            description: "Workflow description",
            builtIn: true,
          },
        ]);
        assert.deepEqual(snapshot.phaseRuns, [
          {
            phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
            threadId: ThreadId.makeUnsafe("thread-child"),
            phaseId: WorkflowPhaseId.makeUnsafe("phase-1"),
            phaseName: "Review",
            phaseType: "single-agent",
            iteration: 1,
            status: "running",
            startedAt: "2026-04-05T00:00:07.000Z",
            completedAt: null,
          },
        ]);
        assert.deepEqual(snapshot.channels, [
          {
            id: ChannelId.makeUnsafe("channel-1"),
            threadId: ThreadId.makeUnsafe("thread-child"),
            phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
            type: "guidance",
            status: "open",
            createdAt: "2026-04-05T00:00:08.000Z",
            updatedAt: "2026-04-05T00:00:09.000Z",
          },
        ]);
        assert.deepEqual(snapshot.pendingRequests, [
          {
            id: InteractiveRequestId.makeUnsafe("request-1"),
            threadId: ThreadId.makeUnsafe("thread-child"),
            phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
            type: "user-input",
            status: "pending",
            payload: {
              type: "user-input",
              questions: [{ id: "scope", question: "Ship it?" }],
            },
            createdAt: "2026-04-05T00:00:11.000Z",
          },
        ]);

        const parentThread = snapshot.threads.find((thread) => thread.id === "thread-parent");
        const childThread = snapshot.threads.find((thread) => thread.id === "thread-child");

        assert.deepEqual(parentThread?.childThreadIds, [ThreadId.makeUnsafe("thread-child")]);
        assert.equal(childThread?.parentThreadId, ThreadId.makeUnsafe("thread-parent"));
        assert.equal(childThread?.phaseRunId, "phase-run-1");
        assert.equal(childThread?.workflowId, "workflow-1");
        assert.equal(childThread?.currentPhaseId, "phase-1");
        assert.equal(childThread?.role, "reviewer");
        assert.equal(childThread?.bootstrapStatus, "running");
      }),
  );

  it.effect("pins snapshotSequence to the lagging threadTurns projector used for latestTurn", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-sequence',
          'Sequence Project',
          '/tmp/project-sequence',
          NULL,
          '[]',
          '2026-04-05T01:00:00.000Z',
          '2026-04-05T01:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-sequence',
          'project-sequence',
          'Sequence Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-sequence',
          '2026-04-05T01:00:02.000Z',
          '2026-04-05T01:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-sequence',
          'turn-sequence',
          NULL,
          NULL,
          NULL,
          NULL,
          'completed',
          '2026-04-05T01:00:04.000Z',
          '2026-04-05T01:00:04.000Z',
          '2026-04-05T01:00:05.000Z',
          1,
          'checkpoint-sequence',
          'ready',
          '[]'
        )
      `;

      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        const sequence = projector === ORCHESTRATION_PROJECTOR_NAMES.threadTurns ? 3 : 20;
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-04-05T01:00:06.000Z'
          )
        `;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 3);
      assert.equal(snapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-sequence"));
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.makeUnsafe("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.makeUnsafe("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.makeUnsafe("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );
});
