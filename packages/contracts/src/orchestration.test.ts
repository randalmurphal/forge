import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ChannelClosedPayload,
  ChannelConclusionProposedPayload,
  ChannelCloseCommand,
  ChannelConcludedPayload,
  ChannelConcludeCommand,
  ChannelCreatedPayload,
  ChannelCreateCommand,
  ChannelMessagePostedPayload,
  ChannelMessagesReadPayload,
  ChannelPostMessageCommand,
  ChannelReadMessagesCommand,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ForgeCommand,
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
  ThreadAddDependencyCommand,
  ThreadAddLinkCommand,
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

it.effect("round-trips additive workflow, channel, and request events through ForgeEvent", () =>
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
