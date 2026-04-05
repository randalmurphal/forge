import {
  ChannelId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  LinkId,
  PhaseRunId,
  ProjectId,
  ThreadId,
  WorkflowId,
  WorkflowPhaseId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  decideOrchestrationCommand,
  type DecidableOrchestrationCommand,
  type DecidedOrchestrationEvent,
} from "./decider.ts";

const now = "2026-04-05T12:00:00.000Z";
const modelSelection = {
  provider: "codex" as const,
  model: "gpt-5-codex" as const,
};

const makeThread = (threadId: string, projectId: string): OrchestrationThread => ({
  id: ThreadId.makeUnsafe(threadId),
  projectId: ProjectId.makeUnsafe(projectId),
  title: `Thread ${threadId}`,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  parentThreadId: null,
  phaseRunId: null,
  workflowId: null,
  currentPhaseId: null,
  patternId: null,
  role: null,
  childThreadIds: [],
  bootstrapStatus: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
});

const makeReadModel = (): OrchestrationReadModel => ({
  snapshotSequence: 1,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.makeUnsafe("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.makeUnsafe("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    makeThread("thread-1", "project-a"),
    makeThread("thread-2", "project-a"),
    makeThread("thread-3", "project-b"),
  ],
  phaseRuns: [],
  channels: [],
  pendingRequests: [],
  workflows: [],
});

const qualityChecks = [
  {
    check: "lint",
    required: true,
  },
] as const;

const qualityCheckResults = [
  {
    check: "lint",
    passed: true,
    output: "ok",
  },
] as const;

const gateResult = {
  status: "passed" as const,
  qualityCheckResults: [...qualityCheckResults],
  evaluatedAt: now,
};

type SuccessCase = {
  readonly name: string;
  readonly command: DecidableOrchestrationCommand;
  readonly assertResult: (
    result: DecidedOrchestrationEvent | ReadonlyArray<DecidedOrchestrationEvent>,
  ) => void;
};

async function run(
  command: DecidableOrchestrationCommand,
  readModel: OrchestrationReadModel = makeReadModel(),
) {
  return Effect.runPromise(
    decideOrchestrationCommand({
      command,
      readModel,
    }),
  );
}

async function expectInvariant(command: DecidableOrchestrationCommand, message: string) {
  await expect(
    Effect.runPromise(decideOrchestrationCommand({ command, readModel: makeReadModel() })),
  ).rejects.toThrow(message);
}

function expectSingleEvent<TType extends DecidedOrchestrationEvent["type"]>(
  result: DecidedOrchestrationEvent | ReadonlyArray<DecidedOrchestrationEvent>,
  type: TType,
): Extract<DecidedOrchestrationEvent, { type: TType }> {
  expect(Array.isArray(result)).toBe(false);
  const event = result as DecidedOrchestrationEvent;
  expect(event.type).toBe(type);
  return event as Extract<DecidedOrchestrationEvent, { type: TType }>;
}

function expectEventArray(
  result: DecidedOrchestrationEvent | ReadonlyArray<DecidedOrchestrationEvent>,
): ReadonlyArray<DecidedOrchestrationEvent> {
  expect(Array.isArray(result)).toBe(true);
  return result as ReadonlyArray<DecidedOrchestrationEvent>;
}

