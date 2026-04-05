import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ChannelClosedPayload,
  ChannelConclusionProposedPayload,
  ChannelCloseCommand,
  ChannelConcludedPayload,
  ChannelConclusionEvent,
  ChannelConcludeCommand,
  ChannelCreatedPayload,
  ChannelMessageEvent,
  ChannelCreateCommand,
  ChannelMessagePostedPayload,
  ChannelMessagesReadPayload,
  ChannelPostMessageCommand,
  ChannelPushEvent,
  ChannelReadMessagesCommand,
  ChannelStatusEvent,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ForgeCommand,
  ForgeClientSnapshot,
  ForgeReadModel,
  ForgeEvent,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  InteractiveRequestOpenedPayload,
  InteractiveRequestResolvedPayload,
  InteractiveRequestStalePayload,
  OrchestrationProposedPlan,
  OrchestrationSession,
  ProjectCreateCommand,
  RequestMarkStaleCommand,
  RequestOpenCommand,
  RequestResolveCommand,
  SessionArchivedPayload,
  SessionCancelCommand,
  SessionCancelledPayload,
  SessionCheckpointCapturedPayload,
  SessionCheckpointDiffCompletedPayload,
  SessionCheckpointRevertedPayload,
  SessionCompletedPayload,
  SessionCreateCommand,
  SessionCreatedPayload,
  SessionFailedPayload,
  SessionMetaUpdateCommand,
  SessionPauseCommand,
  SessionRecoverCommand,
  SessionRestartCommand,
  SessionRestartTurnCommand,
  SessionRestartedPayload,
  SessionResumeCommand,
  SessionMessageSentPayload,
  SessionSendMessageCommand,
  SessionSendTurnCommand,
  SessionStatusChangedPayload,
  SessionTurnCompletedPayload,
  SessionTurnRequestedPayload,
  SessionTurnRestartedPayload,
  SessionTurnStartedPayload,
  ThreadAddDependencyCommand,
  ThreadAddLinkCommand,
  ThreadBootstrapQueuedPayload,
  ThreadBootstrapCompletedPayload,
  ThreadBootstrapCompletedCommand,
  ThreadBootstrapFailedPayload,
  ThreadBootstrapFailedCommand,
  ThreadBootstrapSkippedPayload,
  ThreadBootstrapSkippedCommand,
  ThreadBootstrapStartedPayload,
  ThreadBootstrapStartedCommand,
  ThreadCompletePhaseCommand,
  ThreadCorrectCommand,
  ThreadCorrectionDeliveredPayload,
  ThreadCorrectionQueuedPayload,
  ThreadDependenciesSatisfiedPayload,
  ThreadDependencyAddedPayload,
  ThreadDependencyRemovedPayload,
  ThreadEditPhaseOutputCommand,
  ThreadFailPhaseCommand,
  ThreadLinkAddedPayload,
  ThreadLinkRemovedPayload,
  ThreadMetaUpdatedPayload,
  ThreadPhaseCompletedPayload,
  ThreadPhaseFailedPayload,
  ThreadPhaseOutputEditedPayload,
  ThreadPhaseSkippedPayload,
  ThreadPhaseStartedPayload,
  ThreadPromoteCommand,
  ThreadPromotedPayload,
  ThreadQualityCheckCompletedPayload,
  ThreadQualityCheckCompleteCommand,
  ThreadQualityCheckStartedPayload,
  ThreadQualityCheckStartCommand,
  ThreadRemoveDependencyCommand,
  ThreadRemoveLinkCommand,
  ThreadSkipPhaseCommand,
  ThreadStartPhaseCommand,
  ThreadSynthesisCompletedPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
  WorkflowBootstrapEvent,
  WorkflowGateEvent,
  WorkflowPhaseEvent,
  WorkflowPushEvent,
  WorkflowQualityCheckEvent,
} from "./orchestration";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeForgeCommand = Schema.decodeUnknownEffect(ForgeCommand);
const decodeForgeEvent = Schema.decodeUnknownEffect(ForgeEvent);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const encode = <S extends Schema.Top>(
  schema: S,
  input: Schema.Schema.Type<S>,
): Effect.Effect<unknown, Schema.SchemaError, never> =>
  Schema.encodeEffect(schema as never)(input as never) as Effect.Effect<
    unknown,
    Schema.SchemaError,
    never
  >;

const roundTrip = <S extends Schema.Top>(schema: S, input: unknown) =>
  Effect.gen(function* () {
    const parsed = yield* decode(schema, input);
    const encoded = yield* encode(schema, parsed);
    return { parsed, encoded };
  });

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      provider: "codex",
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "codex");
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "claudeAgent");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.provider, "codex");
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "claudeAgent");
  }),
);

it.effect("decodes thread archive and unarchive commands", () =>
  Effect.gen(function* () {
    const archive = yield* decodeOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
    });
    const unarchive = yield* decodeOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
    });

    assert.strictEqual(archive.type, "thread.archive");
    assert.strictEqual(unarchive.type, "thread.unarchive");
  }),
);

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.strictEqual(archived.type, "thread.archived");
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "codex");
    assert.strictEqual(parsed.modelSelection?.options?.reasoningEffort, "high");
    assert.strictEqual(parsed.modelSelection?.options?.fastMode, true);
  }),
);

it.effect("accepts a title seed in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-seed",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-seed",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("accepts a source proposed plan reference in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-source-plan",
      threadId: "thread-2",
      message: {
        messageId: "msg-source-plan",
        role: "user",
        text: "implement this",
        attachments: [],
      },
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);