describe("decider workflow commands", () => {
  const successCases: ReadonlyArray<SuccessCase> = [
    {
      name: "thread.correct emits thread.correction-queued",
      command: {
        type: "thread.correct",
        commandId: CommandId.makeUnsafe("cmd-correct"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        content: "Please tighten the plan.",
        createdAt: now,
      },
      assertResult: (result) => {
        const event = expectSingleEvent(result, "thread.correction-queued");
        expect(event.payload.threadId).toBe(ThreadId.makeUnsafe("thread-1"));
        expect(event.payload.content).toBe("Please tighten the plan.");
        expect(event.payload.channelId).toBeTruthy();
        expect(event.payload.messageId).toBeTruthy();
      },
    },
    {
      name: "thread.start-phase emits thread.phase-started",
      command: {
        type: "thread.start-phase",
        commandId: CommandId.makeUnsafe("cmd-start-phase"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        phaseId: WorkflowPhaseId.makeUnsafe("phase-plan"),
        phaseName: "Plan",
        phaseType: "single-agent",
        iteration: 1,
        createdAt: now,
      },
      assertResult: (result) => {
        const event = expectSingleEvent(result, "thread.phase-started");
        expect(event.payload.threadId).toBe(ThreadId.makeUnsafe("thread-1"));
        expect(event.payload.phaseId).toBe(WorkflowPhaseId.makeUnsafe("phase-plan"));
        expect(event.payload.phaseRunId).toBeTruthy();
      },
    },
    {
      name: "thread.complete-phase emits thread.phase-completed",
      command: {
        type: "thread.complete-phase",
        commandId: CommandId.makeUnsafe("cmd-complete-phase"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        outputs: [
          {
            key: "output",
            content: "done",
            sourceType: "agent",
          },
        ],
        gateResult,
        createdAt: now,
      },
      assertResult: (result) => {
        const event = expectSingleEvent(result, "thread.phase-completed");
        expect(event.payload.phaseRunId).toBe(PhaseRunId.makeUnsafe("phase-run-1"));
        expect(event.payload.outputs).toEqual([
          {
            key: "output",
            content: "done",
            sourceType: "agent",
          },
        ]);
        expect(event.payload.gateResult).toEqual(gateResult);
      },
    },
    {
      name: "thread.fail-phase emits thread.phase-failed",
      command: {
        type: "thread.fail-phase",
        commandId: CommandId.makeUnsafe("cmd-fail-phase"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        error: "phase failed",
        createdAt: now,
      },
      assertResult: (result) => {
        const event = expectSingleEvent(result, "thread.phase-failed");
        expect(event.payload.error).toBe("phase failed");
      },
    },
    {
      name: "thread.skip-phase emits thread.phase-skipped",
      command: {
        type: "thread.skip-phase",
        commandId: CommandId.makeUnsafe("cmd-skip-phase"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        createdAt: now,
      },
      assertResult: (result) => {
        expectSingleEvent(result, "thread.phase-skipped");
      },
    },
    {
      name: "thread.quality-check-start emits thread.quality-check-started",
      command: {
        type: "thread.quality-check-start",
        commandId: CommandId.makeUnsafe("cmd-qc-start"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        checks: [...qualityChecks],
        createdAt: now,
      },
      assertResult: (result) => {
        const event = expectSingleEvent(result, "thread.quality-check-started");
        expect(event.payload.checks).toEqual([...qualityChecks]);
      },
    },
    {
      name: "thread.quality-check-complete emits thread.quality-check-completed",
      command: {
        type: "thread.quality-check-complete",
        commandId: CommandId.makeUnsafe("cmd-qc-complete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        results: [...qualityCheckResults],
        createdAt: now,
      },
      assertResult: (result) => {
        const event = expectSingleEvent(result, "thread.quality-check-completed");
        expect(event.payload.results).toEqual([...qualityCheckResults]);
      },
    },
    {
      name: "thread.bootstrap-started emits thread.bootstrap-started",
      command: {
        type: "thread.bootstrap-started",
        commandId: CommandId.makeUnsafe("cmd-bootstrap-started"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      },
      assertResult: (result) => {
        expectSingleEvent(result, "thread.bootstrap-started");
      },
    },
    {
      name: "thread.bootstrap-completed emits thread.bootstrap-completed",
      command: {
        type: "thread.bootstrap-completed",
        commandId: CommandId.makeUnsafe("cmd-bootstrap-completed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      },
      assertResult: (result) => {
        expectSingleEvent(result, "thread.bootstrap-completed");
      },
    },
    {
      name: "thread.bootstrap-failed emits thread.bootstrap-failed",
      command: {
        type: "thread.bootstrap-failed",
        commandId: CommandId.makeUnsafe("cmd-bootstrap-failed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        error: "bootstrap failed",
        stdout: "bad output",
        command: "bun install",
        createdAt: now,
      },
      assertResult: (result) => {
        const event = expectSingleEvent(result, "thread.bootstrap-failed");
        expect(event.payload.error).toBe("bootstrap failed");
      },
    },
    {
      name: "thread.bootstrap-skipped emits thread.bootstrap-skipped",
      command: {
        type: "thread.bootstrap-skipped",
        commandId: CommandId.makeUnsafe("cmd-bootstrap-skipped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      },
      assertResult: (result) => {
        expectSingleEvent(result, "thread.bootstrap-skipped");
      },
    },
    {
      name: "thread.add-link emits thread.link-added",
      command: {
        type: "thread.add-link",
        commandId: CommandId.makeUnsafe("cmd-add-link"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        linkId: LinkId.makeUnsafe("link-1"),
        linkType: "related",
        linkedThreadId: ThreadId.makeUnsafe("thread-2"),
        createdAt: now,
      },
      assertResult: (result) => {
        const event = expectSingleEvent(result, "thread.link-added");
        expect(event.payload.linkedThreadId).toBe(ThreadId.makeUnsafe("thread-2"));
      },
    },
    {
      name: "thread.remove-link emits thread.link-removed",
      command: {
        type: "thread.remove-link",
        commandId: CommandId.makeUnsafe("cmd-remove-link"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        linkId: LinkId.makeUnsafe("link-1"),
        createdAt: now,
      },
      assertResult: (result) => {
        expectSingleEvent(result, "thread.link-removed");
      },
    },
    {
      name: "thread.promote emits promoted and reciprocal link events",
      command: {
        type: "thread.promote",
        commandId: CommandId.makeUnsafe("cmd-promote"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        targetThreadId: ThreadId.makeUnsafe("thread-promoted"),
        targetWorkflowId: WorkflowId.makeUnsafe("workflow-1"),
        title: "Promoted Workflow",
        description: "Promoted thread",
        createdAt: now,
      },
      assertResult: (result) => {
        const events = expectEventArray(result);
        expect(events.map((event) => event.type)).toEqual([
          "thread.promoted",
          "thread.link-added",
          "thread.link-added",
        ]);
        const promotedEvent = events[0];
        expect(promotedEvent?.type).toBe("thread.promoted");
        if (promotedEvent?.type !== "thread.promoted") {
          throw new Error("Expected first promote event to be thread.promoted.");
        }
        expect(promotedEvent.payload.sourceThreadId).toBe(ThreadId.makeUnsafe("thread-1"));
        expect(promotedEvent.payload.targetThreadId).toBe(ThreadId.makeUnsafe("thread-promoted"));
        const linkTypes = events
          .filter(
            (event): event is Extract<DecidedOrchestrationEvent, { type: "thread.link-added" }> =>
              event.type === "thread.link-added",
          )
          .map((event) => event.payload.linkType)
          .toSorted();
        expect(linkTypes).toEqual(["promoted-from", "promoted-to"]);
      },
    },
    {
      name: "thread.add-dependency emits thread.dependency-added",
      command: {
        type: "thread.add-dependency",
        commandId: CommandId.makeUnsafe("cmd-add-dependency"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        dependsOnThreadId: ThreadId.makeUnsafe("thread-2"),
        createdAt: now,
      },
      assertResult: (result) => {
        expectSingleEvent(result, "thread.dependency-added");
      },
    },
    {
      name: "thread.remove-dependency emits thread.dependency-removed",
      command: {
        type: "thread.remove-dependency",
        commandId: CommandId.makeUnsafe("cmd-remove-dependency"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        dependsOnThreadId: ThreadId.makeUnsafe("thread-2"),
        createdAt: now,
      },
      assertResult: (result) => {
        expectSingleEvent(result, "thread.dependency-removed");
      },
    },
  ];

  it.each(successCases)("$name", async ({ command, assertResult }) => {
    assertResult(await run(command));
  });

  it("reuses an existing guidance channel for repeated thread.correct commands", async () => {
    const readModel: OrchestrationReadModel = {
      ...makeReadModel(),
      channels: [
        {
          id: ChannelId.makeUnsafe("channel-guidance-existing"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          type: "guidance",
          status: "open",
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const result = await run(
      {
        type: "thread.correct",
        commandId: CommandId.makeUnsafe("cmd-correct-existing-channel"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        content: "Please apply the latest correction in the existing channel.",
        createdAt: now,
      },
      readModel,
    );

    const event = expectSingleEvent(result, "thread.correction-queued");
    expect(event.payload.channelId).toBe(ChannelId.makeUnsafe("channel-guidance-existing"));
  });

  it("rejects missing target threads for thread-scoped workflow commands", async () => {
    const commands: ReadonlyArray<DecidableOrchestrationCommand> = [
      {
        type: "thread.correct",
        commandId: CommandId.makeUnsafe("cmd-invalid-correct"),
        threadId: ThreadId.makeUnsafe("missing"),
        content: "nope",
        createdAt: now,
      },
      {
        type: "thread.start-phase",
        commandId: CommandId.makeUnsafe("cmd-invalid-start-phase"),
        threadId: ThreadId.makeUnsafe("missing"),
        phaseId: WorkflowPhaseId.makeUnsafe("phase-plan"),
        phaseName: "Plan",
        phaseType: "single-agent",
        iteration: 1,
        createdAt: now,
      },
      {
        type: "thread.complete-phase",
        commandId: CommandId.makeUnsafe("cmd-invalid-complete-phase"),
        threadId: ThreadId.makeUnsafe("missing"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        createdAt: now,
      },
      {
        type: "thread.fail-phase",
        commandId: CommandId.makeUnsafe("cmd-invalid-fail-phase"),
        threadId: ThreadId.makeUnsafe("missing"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        error: "fail",
        createdAt: now,
      },
      {
        type: "thread.skip-phase",
        commandId: CommandId.makeUnsafe("cmd-invalid-skip-phase"),
        threadId: ThreadId.makeUnsafe("missing"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        createdAt: now,
      },
      {
        type: "thread.quality-check-start",
        commandId: CommandId.makeUnsafe("cmd-invalid-qc-start"),
        threadId: ThreadId.makeUnsafe("missing"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        checks: [...qualityChecks],
        createdAt: now,
      },
      {
        type: "thread.quality-check-complete",
        commandId: CommandId.makeUnsafe("cmd-invalid-qc-complete"),
        threadId: ThreadId.makeUnsafe("missing"),
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        results: [...qualityCheckResults],
        createdAt: now,
      },
      {
        type: "thread.bootstrap-started",
        commandId: CommandId.makeUnsafe("cmd-invalid-bootstrap-started"),
        threadId: ThreadId.makeUnsafe("missing"),
        createdAt: now,
      },
      {
        type: "thread.bootstrap-completed",
        commandId: CommandId.makeUnsafe("cmd-invalid-bootstrap-completed"),
        threadId: ThreadId.makeUnsafe("missing"),
        createdAt: now,
      },
      {
        type: "thread.bootstrap-failed",
        commandId: CommandId.makeUnsafe("cmd-invalid-bootstrap-failed"),
        threadId: ThreadId.makeUnsafe("missing"),
        error: "fail",
        stdout: "stdout",
        command: "bun install",
        createdAt: now,
      },
      {
        type: "thread.bootstrap-skipped",
        commandId: CommandId.makeUnsafe("cmd-invalid-bootstrap-skipped"),
        threadId: ThreadId.makeUnsafe("missing"),
        createdAt: now,
      },
      {
        type: "thread.add-link",
        commandId: CommandId.makeUnsafe("cmd-invalid-add-link"),
        threadId: ThreadId.makeUnsafe("missing"),
        linkId: LinkId.makeUnsafe("link-1"),
        linkType: "related",
        externalId: "ext-1",
        createdAt: now,
      },
      {
        type: "thread.remove-link",
        commandId: CommandId.makeUnsafe("cmd-invalid-remove-link"),
        threadId: ThreadId.makeUnsafe("missing"),
        linkId: LinkId.makeUnsafe("link-1"),
        createdAt: now,
      },
      {
        type: "thread.add-dependency",
        commandId: CommandId.makeUnsafe("cmd-invalid-add-dependency"),
        threadId: ThreadId.makeUnsafe("missing"),
        dependsOnThreadId: ThreadId.makeUnsafe("thread-2"),
        createdAt: now,
      },
      {
        type: "thread.remove-dependency",
        commandId: CommandId.makeUnsafe("cmd-invalid-remove-dependency"),
        threadId: ThreadId.makeUnsafe("missing"),
        dependsOnThreadId: ThreadId.makeUnsafe("thread-2"),
        createdAt: now,
      },
    ];

    for (const command of commands) {
      await expect(run(command)).rejects.toThrow("does not exist");
    }
  });

  it("rejects invalid thread relationships for links, promotion, and dependencies", async () => {
    await expectInvariant(
      {
        type: "thread.add-link",
        commandId: CommandId.makeUnsafe("cmd-invalid-self-link"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        linkId: LinkId.makeUnsafe("link-self"),
        linkType: "related",
        linkedThreadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      },
      "must reference different threads",
    );

    await expectInvariant(
      {
        type: "thread.add-dependency",
        commandId: CommandId.makeUnsafe("cmd-invalid-cross-project-dependency"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        dependsOnThreadId: ThreadId.makeUnsafe("thread-3"),
        createdAt: now,
      },
      "must belong to the same project",
    );

    await expectInvariant(
      {
        type: "thread.remove-dependency",
        commandId: CommandId.makeUnsafe("cmd-invalid-self-remove-dependency"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        dependsOnThreadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      },
      "must reference different threads",
    );

    await expectInvariant(
      {
        type: "thread.promote",
        commandId: CommandId.makeUnsafe("cmd-invalid-existing-target"),
        sourceThreadId: ThreadId.makeUnsafe("thread-1"),
        targetThreadId: ThreadId.makeUnsafe("thread-2"),
        targetWorkflowId: WorkflowId.makeUnsafe("workflow-1"),
        createdAt: now,
      },
      "already exists",
    );
  });
});