it.effect("round-trips the Forge lifecycle command surface through ForgeCommand", () =>
  Effect.gen(function* () {
    const cases = [
      {
        schema: SessionCreateCommand,
        input: {
          type: "thread.create",
          commandId: " cmd-session-create-1 ",
          threadId: " thread-1 ",
          projectId: " project-1 ",
          parentThreadId: " parent-1 ",
          phaseRunId: " phase-run-1 ",
          sessionType: "workflow",
          title: " Workflow Session ",
          description: " Create a workflow session. ",
          workflowId: " workflow-1 ",
          patternId: " pattern-1 ",
          runtimeMode: "full-access",
          model: {
            provider: "codex",
            model: " gpt-5.4 ",
          },
          provider: "codex",
          role: " orchestrator ",
          branchOverride: " feat/workflow ",
          requiresWorktree: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        expected: {
          type: "thread.create",
          commandId: "cmd-session-create-1",
          threadId: "thread-1",
          projectId: "project-1",
          parentThreadId: "parent-1",
          phaseRunId: "phase-run-1",
          sessionType: "workflow",
          title: "Workflow Session",
          description: " Create a workflow session. ",
          workflowId: "workflow-1",
          patternId: "pattern-1",
          runtimeMode: "full-access",
          model: {
            provider: "codex",
            model: "gpt-5.4",
          },
          provider: "codex",
          role: "orchestrator",
          branchOverride: "feat/workflow",
          requiresWorktree: true,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        schema: SessionPauseCommand,
        input: {
          type: "thread.pause",
          commandId: " cmd-session-pause-1 ",
          threadId: " thread-1 ",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
        expected: {
          type: "thread.pause",
          commandId: "cmd-session-pause-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      },
      {
        schema: SessionResumeCommand,
        input: {
          type: "thread.resume",
          commandId: "cmd-session-resume-1",
          threadId: " thread-1 ",
          createdAt: "2026-01-01T00:02:00.000Z",
        },
        expected: {
          type: "thread.resume",
          commandId: "cmd-session-resume-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:02:00.000Z",
        },
      },
      {
        schema: SessionRecoverCommand,
        input: {
          type: "thread.recover",
          commandId: "cmd-session-recover-1",
          threadId: " thread-1 ",
          createdAt: "2026-01-01T00:03:00.000Z",
        },
        expected: {
          type: "thread.recover",
          commandId: "cmd-session-recover-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:03:00.000Z",
        },
      },
      {
        schema: SessionCancelCommand,
        input: {
          type: "thread.cancel",
          commandId: "cmd-session-cancel-1",
          threadId: " thread-1 ",
          reason: "Cancelled by operator.",
          createdAt: "2026-01-01T00:04:00.000Z",
        },
        expected: {
          type: "thread.cancel",
          commandId: "cmd-session-cancel-1",
          threadId: "thread-1",
          reason: "Cancelled by operator.",
          createdAt: "2026-01-01T00:04:00.000Z",
        },
      },
      {
        schema: SessionRestartCommand,
        input: {
          type: "thread.restart",
          commandId: "cmd-session-restart-1",
          threadId: " thread-1 ",
          fromPhaseId: " phase-1 ",
          createdAt: "2026-01-01T00:05:00.000Z",
        },
        expected: {
          type: "thread.restart",
          commandId: "cmd-session-restart-1",
          threadId: "thread-1",
          fromPhaseId: "phase-1",
          createdAt: "2026-01-01T00:05:00.000Z",
        },
      },
      {
        schema: SessionMetaUpdateCommand,
        input: {
          type: "thread.meta-update",
          commandId: "cmd-session-meta-update-1",
          threadId: " thread-1 ",
          title: " Refined Title ",
          description: "Refined description.",
          branch: " feat/refined ",
          worktreePath: " /tmp/worktree ",
          createdAt: "2026-01-01T00:06:00.000Z",
        },
        expected: {
          type: "thread.meta-update",
          commandId: "cmd-session-meta-update-1",
          threadId: "thread-1",
          title: "Refined Title",
          description: "Refined description.",
          branch: "feat/refined",
          worktreePath: "/tmp/worktree",
          createdAt: "2026-01-01T00:06:00.000Z",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = yield* decode(testCase.schema, testCase.input);
      assert.deepStrictEqual(parsed, testCase.expected);
      assert.deepStrictEqual(yield* decodeForgeCommand(testCase.input), testCase.expected);
      assert.deepStrictEqual(yield* encode(testCase.schema, parsed), testCase.expected);
    }
  }),
);

it.effect("round-trips additive workflow, channel, and request commands through ForgeCommand", () =>
  Effect.gen(function* () {
    const cases = [
      {
        schema: ThreadCorrectCommand,
        input: {
          type: "thread.correct",
          commandId: " cmd-correct-1 ",
          threadId: " thread-1 ",
          content: "Please address the failing lint errors.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        expected: {
          type: "thread.correct",
          commandId: "cmd-correct-1",
          threadId: "thread-1",
          content: "Please address the failing lint errors.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        schema: ThreadStartPhaseCommand,
        input: {
          type: "thread.start-phase",
          commandId: "cmd-start-phase-1",
          threadId: "thread-1",
          phaseId: " phase-1 ",
          phaseName: " Implement ",
          phaseType: "single-agent",
          iteration: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        expected: {
          type: "thread.start-phase",
          commandId: "cmd-start-phase-1",
          threadId: "thread-1",
          phaseId: "phase-1",
          phaseName: "Implement",
          phaseType: "single-agent",
          iteration: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        schema: ThreadCompletePhaseCommand,
        input: {
          type: "thread.complete-phase",
          commandId: "cmd-complete-phase-1",
          threadId: "thread-1",
          phaseRunId: " phase-run-1 ",
          outputs: [
            {
              key: " output ",
              content: "Summary",
              sourceType: " agent ",
            },
          ],
          gateResult: {
            status: "passed",
            evaluatedAt: "2026-01-01T00:05:00.000Z",
          },
          createdAt: "2026-01-01T00:06:00.000Z",
        },
        expected: {
          type: "thread.complete-phase",
          commandId: "cmd-complete-phase-1",
          threadId: "thread-1",
          phaseRunId: "phase-run-1",
          outputs: [
            {
              key: "output",
              content: "Summary",
              sourceType: "agent",
            },
          ],
          gateResult: {
            status: "passed",
            evaluatedAt: "2026-01-01T00:05:00.000Z",
          },
          createdAt: "2026-01-01T00:06:00.000Z",
        },
      },
      {
        schema: ThreadFailPhaseCommand,
        input: {
          type: "thread.fail-phase",
          commandId: "cmd-fail-phase-1",
          threadId: "thread-1",
          phaseRunId: " phase-run-1 ",
          error: "Compile failed",
          createdAt: "2026-01-01T00:06:00.000Z",
        },
        expected: {
          type: "thread.fail-phase",
          commandId: "cmd-fail-phase-1",
          threadId: "thread-1",
          phaseRunId: "phase-run-1",
          error: "Compile failed",
          createdAt: "2026-01-01T00:06:00.000Z",
        },
      },
      {
        schema: ThreadSkipPhaseCommand,
        input: {
          type: "thread.skip-phase",
          commandId: "cmd-skip-phase-1",
          threadId: "thread-1",
          phaseRunId: " phase-run-1 ",
          createdAt: "2026-01-01T00:06:00.000Z",
        },
        expected: {
          type: "thread.skip-phase",
          commandId: "cmd-skip-phase-1",
          threadId: "thread-1",
          phaseRunId: "phase-run-1",
          createdAt: "2026-01-01T00:06:00.000Z",
        },
      },
      {
        schema: ThreadEditPhaseOutputCommand,
        input: {
          type: "thread.edit-phase-output",
          commandId: "cmd-edit-output-1",
          threadId: "thread-1",
          phaseRunId: " phase-run-1 ",
          outputKey: " output ",
          content: "Edited output",
          createdAt: "2026-01-01T00:07:00.000Z",
        },
        expected: {
          type: "thread.edit-phase-output",
          commandId: "cmd-edit-output-1",
          threadId: "thread-1",
          phaseRunId: "phase-run-1",
          outputKey: "output",
          content: "Edited output",
          createdAt: "2026-01-01T00:07:00.000Z",
        },
      },
      {
        schema: ThreadQualityCheckStartCommand,
        input: {
          type: "thread.quality-check-start",
          commandId: "cmd-quality-start-1",
          threadId: "thread-1",
          phaseRunId: " phase-run-1 ",
          checks: [
            {
              check: " lint ",
              required: true,
            },
          ],
          createdAt: "2026-01-01T00:08:00.000Z",
        },
        expected: {
          type: "thread.quality-check-start",
          commandId: "cmd-quality-start-1",
          threadId: "thread-1",
          phaseRunId: "phase-run-1",
          checks: [
            {
              check: "lint",
              required: true,
            },
          ],
          createdAt: "2026-01-01T00:08:00.000Z",
        },
      },
      {
        schema: ThreadQualityCheckCompleteCommand,
        input: {
          type: "thread.quality-check-complete",
          commandId: "cmd-quality-complete-1",
          threadId: "thread-1",
          phaseRunId: " phase-run-1 ",
          results: [
            {
              check: " test ",
              passed: false,
              output: "1 failing test",
            },
          ],
          createdAt: "2026-01-01T00:09:00.000Z",
        },
        expected: {
          type: "thread.quality-check-complete",
          commandId: "cmd-quality-complete-1",
          threadId: "thread-1",
          phaseRunId: "phase-run-1",
          results: [
            {
              check: "test",
              passed: false,
              output: "1 failing test",
            },
          ],
          createdAt: "2026-01-01T00:09:00.000Z",
        },
      },
      {
        schema: ThreadBootstrapStartedCommand,
        input: {
          type: "thread.bootstrap-started",
          commandId: "cmd-bootstrap-started-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:10:00.000Z",
        },
        expected: {
          type: "thread.bootstrap-started",
          commandId: "cmd-bootstrap-started-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:10:00.000Z",
        },
      },
      {
        schema: ThreadBootstrapCompletedCommand,
        input: {
          type: "thread.bootstrap-completed",
          commandId: "cmd-bootstrap-completed-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:11:00.000Z",
        },
        expected: {
          type: "thread.bootstrap-completed",
          commandId: "cmd-bootstrap-completed-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:11:00.000Z",
        },
      },
      {
        schema: ThreadBootstrapFailedCommand,
        input: {
          type: "thread.bootstrap-failed",
          commandId: "cmd-bootstrap-failed-1",
          threadId: "thread-1",
          error: "Install failed",
          stdout: "npm error output",
          command: " bun install ",
          createdAt: "2026-01-01T00:12:00.000Z",
        },
        expected: {
          type: "thread.bootstrap-failed",
          commandId: "cmd-bootstrap-failed-1",
          threadId: "thread-1",
          error: "Install failed",
          stdout: "npm error output",
          command: "bun install",
          createdAt: "2026-01-01T00:12:00.000Z",
        },
      },
      {
        schema: ThreadBootstrapSkippedCommand,
        input: {
          type: "thread.bootstrap-skipped",
          commandId: "cmd-bootstrap-skipped-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:13:00.000Z",
        },
        expected: {
          type: "thread.bootstrap-skipped",
          commandId: "cmd-bootstrap-skipped-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:13:00.000Z",
        },
      },
      {
        schema: ThreadAddLinkCommand,
        input: {
          type: "thread.add-link",
          commandId: "cmd-add-link-1",
          threadId: "thread-1",
          linkId: " link-1 ",
          linkType: "related",
          externalId: " GH-123 ",
          externalUrl: " https://example.com/issues/123 ",
          createdAt: "2026-01-01T00:14:00.000Z",
        },
        expected: {
          type: "thread.add-link",
          commandId: "cmd-add-link-1",
          threadId: "thread-1",
          linkId: "link-1",
          linkType: "related",
          externalId: "GH-123",
          externalUrl: "https://example.com/issues/123",
          createdAt: "2026-01-01T00:14:00.000Z",
        },
      },
      {
        schema: ThreadRemoveLinkCommand,
        input: {
          type: "thread.remove-link",
          commandId: "cmd-remove-link-1",
          threadId: "thread-1",
          linkId: " link-1 ",
          createdAt: "2026-01-01T00:15:00.000Z",
        },
        expected: {
          type: "thread.remove-link",
          commandId: "cmd-remove-link-1",
          threadId: "thread-1",
          linkId: "link-1",
          createdAt: "2026-01-01T00:15:00.000Z",
        },
      },
      {
        schema: ThreadPromoteCommand,
        input: {
          type: "thread.promote",
          commandId: "cmd-promote-1",
          sourceThreadId: "thread-1",
          targetThreadId: "thread-2",
          targetWorkflowId: " workflow-1 ",
          title: " Workflow Session ",
          description: "Promote this chat into a workflow.",
          createdAt: "2026-01-01T00:16:00.000Z",
        },
        expected: {
          type: "thread.promote",
          commandId: "cmd-promote-1",
          sourceThreadId: "thread-1",
          targetThreadId: "thread-2",
          targetWorkflowId: "workflow-1",
          title: "Workflow Session",
          description: "Promote this chat into a workflow.",
          createdAt: "2026-01-01T00:16:00.000Z",
        },
      },
      {
        schema: ThreadAddDependencyCommand,
        input: {
          type: "thread.add-dependency",
          commandId: "cmd-add-dependency-1",
          threadId: "thread-1",
          dependsOnThreadId: " thread-2 ",
          createdAt: "2026-01-01T00:17:00.000Z",
        },
        expected: {
          type: "thread.add-dependency",
          commandId: "cmd-add-dependency-1",
          threadId: "thread-1",
          dependsOnThreadId: "thread-2",
          createdAt: "2026-01-01T00:17:00.000Z",
        },
      },
      {
        schema: ThreadRemoveDependencyCommand,
        input: {
          type: "thread.remove-dependency",
          commandId: "cmd-remove-dependency-1",
          threadId: "thread-1",
          dependsOnThreadId: " thread-2 ",
          createdAt: "2026-01-01T00:18:00.000Z",
        },
        expected: {
          type: "thread.remove-dependency",
          commandId: "cmd-remove-dependency-1",
          threadId: "thread-1",
          dependsOnThreadId: "thread-2",
          createdAt: "2026-01-01T00:18:00.000Z",
        },
      },
      {
        schema: ChannelCreateCommand,
        input: {
          type: "channel.create",
          commandId: "cmd-channel-create-1",
          channelId: " channel-1 ",
          threadId: "thread-1",
          channelType: "guidance",
          phaseRunId: " phase-run-1 ",
          createdAt: "2026-01-01T00:19:00.000Z",
        },
        expected: {
          type: "channel.create",
          commandId: "cmd-channel-create-1",
          channelId: "channel-1",
          threadId: "thread-1",
          channelType: "guidance",
          phaseRunId: "phase-run-1",
          createdAt: "2026-01-01T00:19:00.000Z",
        },
      },
      {
        schema: ChannelPostMessageCommand,
        input: {
          type: "channel.post-message",
          commandId: "cmd-channel-post-1",
          channelId: " channel-1 ",
          messageId: " message-1 ",
          fromType: "agent",
          fromId: " thread-2 ",
          fromRole: " advocate ",
          content: "Here is the first review note.",
          createdAt: "2026-01-01T00:20:00.000Z",
        },
        expected: {
          type: "channel.post-message",
          commandId: "cmd-channel-post-1",
          channelId: "channel-1",
          messageId: "message-1",
          fromType: "agent",
          fromId: "thread-2",
          fromRole: "advocate",
          content: "Here is the first review note.",
          createdAt: "2026-01-01T00:20:00.000Z",
        },
      },
      {
        schema: ChannelReadMessagesCommand,
        input: {
          type: "channel.read-messages",
          commandId: "cmd-channel-read-1",
          channelId: " channel-1 ",
          threadId: " thread-2 ",
          upToSequence: 4,
          createdAt: "2026-01-01T00:21:00.000Z",
        },
        expected: {
          type: "channel.read-messages",
          commandId: "cmd-channel-read-1",
          channelId: "channel-1",
          threadId: "thread-2",
          upToSequence: 4,
          createdAt: "2026-01-01T00:21:00.000Z",
        },
      },
      {
        schema: ChannelConcludeCommand,
        input: {
          type: "channel.conclude",
          commandId: "cmd-channel-conclude-1",
          channelId: " channel-1 ",
          threadId: " thread-2 ",
          summary: "Consensus reached on the plan.",
          createdAt: "2026-01-01T00:22:00.000Z",
        },
        expected: {
          type: "channel.conclude",
          commandId: "cmd-channel-conclude-1",
          channelId: "channel-1",
          threadId: "thread-2",
          summary: "Consensus reached on the plan.",
          createdAt: "2026-01-01T00:22:00.000Z",
        },
      },
      {
        schema: ChannelCloseCommand,
        input: {
          type: "channel.close",
          commandId: "cmd-channel-close-1",
          channelId: " channel-1 ",
          createdAt: "2026-01-01T00:23:00.000Z",
        },
        expected: {
          type: "channel.close",
          commandId: "cmd-channel-close-1",
          channelId: "channel-1",
          createdAt: "2026-01-01T00:23:00.000Z",
        },
      },
      {
        schema: RequestOpenCommand,
        input: {
          type: "request.open",
          commandId: "cmd-request-open-1",
          requestId: " request-1 ",
          threadId: "thread-1",
          childThreadId: " thread-2 ",
          phaseRunId: " phase-run-1 ",
          requestType: "gate",
          payload: {
            type: "gate",
            gateType: " human-approval ",
            phaseRunId: " phase-run-1 ",
            phaseOutput: "Ready for review",
          },
          createdAt: "2026-01-01T00:24:00.000Z",
        },
        expected: {
          type: "request.open",
          commandId: "cmd-request-open-1",
          requestId: "request-1",
          threadId: "thread-1",
          childThreadId: "thread-2",
          phaseRunId: "phase-run-1",
          requestType: "gate",
          payload: {
            type: "gate",
            gateType: "human-approval",
            phaseRunId: "phase-run-1",
            phaseOutput: "Ready for review",
          },
          createdAt: "2026-01-01T00:24:00.000Z",
        },
      },
      {
        schema: RequestResolveCommand,
        input: {
          type: "request.resolve",
          commandId: "cmd-request-resolve-1",
          requestId: " request-1 ",
          resolvedWith: {
            decision: "approve",
          },
          createdAt: "2026-01-01T00:25:00.000Z",
        },
        expected: {
          type: "request.resolve",
          commandId: "cmd-request-resolve-1",
          requestId: "request-1",
          resolvedWith: {
            decision: "approve",
          },
          createdAt: "2026-01-01T00:25:00.000Z",
        },
      },
      {
        schema: RequestMarkStaleCommand,
        input: {
          type: "request.mark-stale",
          commandId: "cmd-request-stale-1",
          requestId: " request-1 ",
          reason: "Superseded by a newer review request.",
          createdAt: "2026-01-01T00:26:00.000Z",
        },
        expected: {
          type: "request.mark-stale",
          commandId: "cmd-request-stale-1",
          requestId: "request-1",
          reason: "Superseded by a newer review request.",
          createdAt: "2026-01-01T00:26:00.000Z",
        },
      },
    ];

    for (const testCase of cases) {
      const { parsed, encoded } = yield* roundTrip(testCase.schema, testCase.input);
      const unionParsed = yield* decodeForgeCommand(testCase.input);

      assert.deepStrictEqual(parsed, testCase.expected);
      assert.deepStrictEqual(encoded, testCase.expected);
      assert.deepStrictEqual(unionParsed, testCase.expected);
    }
  }),
);

it.effect("rejects thread.add-link when no linked thread or external id is provided", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      roundTrip(ThreadAddLinkCommand, {
        type: "thread.add-link",
        commandId: "cmd-add-link-invalid-1",
        threadId: "thread-1",
        linkId: "link-1",
        linkType: "related",
        createdAt: "2026-01-01T00:30:00.000Z",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("round-trips the spec-defined leaf-session turn commands through ForgeCommand", () =>
  Effect.gen(function* () {
    const cases = [
      {
        schema: SessionSendTurnCommand,
        input: {
          type: "thread.send-turn",
          commandId: " cmd-send-turn-1 ",
          threadId: " thread-1 ",
          content: "Please continue with the implementation.",
          attachments: [
            {
              type: "image",
              name: "diagram.png",
            },
          ],
          createdAt: "2026-01-01T00:27:00.000Z",
        },
        expected: {
          type: "thread.send-turn",
          commandId: "cmd-send-turn-1",
          threadId: "thread-1",
          content: "Please continue with the implementation.",
          attachments: [
            {
              type: "image",
              name: "diagram.png",
            },
          ],
          createdAt: "2026-01-01T00:27:00.000Z",
        },
      },
      {
        schema: SessionRestartTurnCommand,
        input: {
          type: "thread.restart-turn",
          commandId: " cmd-restart-turn-1 ",
          threadId: " thread-1 ",
          createdAt: "2026-01-01T00:28:00.000Z",
        },
        expected: {
          type: "thread.restart-turn",
          commandId: "cmd-restart-turn-1",
          threadId: "thread-1",
          createdAt: "2026-01-01T00:28:00.000Z",
        },
      },
      {
        schema: SessionSendMessageCommand,
        input: {
          type: "thread.send-message",
          commandId: " cmd-send-message-1 ",
          threadId: " thread-1 ",
          messageId: " message-1 ",
          role: " assistant ",
          content: "Partial output from the provider.",
          createdAt: "2026-01-01T00:29:00.000Z",
        },
        expected: {
          type: "thread.send-message",
          commandId: "cmd-send-message-1",
          threadId: "thread-1",
          messageId: "message-1",
          role: "assistant",
          content: "Partial output from the provider.",
          createdAt: "2026-01-01T00:29:00.000Z",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { parsed, encoded } = yield* roundTrip(testCase.schema, testCase.input);
      const unionParsed = yield* decodeForgeCommand(testCase.input);

      assert.deepStrictEqual(parsed, testCase.expected);
      assert.deepStrictEqual(encoded, testCase.expected);
      assert.deepStrictEqual(unionParsed, testCase.expected);
    }
  }),
);

it.effect("round-trips the Forge lifecycle event surface through ForgeEvent", () =>
  Effect.gen(function* () {
    const baseEvent = {
      sequence: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      causationEventId: null,
      metadata: {},
    } as const;

    const cases = [
      {
        payloadSchema: SessionCreatedPayload,
        event: {
          ...baseEvent,
          eventId: "event-session-created-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.created",
          commandId: "cmd-session-create-1",
          correlationId: "cmd-session-create-1",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            parentThreadId: "parent-1",
            phaseRunId: "phase-run-1",
            sessionType: "workflow",
            title: " Workflow Session ",
            description: "Workflow description",
            workflowId: "workflow-1",
            workflowSnapshot: '{"id":"workflow-1"}',
            patternId: " pattern-1 ",
            runtimeMode: "full-access",
            model: {
              provider: "codex",
              model: " gpt-5.4 ",
            },
            provider: "codex",
            role: " orchestrator ",
            branch: " feat/workflow ",
            bootstrapStatus: "queued",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          projectId: "project-1",
          parentThreadId: "parent-1",
          phaseRunId: "phase-run-1",
          sessionType: "workflow",
          title: "Workflow Session",
          description: "Workflow description",
          workflowId: "workflow-1",
          workflowSnapshot: '{"id":"workflow-1"}',
          patternId: "pattern-1",
          runtimeMode: "full-access",
          model: {
            provider: "codex",
            model: "gpt-5.4",
          },
          provider: "codex",
          role: "orchestrator",
          branch: "feat/workflow",
          bootstrapStatus: "queued",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        payloadSchema: SessionStatusChangedPayload,
        event: {
          ...baseEvent,
          sequence: 2,
          eventId: "event-session-status-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.status-changed",
          commandId: "cmd-session-pause-1",
          correlationId: "cmd-session-pause-1",
          payload: {
            threadId: "thread-1",
            status: "paused",
            previousStatus: "running",
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          status: "paused",
          previousStatus: "running",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
      },
      {
        payloadSchema: ThreadMetaUpdatedPayload,
        event: {
          ...baseEvent,
          sequence: 3,
          eventId: "event-session-meta-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.meta-updated",
          commandId: "cmd-session-meta-update-1",
          correlationId: "cmd-session-meta-update-1",
          payload: {
            threadId: "thread-1",
            title: " Refined Title ",
            description: "Refined description.",
            branch: " feat/refined ",
            worktreePath: " /tmp/worktree ",
            updatedAt: "2026-01-01T00:02:00.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          title: "Refined Title",
          description: "Refined description.",
          branch: "feat/refined",
          worktreePath: "/tmp/worktree",
          updatedAt: "2026-01-01T00:02:00.000Z",
        },
      },
      {
        payloadSchema: SessionCompletedPayload,
        event: {
          ...baseEvent,
          sequence: 4,
          eventId: "event-session-completed-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.completed",
          commandId: "cmd-session-complete-1",
          correlationId: "cmd-session-complete-1",
          payload: {
            threadId: "thread-1",
            completedAt: "2026-01-01T00:03:00.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          completedAt: "2026-01-01T00:03:00.000Z",
        },
      },
      {
        payloadSchema: SessionFailedPayload,
        event: {
          ...baseEvent,
          sequence: 5,
          eventId: "event-session-failed-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.failed",
          commandId: "cmd-session-fail-1",
          correlationId: "cmd-session-fail-1",
          payload: {
            threadId: "thread-1",
            error: "Workflow failed",
            failedAt: "2026-01-01T00:04:00.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          error: "Workflow failed",
          failedAt: "2026-01-01T00:04:00.000Z",
        },
      },
      {
        payloadSchema: SessionCancelledPayload,
        event: {
          ...baseEvent,
          sequence: 6,
          eventId: "event-session-cancelled-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.cancelled",
          commandId: "cmd-session-cancel-1",
          correlationId: "cmd-session-cancel-1",
          payload: {
            threadId: "thread-1",
            reason: "Cancelled by operator.",
            cancelledAt: "2026-01-01T00:05:00.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          reason: "Cancelled by operator.",
          cancelledAt: "2026-01-01T00:05:00.000Z",
        },
      },
      {
        payloadSchema: SessionArchivedPayload,
        event: {
          ...baseEvent,
          sequence: 7,
          eventId: "event-session-archived-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.archived",
          commandId: "cmd-session-archive-1",
          correlationId: "cmd-session-archive-1",
          payload: {
            threadId: "thread-1",
            archivedAt: "2026-01-01T00:06:00.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          archivedAt: "2026-01-01T00:06:00.000Z",
        },
      },
      {
        payloadSchema: SessionTurnRequestedPayload,
        event: {
          ...baseEvent,
          sequence: 8,
          eventId: "event-session-turn-requested-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.turn-requested",
          commandId: "cmd-session-turn-requested-1",
          correlationId: "cmd-session-turn-requested-1",
          payload: {
            threadId: "thread-1",
            content: "Continue with the implementation.",
            createdAt: "2026-01-01T00:06:30.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          content: "Continue with the implementation.",
          createdAt: "2026-01-01T00:06:30.000Z",
        },
      },
      {
        payloadSchema: SessionTurnStartedPayload,
        event: {
          ...baseEvent,
          sequence: 9,
          eventId: "event-session-turn-started-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.turn-started",
          commandId: "cmd-session-turn-requested-1",
          correlationId: "cmd-session-turn-requested-1",
          payload: {
            threadId: "thread-1",
            turnId: " turn-1 ",
            startedAt: "2026-01-01T00:06:45.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          turnId: "turn-1",
          startedAt: "2026-01-01T00:06:45.000Z",
        },
      },
      {
        payloadSchema: SessionTurnCompletedPayload,
        event: {
          ...baseEvent,
          sequence: 10,
          eventId: "event-session-turn-completed-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.turn-completed",
          commandId: "cmd-session-turn-requested-1",
          correlationId: "cmd-session-turn-requested-1",
          payload: {
            threadId: "thread-1",
            turnId: " turn-1 ",
            completedAt: "2026-01-01T00:07:00.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          turnId: "turn-1",
          completedAt: "2026-01-01T00:07:00.000Z",
        },
      },
      {
        payloadSchema: SessionTurnRestartedPayload,
        event: {
          ...baseEvent,
          sequence: 11,
          eventId: "event-session-turn-restarted-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.turn-restarted",
          commandId: "cmd-session-turn-restart-1",
          correlationId: "cmd-session-turn-restart-1",
          payload: {
            threadId: "thread-1",
            restartedAt: "2026-01-01T00:07:15.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          restartedAt: "2026-01-01T00:07:15.000Z",
        },
      },
      {
        payloadSchema: SessionMessageSentPayload,
        event: {
          ...baseEvent,
          sequence: 12,
          eventId: "event-session-message-sent-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.message-sent",
          commandId: "cmd-session-message-sent-1",
          correlationId: "cmd-session-message-sent-1",
          payload: {
            threadId: "thread-1",
            messageId: " message-1 ",
            role: " assistant ",
            content: "Implementation complete.",
            turnId: " turn-1 ",
            streaming: false,
            createdAt: "2026-01-01T00:07:30.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          messageId: "message-1",
          role: "assistant",
          content: "Implementation complete.",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-01-01T00:07:30.000Z",
        },
      },
      {
        payloadSchema: SessionRestartedPayload,
        event: {
          ...baseEvent,
          sequence: 13,
          eventId: "event-session-restarted-1",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          type: "thread.restarted",
          commandId: "cmd-session-restart-1",
          correlationId: "cmd-session-restart-1",
          payload: {
            threadId: "thread-1",
            fromPhaseId: " phase-1 ",
            restartedAt: "2026-01-01T00:07:00.000Z",
          },
        },
        expectedPayload: {
          threadId: "thread-1",
          fromPhaseId: "phase-1",
          restartedAt: "2026-01-01T00:07:00.000Z",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { parsed, encoded } = yield* roundTrip(ForgeEvent, testCase.event);

      assert.deepStrictEqual(parsed.payload, testCase.expectedPayload);
      assert.deepStrictEqual(
        yield* decode(testCase.payloadSchema, testCase.event.payload),
        testCase.expectedPayload,
      );
      assert.deepStrictEqual(encoded, {
        ...testCase.event,
        payload: testCase.expectedPayload,
      });
    }
  }),
);

it.effect(
  "round-trips additive workflow, checkpoint, channel, and request events through ForgeEvent",
  () =>
    Effect.gen(function* () {
      const baseEvent = {
        sequence: 1,
        eventId: "event-1",
        occurredAt: "2026-01-01T01:00:00.000Z",
        commandId: "cmd-event-1",
        causationEventId: null,
        correlationId: "cmd-event-1",
        metadata: {},
      } as const;

      const cases = [
        {
          payloadSchema: ThreadPhaseStartedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.phase-started",
            payload: {
              threadId: "thread-1",
              phaseRunId: " phase-run-1 ",
              phaseId: " phase-1 ",
              phaseName: " Implement ",
              phaseType: "single-agent",
              iteration: 1,
              startedAt: "2026-01-01T01:00:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            phaseRunId: "phase-run-1",
            phaseId: "phase-1",
            phaseName: "Implement",
            phaseType: "single-agent",
            iteration: 1,
            startedAt: "2026-01-01T01:00:00.000Z",
          },
        },
        {
          payloadSchema: ThreadPhaseCompletedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.phase-completed",
            payload: {
              threadId: "thread-1",
              phaseRunId: " phase-run-1 ",
              outputs: [
                {
                  key: " output ",
                  content: "Implementation complete",
                  sourceType: " agent ",
                },
              ],
              gateResult: {
                status: "passed",
                evaluatedAt: "2026-01-01T01:05:00.000Z",
              },
              completedAt: "2026-01-01T01:06:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            phaseRunId: "phase-run-1",
            outputs: [
              {
                key: "output",
                content: "Implementation complete",
                sourceType: "agent",
              },
            ],
            gateResult: {
              status: "passed",
              evaluatedAt: "2026-01-01T01:05:00.000Z",
            },
            completedAt: "2026-01-01T01:06:00.000Z",
          },
        },
        {
          payloadSchema: ThreadPhaseFailedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.phase-failed",
            payload: {
              threadId: "thread-1",
              phaseRunId: " phase-run-2 ",
              error: "Build failed",
              failedAt: "2026-01-01T01:07:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            phaseRunId: "phase-run-2",
            error: "Build failed",
            failedAt: "2026-01-01T01:07:00.000Z",
          },
        },
        {
          payloadSchema: ThreadPhaseSkippedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.phase-skipped",
            payload: {
              threadId: "thread-1",
              phaseRunId: " phase-run-3 ",
              skippedAt: "2026-01-01T01:08:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            phaseRunId: "phase-run-3",
            skippedAt: "2026-01-01T01:08:00.000Z",
          },
        },
        {
          payloadSchema: ThreadPhaseOutputEditedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.phase-output-edited",
            payload: {
              threadId: "thread-1",
              phaseRunId: " phase-run-1 ",
              outputKey: " summary ",
              previousContent: "Old summary",
              newContent: "New summary",
              editedAt: "2026-01-01T01:09:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            phaseRunId: "phase-run-1",
            outputKey: "summary",
            previousContent: "Old summary",
            newContent: "New summary",
            editedAt: "2026-01-01T01:09:00.000Z",
          },
        },
        {
          payloadSchema: ThreadQualityCheckStartedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.quality-check-started",
            payload: {
              threadId: "thread-1",
              phaseRunId: " phase-run-1 ",
              checks: [{ check: " lint ", required: true }],
              startedAt: "2026-01-01T01:10:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            phaseRunId: "phase-run-1",
            checks: [{ check: "lint", required: true }],
            startedAt: "2026-01-01T01:10:00.000Z",
          },
        },
        {
          payloadSchema: ThreadQualityCheckCompletedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.quality-check-completed",
            payload: {
              threadId: "thread-1",
              phaseRunId: " phase-run-1 ",
              results: [{ check: " test ", passed: false, output: "1 failure" }],
              completedAt: "2026-01-01T01:11:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            phaseRunId: "phase-run-1",
            results: [{ check: "test", passed: false, output: "1 failure" }],
            completedAt: "2026-01-01T01:11:00.000Z",
          },
        },
        {
          payloadSchema: ThreadBootstrapQueuedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.bootstrap-queued",
            payload: {
              threadId: "thread-1",
              queuedAt: "2026-01-01T01:11:30.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            queuedAt: "2026-01-01T01:11:30.000Z",
          },
        },
        {
          payloadSchema: ThreadBootstrapStartedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.bootstrap-started",
            payload: {
              threadId: "thread-1",
              startedAt: "2026-01-01T01:12:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            startedAt: "2026-01-01T01:12:00.000Z",
          },
        },
        {
          payloadSchema: ThreadBootstrapCompletedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.bootstrap-completed",
            payload: {
              threadId: "thread-1",
              completedAt: "2026-01-01T01:13:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            completedAt: "2026-01-01T01:13:00.000Z",
          },
        },
        {
          payloadSchema: ThreadBootstrapFailedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.bootstrap-failed",
            payload: {
              threadId: "thread-1",
              error: "Install failed",
              stdout: "npm ERR!",
              command: " bun install ",
              failedAt: "2026-01-01T01:14:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            error: "Install failed",
            stdout: "npm ERR!",
            command: "bun install",
            failedAt: "2026-01-01T01:14:00.000Z",
          },
        },
        {
          payloadSchema: ThreadBootstrapSkippedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.bootstrap-skipped",
            payload: {
              threadId: "thread-1",
              skippedAt: "2026-01-01T01:15:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            skippedAt: "2026-01-01T01:15:00.000Z",
          },
        },
        {
          payloadSchema: ThreadCorrectionQueuedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.correction-queued",
            payload: {
              threadId: "thread-1",
              content: "Please address the failing test.",
              channelId: " channel-1 ",
              messageId: " channel-message-1 ",
              createdAt: "2026-01-01T01:16:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            content: "Please address the failing test.",
            channelId: "channel-1",
            messageId: "channel-message-1",
            createdAt: "2026-01-01T01:16:00.000Z",
          },
        },
        {
          payloadSchema: ThreadCorrectionDeliveredPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.correction-delivered",
            payload: {
              threadId: "thread-1",
              deliveredAt: "2026-01-01T01:17:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            deliveredAt: "2026-01-01T01:17:00.000Z",
          },
        },
        {
          payloadSchema: ThreadLinkAddedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.link-added",
            payload: {
              threadId: "thread-1",
              linkId: " link-1 ",
              linkType: "related",
              linkedThreadId: null,
              externalId: " GH-123 ",
              externalUrl: " https://example.com/issues/123 ",
              createdAt: "2026-01-01T01:18:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            linkId: "link-1",
            linkType: "related",
            linkedThreadId: null,
            externalId: "GH-123",
            externalUrl: "https://example.com/issues/123",
            createdAt: "2026-01-01T01:18:00.000Z",
          },
        },
        {
          payloadSchema: ThreadLinkRemovedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.link-removed",
            payload: {
              threadId: "thread-1",
              linkId: " link-1 ",
              removedAt: "2026-01-01T01:19:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            linkId: "link-1",
            removedAt: "2026-01-01T01:19:00.000Z",
          },
        },
        {
          payloadSchema: ThreadPromotedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-2",
            type: "thread.promoted",
            payload: {
              sourceThreadId: " thread-1 ",
              targetThreadId: " thread-2 ",
              promotedAt: "2026-01-01T01:20:00.000Z",
            },
          },
          expectedPayload: {
            sourceThreadId: "thread-1",
            targetThreadId: "thread-2",
            promotedAt: "2026-01-01T01:20:00.000Z",
          },
        },
        {
          payloadSchema: ThreadDependencyAddedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.dependency-added",
            payload: {
              threadId: "thread-1",
              dependsOnThreadId: " thread-2 ",
              createdAt: "2026-01-01T01:21:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            dependsOnThreadId: "thread-2",
            createdAt: "2026-01-01T01:21:00.000Z",
          },
        },
        {
          payloadSchema: ThreadDependencyRemovedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.dependency-removed",
            payload: {
              threadId: "thread-1",
              dependsOnThreadId: " thread-2 ",
              removedAt: "2026-01-01T01:22:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            dependsOnThreadId: "thread-2",
            removedAt: "2026-01-01T01:22:00.000Z",
          },
        },
        {
          payloadSchema: ThreadDependenciesSatisfiedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.dependencies-satisfied",
            payload: {
              threadId: "thread-1",
              satisfiedAt: "2026-01-01T01:23:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            satisfiedAt: "2026-01-01T01:23:00.000Z",
          },
        },
        {
          payloadSchema: ThreadSynthesisCompletedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.synthesis-completed",
            payload: {
              threadId: "thread-1",
              content: "Combined findings",
              generatedByThreadId: " thread-2 ",
              completedAt: "2026-01-01T01:24:00.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            content: "Combined findings",
            generatedByThreadId: "thread-2",
            completedAt: "2026-01-01T01:24:00.000Z",
          },
        },
        {
          payloadSchema: SessionCheckpointCapturedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.checkpoint-captured",
            payload: {
              threadId: "thread-1",
              turnId: " turn-1 ",
              turnCount: 4,
              ref: " refs/checkpoints/4 ",
              capturedAt: "2026-01-01T01:24:15.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            turnId: "turn-1",
            turnCount: 4,
            ref: "refs/checkpoints/4",
            capturedAt: "2026-01-01T01:24:15.000Z",
          },
        },
        {
          payloadSchema: SessionCheckpointDiffCompletedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.checkpoint-diff-completed",
            payload: {
              threadId: "thread-1",
              fromTurnCount: 3,
              toTurnCount: 4,
              diff: "diff --git a/file.ts b/file.ts",
              files: [
                {
                  path: " src/file.ts ",
                  kind: " modified ",
                  additions: 10,
                  deletions: 2,
                },
              ],
              completedAt: "2026-01-01T01:24:30.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            fromTurnCount: 3,
            toTurnCount: 4,
            diff: "diff --git a/file.ts b/file.ts",
            files: [
              {
                path: "src/file.ts",
                kind: "modified",
                additions: 10,
                deletions: 2,
              },
            ],
            completedAt: "2026-01-01T01:24:30.000Z",
          },
        },
        {
          payloadSchema: SessionCheckpointRevertedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "thread",
            aggregateId: "thread-1",
            type: "thread.checkpoint-reverted",
            payload: {
              threadId: "thread-1",
              turnCount: 4,
              revertedAt: "2026-01-01T01:24:45.000Z",
            },
          },
          expectedPayload: {
            threadId: "thread-1",
            turnCount: 4,
            revertedAt: "2026-01-01T01:24:45.000Z",
          },
        },
        {
          payloadSchema: ChannelCreatedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "channel",
            aggregateId: "channel-1",
            type: "channel.created",
            payload: {
              channelId: " channel-1 ",
              threadId: "thread-1",
              channelType: "guidance",
              phaseRunId: " phase-run-1 ",
              createdAt: "2026-01-01T01:25:00.000Z",
            },
          },
          expectedPayload: {
            channelId: "channel-1",
            threadId: "thread-1",
            channelType: "guidance",
            phaseRunId: "phase-run-1",
            createdAt: "2026-01-01T01:25:00.000Z",
          },
        },
        {
          payloadSchema: ChannelMessagePostedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "channel",
            aggregateId: "channel-1",
            type: "channel.message-posted",
            payload: {
              channelId: " channel-1 ",
              messageId: " channel-message-1 ",
              sequence: 1,
              fromType: "agent",
              fromId: " thread-2 ",
              fromRole: " reviewer ",
              content: "First note",
              createdAt: "2026-01-01T01:26:00.000Z",
            },
          },
          expectedPayload: {
            channelId: "channel-1",
            messageId: "channel-message-1",
            sequence: 1,
            fromType: "agent",
            fromId: "thread-2",
            fromRole: "reviewer",
            content: "First note",
            createdAt: "2026-01-01T01:26:00.000Z",
          },
        },
        {
          payloadSchema: ChannelMessagesReadPayload,
          event: {
            ...baseEvent,
            aggregateKind: "channel",
            aggregateId: "channel-1",
            type: "channel.messages-read",
            payload: {
              channelId: " channel-1 ",
              threadId: " thread-2 ",
              upToSequence: 4,
              readAt: "2026-01-01T01:26:30.000Z",
            },
          },
          expectedPayload: {
            channelId: "channel-1",
            threadId: "thread-2",
            upToSequence: 4,
            readAt: "2026-01-01T01:26:30.000Z",
          },
        },
        {
          payloadSchema: ChannelConclusionProposedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "channel",
            aggregateId: "channel-1",
            type: "channel.conclusion-proposed",
            payload: {
              channelId: " channel-1 ",
              threadId: " thread-2 ",
              summary: "Consensus reached",
              proposedAt: "2026-01-01T01:27:00.000Z",
            },
          },
          expectedPayload: {
            channelId: "channel-1",
            threadId: "thread-2",
            summary: "Consensus reached",
            proposedAt: "2026-01-01T01:27:00.000Z",
          },
        },
        {
          payloadSchema: ChannelConcludedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "channel",
            aggregateId: "channel-1",
            type: "channel.concluded",
            payload: {
              channelId: " channel-1 ",
              concludedAt: "2026-01-01T01:28:00.000Z",
            },
          },
          expectedPayload: {
            channelId: "channel-1",
            concludedAt: "2026-01-01T01:28:00.000Z",
          },
        },
        {
          payloadSchema: ChannelClosedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "channel",
            aggregateId: "channel-1",
            type: "channel.closed",
            payload: {
              channelId: " channel-1 ",
              closedAt: "2026-01-01T01:29:00.000Z",
            },
          },
          expectedPayload: {
            channelId: "channel-1",
            closedAt: "2026-01-01T01:29:00.000Z",
          },
        },
        {
          payloadSchema: InteractiveRequestOpenedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "request",
            aggregateId: "request-1",
            type: "request.opened",
            payload: {
              requestId: " request-1 ",
              threadId: "thread-1",
              childThreadId: " thread-2 ",
              phaseRunId: " phase-run-1 ",
              requestType: "gate",
              payload: {
                type: "gate",
                gateType: " human-approval ",
                phaseRunId: " phase-run-1 ",
                phaseOutput: "Ready for review",
              },
              createdAt: "2026-01-01T01:30:00.000Z",
            },
          },
          expectedPayload: {
            requestId: "request-1",
            threadId: "thread-1",
            childThreadId: "thread-2",
            phaseRunId: "phase-run-1",
            requestType: "gate",
            payload: {
              type: "gate",
              gateType: "human-approval",
              phaseRunId: "phase-run-1",
              phaseOutput: "Ready for review",
            },
            createdAt: "2026-01-01T01:30:00.000Z",
          },
        },
        {
          payloadSchema: InteractiveRequestResolvedPayload,
          event: {
            ...baseEvent,
            aggregateKind: "request",
            aggregateId: "request-1",
            type: "request.resolved",
            payload: {
              requestId: " request-1 ",
              resolvedWith: { decision: "approve" },
              resolvedAt: "2026-01-01T01:31:00.000Z",
            },
          },
          expectedPayload: {
            requestId: "request-1",
            resolvedWith: { decision: "approve" },
            resolvedAt: "2026-01-01T01:31:00.000Z",
          },
        },
        {
          payloadSchema: InteractiveRequestStalePayload,
          event: {
            ...baseEvent,
            aggregateKind: "request",
            aggregateId: "request-1",
            type: "request.stale",
            payload: {
              requestId: " request-1 ",
              reason: "Superseded",
              staleAt: "2026-01-01T01:32:00.000Z",
            },
          },
          expectedPayload: {
            requestId: "request-1",
            reason: "Superseded",
            staleAt: "2026-01-01T01:32:00.000Z",
          },
        },
      ] as const;

      for (const testCase of cases) {
        const payload = yield* decode(testCase.payloadSchema, testCase.event.payload);
        const { parsed, encoded } = yield* roundTrip(ForgeEvent, testCase.event);

        assert.deepStrictEqual(payload, testCase.expectedPayload);
        assert.deepStrictEqual(parsed.payload, testCase.expectedPayload);
        assert.deepStrictEqual(encoded, {
          ...testCase.event,
          payload: testCase.expectedPayload,
        });
        assert.deepStrictEqual(parsed, yield* decodeForgeEvent(testCase.event));
      }
    }),
);

it.effect("round-trips the spec-defined ForgeReadModel contracts", () =>
  Effect.gen(function* () {
    const input = {
      snapshotSequence: 42,
      projects: [
        {
          projectId: " project-1 ",
          title: " Forge Project ",
          workspaceRoot: " /tmp/forge ",
          defaultModel: {
            provider: "codex",
            model: " gpt-5.4 ",
          },
          scripts: [
            {
              id: " lint ",
              name: " Lint ",
              command: " bun lint ",
              icon: "lint",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-01-01T03:00:00.000Z",
          updatedAt: "2026-01-01T03:00:00.000Z",
          deletedAt: null,
        },
      ],
      sessions: [
        {
          threadId: " thread-1 ",
          projectId: " project-1 ",
          parentThreadId: null,
          phaseRunId: " phase-run-1 ",
          sessionType: "workflow",
          title: " Review Workflow ",
          description: "Workflow session",
          status: "running",
          role: null,
          provider: "codex",
          model: {
            provider: "codex",
            model: " gpt-5.4 ",
          },
          runtimeMode: "full-access",
          workflowId: " workflow-1 ",
          currentPhaseId: " phase-1 ",
          patternId: " pattern-1 ",
          branch: " feat/review ",
          worktreePath: " /tmp/forge/worktree ",
          bootstrapStatus: " queued ",
          childThreadIds: [" child-thread-1 "],
          createdAt: "2026-01-01T03:01:00.000Z",
          updatedAt: "2026-01-01T03:02:00.000Z",
          archivedAt: null,
        },
      ],
      phaseRuns: [
        {
          phaseRunId: " phase-run-1 ",
          threadId: " thread-1 ",
          workflowId: " workflow-1 ",
          phaseId: " phase-1 ",
          phaseName: " Implement ",
          phaseType: "single-agent",
          iteration: 1,
          status: "running",
          startedAt: "2026-01-01T03:01:00.000Z",
          completedAt: null,
        },
      ],
      channels: [
        {
          channelId: " channel-1 ",
          threadId: " thread-1 ",
          channelType: "guidance",
          status: "open",
        },
      ],
      pendingRequests: [
        {
          requestId: " request-1 ",
          threadId: " thread-1 ",
          childThreadId: " child-thread-1 ",
          requestType: "gate",
          status: "pending",
        },
      ],
      workflows: [
        {
          workflowId: " workflow-1 ",
          name: " Review Workflow ",
          description: "Runs review stages",
          builtIn: true,
        },
      ],
      updatedAt: "2026-01-01T03:03:00.000Z",
    } as const;

    const expected = {
      snapshotSequence: 42,
      projects: [
        {
          projectId: "project-1",
          title: "Forge Project",
          workspaceRoot: "/tmp/forge",
          defaultModel: {
            provider: "codex",
            model: "gpt-5.4",
          },
          scripts: [
            {
              id: "lint",
              name: "Lint",
              command: "bun lint",
              icon: "lint",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-01-01T03:00:00.000Z",
          updatedAt: "2026-01-01T03:00:00.000Z",
          deletedAt: null,
        },
      ],
      sessions: [
        {
          threadId: "thread-1",
          projectId: "project-1",
          parentThreadId: null,
          phaseRunId: "phase-run-1",
          sessionType: "workflow",
          title: "Review Workflow",
          description: "Workflow session",
          status: "running",
          role: null,
          provider: "codex",
          model: {
            provider: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          workflowId: "workflow-1",
          currentPhaseId: "phase-1",
          patternId: "pattern-1",
          branch: "feat/review",
          worktreePath: "/tmp/forge/worktree",
          bootstrapStatus: "queued",
          childThreadIds: ["child-thread-1"],
          createdAt: "2026-01-01T03:01:00.000Z",
          updatedAt: "2026-01-01T03:02:00.000Z",
          archivedAt: null,
        },
      ],
      phaseRuns: [
        {
          phaseRunId: "phase-run-1",
          threadId: "thread-1",
          workflowId: "workflow-1",
          phaseId: "phase-1",
          phaseName: "Implement",
          phaseType: "single-agent",
          iteration: 1,
          status: "running",
          startedAt: "2026-01-01T03:01:00.000Z",
          completedAt: null,
        },
      ],
      channels: [
        {
          channelId: "channel-1",
          threadId: "thread-1",
          channelType: "guidance",
          status: "open",
        },
      ],
      pendingRequests: [
        {
          requestId: "request-1",
          threadId: "thread-1",
          childThreadId: "child-thread-1",
          requestType: "gate",
          status: "pending",
        },
      ],
      workflows: [
        {
          workflowId: "workflow-1",
          name: "Review Workflow",
          description: "Runs review stages",
          builtIn: true,
        },
      ],
      updatedAt: "2026-01-01T03:03:00.000Z",
    } as const;

    const { parsed, encoded } = yield* roundTrip(ForgeReadModel, input);

    assert.deepStrictEqual(parsed, expected);
    assert.deepStrictEqual(encoded, expected);
  }),
);

it.effect("round-trips the spec-defined ForgeClientSnapshot contracts", () =>
  Effect.gen(function* () {
    const input = {
      snapshotSequence: 9,
      projects: [
        {
          id: " project-1 ",
          title: " Forge Project ",
          workspaceRoot: " /tmp/forge ",
          defaultModelSelection: {
            provider: "codex",
            model: " gpt-5.4 ",
          },
          scripts: [],
          createdAt: "2026-01-01T03:10:00.000Z",
          updatedAt: "2026-01-01T03:10:00.000Z",
          deletedAt: null,
        },
      ],
      sessions: [
        {
          threadId: " thread-1 ",
          projectId: " project-1 ",
          parentThreadId: null,
          sessionType: "agent",
          title: " Leaf Session ",
          status: "needs-attention",
          role: " reviewer ",
          provider: "claudeAgent",
          model: {
            provider: "claudeAgent",
            model: " claude-opus-4-6 ",
          },
          runtimeMode: "approval-required",
          workflowId: " workflow-1 ",
          currentPhaseId: " phase-1 ",
          patternId: " pattern-1 ",
          branch: " feat/review ",
          bootstrapStatus: null,
          childThreadIds: [],
          createdAt: "2026-01-01T03:11:00.000Z",
          updatedAt: "2026-01-01T03:12:00.000Z",
          archivedAt: null,
        },
      ],
      phaseRuns: [
        {
          phaseRunId: " phase-run-1 ",
          threadId: " thread-1 ",
          phaseName: " Review ",
          phaseType: "human",
          iteration: 2,
          status: "pending",
        },
      ],
      channels: [
        {
          channelId: " channel-1 ",
          threadId: " thread-1 ",
          channelType: "review",
          status: "concluded",
          phaseRunId: " phase-run-1 ",
        },
      ],
      pendingRequests: [
        {
          requestId: " request-1 ",
          threadId: " thread-1 ",
          requestType: "approval",
          status: "resolved",
        },
      ],
      workflows: [
        {
          workflowId: " workflow-1 ",
          name: " Review Workflow ",
          description: "",
          builtIn: false,
        },
      ],
      updatedAt: "2026-01-01T03:13:00.000Z",
    } as const;

    const expected = {
      snapshotSequence: 9,
      projects: [
        {
          id: "project-1",
          title: "Forge Project",
          workspaceRoot: "/tmp/forge",
          defaultModelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          scripts: [],
          createdAt: "2026-01-01T03:10:00.000Z",
          updatedAt: "2026-01-01T03:10:00.000Z",
          deletedAt: null,
        },
      ],
      sessions: [
        {
          threadId: "thread-1",
          projectId: "project-1",
          parentThreadId: null,
          sessionType: "agent",
          title: "Leaf Session",
          status: "needs-attention",
          role: "reviewer",
          provider: "claudeAgent",
          model: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
          },
          runtimeMode: "approval-required",
          workflowId: "workflow-1",
          currentPhaseId: "phase-1",
          patternId: "pattern-1",
          branch: "feat/review",
          bootstrapStatus: null,
          childThreadIds: [],
          createdAt: "2026-01-01T03:11:00.000Z",
          updatedAt: "2026-01-01T03:12:00.000Z",
          archivedAt: null,
        },
      ],
      phaseRuns: [
        {
          phaseRunId: "phase-run-1",
          threadId: "thread-1",
          phaseName: "Review",
          phaseType: "human",
          iteration: 2,
          status: "pending",
        },
      ],
      channels: [
        {
          channelId: "channel-1",
          threadId: "thread-1",
          channelType: "review",
          status: "concluded",
          phaseRunId: "phase-run-1",
        },
      ],
      pendingRequests: [
        {
          requestId: "request-1",
          threadId: "thread-1",
          requestType: "approval",
          status: "resolved",
        },
      ],
      workflows: [
        {
          workflowId: "workflow-1",
          name: "Review Workflow",
          description: "",
          builtIn: false,
        },
      ],
      updatedAt: "2026-01-01T03:13:00.000Z",
    } as const;

    const { parsed, encoded } = yield* roundTrip(ForgeClientSnapshot, input);

    assert.deepStrictEqual(parsed, expected);
    assert.deepStrictEqual(encoded, expected);
  }),
);

it.effect("round-trips workflow push events from the foundation contracts", () =>
  Effect.gen(function* () {
    const cases = [
      {
        schema: WorkflowPhaseEvent,
        input: {
          channel: "workflow.phase",
          threadId: "thread-1",
          phaseRunId: " phase-run-1 ",
          event: "completed",
          phaseInfo: {
            phaseId: " phase-1 ",
            phaseName: " Implement ",
            phaseType: "single-agent",
            iteration: 1,
          },
          outputs: [{ key: " summary ", content: "Done", sourceType: " agent " }],
          timestamp: "2026-01-01T02:00:00.000Z",
        },
        expected: {
          channel: "workflow.phase",
          threadId: "thread-1",
          phaseRunId: "phase-run-1",
          event: "completed",
          phaseInfo: {
            phaseId: "phase-1",
            phaseName: "Implement",
            phaseType: "single-agent",
            iteration: 1,
          },
          outputs: [{ key: "summary", content: "Done", sourceType: "agent" }],
          timestamp: "2026-01-01T02:00:00.000Z",
        },
      },
      {
        schema: WorkflowQualityCheckEvent,
        input: {
          channel: "workflow.quality-check",
          threadId: "thread-1",
          phaseRunId: " phase-run-1 ",
          checkName: " lint ",
          status: "failed",
          output: "1 failure",
          timestamp: "2026-01-01T02:01:00.000Z",
        },
        expected: {
          channel: "workflow.quality-check",
          threadId: "thread-1",
          phaseRunId: "phase-run-1",
          checkName: "lint",
          status: "failed",
          output: "1 failure",
          timestamp: "2026-01-01T02:01:00.000Z",
        },
      },
      {
        schema: WorkflowBootstrapEvent,
        input: {
          channel: "workflow.bootstrap",
          threadId: "thread-1",
          event: "failed",
          error: "Install failed",
          timestamp: "2026-01-01T02:02:00.000Z",
        },
        expected: {
          channel: "workflow.bootstrap",
          threadId: "thread-1",
          event: "failed",
          error: "Install failed",
          timestamp: "2026-01-01T02:02:00.000Z",
        },
      },
      {
        schema: WorkflowGateEvent,
        input: {
          channel: "workflow.gate",
          threadId: "thread-1",
          phaseRunId: " phase-run-1 ",
          gateType: "human-approval",
          status: "waiting-human",
          requestId: " request-1 ",
          timestamp: "2026-01-01T02:03:00.000Z",
        },
        expected: {
          channel: "workflow.gate",
          threadId: "thread-1",
          phaseRunId: "phase-run-1",
          gateType: "human-approval",
          status: "waiting-human",
          requestId: "request-1",
          timestamp: "2026-01-01T02:03:00.000Z",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { parsed, encoded } = yield* roundTrip(testCase.schema, testCase.input);
      const unionParsed = yield* decode(WorkflowPushEvent, testCase.input);

      assert.deepStrictEqual(parsed, testCase.expected);
      assert.deepStrictEqual(encoded, testCase.expected);
      assert.deepStrictEqual(unionParsed, testCase.expected);
    }
  }),
);

it.effect("round-trips channel push events from the foundation contracts", () =>
  Effect.gen(function* () {
    const cases = [
      {
        schema: ChannelMessageEvent,
        input: {
          channel: "channel.message",
          channelId: " channel-1 ",
          threadId: "thread-1",
          message: {
            id: " channel-message-1 ",
            channelId: " channel-1 ",
            sequence: 3,
            fromType: "agent",
            fromId: " thread-2 ",
            fromRole: " reviewer ",
            content: "Needs one more check",
            createdAt: "2026-01-01T02:10:00.000Z",
          },
          timestamp: "2026-01-01T02:10:00.000Z",
        },
        expected: {
          channel: "channel.message",
          channelId: "channel-1",
          threadId: "thread-1",
          message: {
            id: "channel-message-1",
            channelId: "channel-1",
            sequence: 3,
            fromType: "agent",
            fromId: "thread-2",
            fromRole: "reviewer",
            content: "Needs one more check",
            createdAt: "2026-01-01T02:10:00.000Z",
          },
          timestamp: "2026-01-01T02:10:00.000Z",
        },
      },
      {
        schema: ChannelConclusionEvent,
        input: {
          channel: "channel.conclusion",
          channelId: " channel-1 ",
          threadId: "thread-1",
          sessionId: " thread-2 ",
          summary: "Consensus reached",
          allProposed: true,
          timestamp: "2026-01-01T02:11:00.000Z",
        },
        expected: {
          channel: "channel.conclusion",
          channelId: "channel-1",
          threadId: "thread-1",
          sessionId: "thread-2",
          summary: "Consensus reached",
          allProposed: true,
          timestamp: "2026-01-01T02:11:00.000Z",
        },
      },
      {
        schema: ChannelStatusEvent,
        input: {
          channel: "channel.status",
          channelId: " channel-1 ",
          status: "closed",
          timestamp: "2026-01-01T02:12:00.000Z",
        },
        expected: {
          channel: "channel.status",
          channelId: "channel-1",
          status: "closed",
          timestamp: "2026-01-01T02:12:00.000Z",
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { parsed, encoded } = yield* roundTrip(testCase.schema, testCase.input);
      const unionParsed = yield* decode(ChannelPushEvent, testCase.input);

      assert.deepStrictEqual(parsed, testCase.expected);
      assert.deepStrictEqual(encoded, testCase.expected);
      assert.deepStrictEqual(unionParsed, testCase.expected);
    }
  }),
);
