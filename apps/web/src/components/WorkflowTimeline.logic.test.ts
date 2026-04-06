import {
  type WorkflowBootstrapEvent,
  type WorkflowGateEvent,
  type WorkflowPhaseEvent,
  type WorkflowQualityCheckEvent,
  PhaseRunId,
  ThreadId,
  WorkflowId,
  WorkflowPhaseId,
  type WorkflowDefinition,
} from "@forgetools/contracts";
import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import {
  buildWorkflowTimeline,
  isWorkflowContainerThread,
  parseWorkflowChannelTranscript,
  resolveWorkflowAutoNavigationTarget,
  resolveWorkflowTimelineTransitionState,
  resolveWorkflowTimelineOutput,
  selectLatestWorkflowPhaseEvent,
  type WorkflowTimelineAutoNavigationThread,
  type WorkflowTimelineChildSession,
  type WorkflowTimelinePhaseOutputRecord,
  type WorkflowTimelineRuntimeState,
} from "./WorkflowTimeline.logic";

function makeWorkflowDefinition(): WorkflowDefinition {
  return {
    id: WorkflowId.makeUnsafe("workflow-1"),
    name: "Build Loop",
    description: "Workflow description",
    builtIn: true,
    projectId: null,
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    phases: [
      {
        id: WorkflowPhaseId.makeUnsafe("phase-plan"),
        name: "Plan",
        type: "single-agent",
        agent: {
          prompt: "plan",
          output: {
            type: "schema",
            schema: {
              summary: "string",
              risk: "string",
            },
          },
        },
        gate: {
          after: "auto-continue",
          onFail: "retry",
          maxRetries: 1,
        },
      },
      {
        id: WorkflowPhaseId.makeUnsafe("phase-deliberate"),
        name: "Deliberate",
        type: "multi-agent",
        deliberation: {
          maxTurns: 4,
          participants: [
            {
              role: "advocate",
              agent: { prompt: "advocate", output: { type: "conversation" } },
            },
            {
              role: "interrogator",
              agent: { prompt: "interrogator", output: { type: "conversation" } },
            },
          ],
        },
        gate: {
          after: "auto-continue",
          onFail: "retry",
          maxRetries: 1,
        },
      },
      {
        id: WorkflowPhaseId.makeUnsafe("phase-implement"),
        name: "Implement",
        type: "single-agent",
        agent: {
          prompt: "implement",
          output: { type: "conversation" },
        },
        gate: {
          after: "quality-checks",
          qualityChecks: [{ check: "test", required: true }],
          onFail: "retry",
          maxRetries: 3,
        },
      },
    ],
  };
}

function makeChildSession(
  threadId: string,
  overrides: Partial<WorkflowTimelineChildSession> = {},
): WorkflowTimelineChildSession {
  return {
    threadId: ThreadId.makeUnsafe(threadId),
    title: threadId,
    role: null,
    provider: "codex",
    status: "running",
    updatedAt: "2026-04-06T01:00:00.000Z",
    messages: [],
    ...overrides,
  };
}

function makeWorkflowContainerThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-workflow"),
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    parentThreadId: null,
    phaseRunId: null,
    title: "Workflow",
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    workflowId: WorkflowId.makeUnsafe("workflow-1"),
    currentPhaseId: null,
    role: null,
    childThreadIds: [],
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-06T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-06T00:00:00.000Z",
    latestTurn: null,
    pendingSourceProposedPlan: undefined,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeWorkflowPhaseEvent(overrides: Partial<WorkflowPhaseEvent> = {}): WorkflowPhaseEvent {
  return {
    channel: "workflow.phase",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    phaseRunId: PhaseRunId.makeUnsafe("phase-run-implement"),
    event: "completed",
    phaseInfo: {
      phaseId: WorkflowPhaseId.makeUnsafe("phase-implement"),
      phaseName: "Implement",
      phaseType: "single-agent",
      iteration: 1,
    },
    timestamp: "2026-04-06T02:00:00.000Z",
    ...overrides,
  };
}

function makeWorkflowGateEvent(overrides: Partial<WorkflowGateEvent> = {}): WorkflowGateEvent {
  return {
    channel: "workflow.gate",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    phaseRunId: PhaseRunId.makeUnsafe("phase-run-implement"),
    gateType: "quality-checks",
    status: "evaluating",
    timestamp: "2026-04-06T02:00:10.000Z",
    ...overrides,
  };
}

function makeWorkflowQualityCheckEvent(
  overrides: Partial<WorkflowQualityCheckEvent> = {},
): WorkflowQualityCheckEvent {
  return {
    channel: "workflow.quality-check",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    phaseRunId: PhaseRunId.makeUnsafe("phase-run-implement"),
    checkName: "bun typecheck",
    status: "running",
    timestamp: "2026-04-06T02:00:11.000Z",
    ...overrides,
  };
}

function makeWorkflowBootstrapEvent(
  overrides: Partial<WorkflowBootstrapEvent> = {},
): WorkflowBootstrapEvent {
  return {
    channel: "workflow.bootstrap",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    event: "output",
    data: "Installing packages...\n",
    timestamp: "2026-04-06T02:00:20.000Z",
    ...overrides,
  };
}

function makeRuntimeState(
  overrides: Partial<WorkflowTimelineRuntimeState> = {},
): WorkflowTimelineRuntimeState {
  return {
    phaseEventsByPhaseRunId: {},
    qualityChecksByPhaseRunId: {},
    gateEventsByPhaseRunId: {},
    bootstrapEvents: [],
    latestBootstrapEvent: null,
    ...overrides,
  };
}

describe("parseWorkflowChannelTranscript", () => {
  it("parses bracket-prefixed speaker blocks into chat messages", () => {
    expect(
      parseWorkflowChannelTranscript(
        "[Advocate]\nWe should retry.\n\n[Interrogator]\nWhy not stop?",
      ),
    ).toEqual([
      { speaker: "Advocate", content: "We should retry." },
      { speaker: "Interrogator", content: "Why not stop?" },
    ]);
  });

  it("falls back to a generic transcript speaker when blocks are unstructured", () => {
    expect(parseWorkflowChannelTranscript("No brackets here.")).toEqual([
      { speaker: "Transcript", content: "No brackets here." },
    ]);
  });
});

describe("resolveWorkflowTimelineOutput", () => {
  it("extracts schema summaries from JSON output", () => {
    const output = resolveWorkflowTimelineOutput({
      phase: makeWorkflowDefinition().phases[0] ?? null,
      phaseType: "single-agent",
      phaseOutput: {
        outputKey: "summary",
        content: JSON.stringify({
          summary: "Plan the rollout in two steps.",
          risk: "Tests are slow.",
        }),
        sourceType: "agent",
      },
      childSessions: [],
    });

    expect(output).toEqual({
      kind: "schema",
      summaryMarkdown: "Plan the rollout in two steps.",
      structuredData: {
        summary: "Plan the rollout in two steps.",
        risk: "Tests are slow.",
      },
      rawContent: JSON.stringify({
        summary: "Plan the rollout in two steps.",
        risk: "Tests are slow.",
      }),
    });
  });

  it("keeps raw text as the schema summary when the output is not JSON", () => {
    const output = resolveWorkflowTimelineOutput({
      phase: makeWorkflowDefinition().phases[0] ?? null,
      phaseType: "single-agent",
      phaseOutput: {
        outputKey: "summary",
        content: "Plain text fallback summary",
        sourceType: "agent",
      },
      childSessions: [],
    });

    expect(output).toEqual({
      kind: "schema",
      summaryMarkdown: "Plain text fallback summary",
      structuredData: null,
      rawContent: "Plain text fallback summary",
    });
  });

  it("falls back to the latest assistant message for conversation phases without stored outputs", () => {
    expect(
      resolveWorkflowTimelineOutput({
        phase: makeWorkflowDefinition().phases[2] ?? null,
        phaseType: "single-agent",
        phaseOutput: null,
        childSessions: [
          makeChildSession("child-1", {
            updatedAt: "2026-04-06T04:00:00.000Z",
            messages: [
              {
                id: "message-1" as Thread["messages"][number]["id"],
                role: "assistant",
                text: "Implemented the patch.",
                createdAt: "2026-04-06T04:00:00.000Z",
                streaming: false,
              },
            ],
          }),
        ],
      }),
    ).toEqual({
      kind: "conversation",
      markdown: "Implemented the patch.",
    });
  });

  it("returns an empty output when neither stored output nor assistant transcript is available", () => {
    expect(
      resolveWorkflowTimelineOutput({
        phase: makeWorkflowDefinition().phases[2] ?? null,
        phaseType: "single-agent",
        phaseOutput: null,
        childSessions: [],
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("buildWorkflowTimeline", () => {
  it("builds timeline items from phase runs, outputs, and child sessions", () => {
    const workflow = makeWorkflowDefinition();
    const planPhaseRunId = PhaseRunId.makeUnsafe("phase-run-plan");
    const deliberatePhaseRunId = PhaseRunId.makeUnsafe("phase-run-deliberate");
    const implementPhaseRunId = PhaseRunId.makeUnsafe("phase-run-implement");
    const phaseOutputsByPhaseRunId: Record<string, WorkflowTimelinePhaseOutputRecord | null> = {
      [planPhaseRunId]: {
        outputKey: "summary",
        content: JSON.stringify({ summary: "Plan summary" }),
        sourceType: "agent",
      },
      [deliberatePhaseRunId]: {
        outputKey: "channel",
        content: "[Advocate]\nShip it.\n\n[Interrogator]\nCheck the edge case.",
        sourceType: "channel",
      },
      [implementPhaseRunId]: null,
    };

    const timeline = buildWorkflowTimeline({
      workflow,
      phaseRuns: [
        {
          phaseRunId: planPhaseRunId,
          phaseId: workflow.phases[0]!.id,
          phaseName: workflow.phases[0]!.name,
          phaseType: workflow.phases[0]!.type,
          iteration: 1,
          status: "completed",
          gateResult: null,
          qualityChecks: null,
          startedAt: "2026-04-06T01:00:00.000Z",
          completedAt: "2026-04-06T01:02:00.000Z",
        },
        {
          phaseRunId: deliberatePhaseRunId,
          phaseId: workflow.phases[1]!.id,
          phaseName: workflow.phases[1]!.name,
          phaseType: workflow.phases[1]!.type,
          iteration: 1,
          status: "completed",
          gateResult: null,
          qualityChecks: [{ check: "test", passed: true }],
          startedAt: "2026-04-06T01:03:00.000Z",
          completedAt: "2026-04-06T01:04:00.000Z",
        },
        {
          phaseRunId: implementPhaseRunId,
          phaseId: workflow.phases[2]!.id,
          phaseName: workflow.phases[2]!.name,
          phaseType: workflow.phases[2]!.type,
          iteration: 2,
          status: "running",
          gateResult: null,
          qualityChecks: null,
          startedAt: "2026-04-06T01:05:00.000Z",
          completedAt: null,
        },
      ],
      phaseOutputsByPhaseRunId,
      childSessionsByPhaseRunId: {
        [implementPhaseRunId]: [
          makeChildSession("child-implement", {
            role: "implementer",
            messages: [
              {
                id: "message-live" as Thread["messages"][number]["id"],
                role: "assistant",
                text: "Streaming the active phase output.",
                createdAt: "2026-04-06T01:05:30.000Z",
                streaming: true,
              },
            ],
          }),
        ],
      },
    });

    expect(timeline).toHaveLength(3);
    expect(timeline[0]?.output.kind).toBe("schema");
    expect(timeline[1]?.output).toEqual({
      kind: "channel",
      messages: [
        { speaker: "Advocate", content: "Ship it." },
        { speaker: "Interrogator", content: "Check the edge case." },
      ],
      rawTranscript: "[Advocate]\nShip it.\n\n[Interrogator]\nCheck the edge case.",
    });
    expect(timeline[1]?.qualityChecks).toEqual([{ check: "test", passed: true }]);
    expect(timeline[2]?.isActive).toBe(true);
    expect(timeline[2]?.output).toEqual({
      kind: "conversation",
      markdown: "Streaming the active phase output.",
    });
  });
});

describe("resolveWorkflowTimelineTransitionState", () => {
  it("surfaces a quality-check transition while a gate is evaluating", () => {
    const workflow = makeWorkflowDefinition();
    const runtime = makeRuntimeState({
      phaseEventsByPhaseRunId: {
        [PhaseRunId.makeUnsafe("phase-run-implement")]: makeWorkflowPhaseEvent(),
      },
      gateEventsByPhaseRunId: {
        [PhaseRunId.makeUnsafe("phase-run-implement")]: makeWorkflowGateEvent(),
      },
      qualityChecksByPhaseRunId: {
        [PhaseRunId.makeUnsafe("phase-run-implement")]: [
          makeWorkflowQualityCheckEvent(),
          makeWorkflowQualityCheckEvent({
            checkName: "bun lint",
            status: "passed",
            output: "0 issues",
          }),
        ],
      },
    });

    const transitionState = resolveWorkflowTimelineTransitionState({
      workflow,
      timeline: [],
      runtime,
    });

    expect(transitionState).toEqual({
      kind: "quality-checks",
      anchorPhaseRunId: PhaseRunId.makeUnsafe("phase-run-implement"),
      phaseName: "Implement",
      checks: [
        makeWorkflowQualityCheckEvent(),
        makeWorkflowQualityCheckEvent({
          checkName: "bun lint",
          status: "passed",
          output: "0 issues",
        }),
      ],
    });
  });

  it("surfaces waiting-human transitions before query state catches up", () => {
    const transitionState = resolveWorkflowTimelineTransitionState({
      workflow: makeWorkflowDefinition(),
      timeline: [],
      runtime: makeRuntimeState({
        phaseEventsByPhaseRunId: {
          [PhaseRunId.makeUnsafe("phase-run-implement")]: makeWorkflowPhaseEvent(),
        },
        gateEventsByPhaseRunId: {
          [PhaseRunId.makeUnsafe("phase-run-implement")]: makeWorkflowGateEvent({
            gateType: "human-approval",
            status: "waiting-human",
          }),
        },
      }),
    });

    expect(transitionState).toEqual({
      kind: "waiting-human",
      anchorPhaseRunId: PhaseRunId.makeUnsafe("phase-run-implement"),
      phaseName: "Implement",
    });
  });

  it("surfaces a handoff transition after a phase passes and before the next one starts", () => {
    const workflow = makeWorkflowDefinition();
    const transitionState = resolveWorkflowTimelineTransitionState({
      workflow,
      timeline: [],
      runtime: makeRuntimeState({
        gateEventsByPhaseRunId: {
          [PhaseRunId.makeUnsafe("phase-run-plan")]: makeWorkflowGateEvent({
            phaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
            status: "passed",
            timestamp: "2026-04-06T02:00:15.000Z",
          }),
        },
        phaseEventsByPhaseRunId: {
          [PhaseRunId.makeUnsafe("phase-run-plan")]: makeWorkflowPhaseEvent({
            phaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
            phaseInfo: {
              phaseId: WorkflowPhaseId.makeUnsafe("phase-plan"),
              phaseName: "Plan",
              phaseType: "single-agent",
              iteration: 1,
            },
            timestamp: "2026-04-06T02:00:05.000Z",
          }),
        },
      }),
    });

    expect(transitionState).toEqual({
      kind: "phase-handoff",
      anchorPhaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
      phaseName: "Plan",
      nextPhaseName: "Deliberate",
    });
  });

  it("surfaces bootstrap progress with accumulated output", () => {
    const workflow = makeWorkflowDefinition();
    const bootstrapStarted = makeWorkflowBootstrapEvent({
      event: "started",
      data: undefined,
      timestamp: "2026-04-06T02:00:16.000Z",
    });
    const bootstrapOutput = makeWorkflowBootstrapEvent({
      event: "output",
      data: "Installing packages...\n",
      timestamp: "2026-04-06T02:00:18.000Z",
    });
    const bootstrapFailed = makeWorkflowBootstrapEvent({
      event: "failed",
      data: "bun install failed\n",
      error: "exit code 1",
      timestamp: "2026-04-06T02:00:19.000Z",
    });

    const transitionState = resolveWorkflowTimelineTransitionState({
      workflow,
      timeline: [],
      runtime: makeRuntimeState({
        gateEventsByPhaseRunId: {
          [PhaseRunId.makeUnsafe("phase-run-plan")]: makeWorkflowGateEvent({
            phaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
            status: "passed",
            timestamp: "2026-04-06T02:00:15.000Z",
          }),
        },
        phaseEventsByPhaseRunId: {
          [PhaseRunId.makeUnsafe("phase-run-plan")]: makeWorkflowPhaseEvent({
            phaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
            phaseInfo: {
              phaseId: WorkflowPhaseId.makeUnsafe("phase-plan"),
              phaseName: "Plan",
              phaseType: "single-agent",
              iteration: 1,
            },
            timestamp: "2026-04-06T02:00:05.000Z",
          }),
        },
        bootstrapEvents: [bootstrapStarted, bootstrapOutput, bootstrapFailed],
        latestBootstrapEvent: bootstrapFailed,
      }),
    });

    expect(transitionState).toEqual({
      kind: "bootstrap",
      anchorPhaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
      phaseName: "Plan",
      nextPhaseName: "Deliberate",
      status: "failed",
      output: "Installing packages...\nbun install failed\n",
      error: "exit code 1",
    });
  });

  it("drops stale transitions after a newer phase has started", () => {
    const workflow = makeWorkflowDefinition();
    const transitionState = resolveWorkflowTimelineTransitionState({
      workflow,
      timeline: [],
      runtime: makeRuntimeState({
        gateEventsByPhaseRunId: {
          [PhaseRunId.makeUnsafe("phase-run-plan")]: makeWorkflowGateEvent({
            phaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
            status: "passed",
            timestamp: "2026-04-06T02:00:15.000Z",
          }),
        },
        phaseEventsByPhaseRunId: {
          [PhaseRunId.makeUnsafe("phase-run-deliberate")]: makeWorkflowPhaseEvent({
            phaseRunId: PhaseRunId.makeUnsafe("phase-run-deliberate"),
            event: "started",
            phaseInfo: {
              phaseId: WorkflowPhaseId.makeUnsafe("phase-deliberate"),
              phaseName: "Deliberate",
              phaseType: "multi-agent",
              iteration: 1,
            },
            timestamp: "2026-04-06T02:00:20.000Z",
          }),
        },
      }),
    });

    expect(transitionState).toBeNull();
  });
});

describe("workflow timeline auto-navigation", () => {
  it("navigates to a newly spawned child session once a transition is pending", () => {
    const newChildThread: WorkflowTimelineAutoNavigationThread = {
      threadId: ThreadId.makeUnsafe("child-new"),
      updatedAt: "2026-04-06T02:00:25.000Z",
    };

    const target = resolveWorkflowAutoNavigationTarget({
      transitionState: {
        kind: "phase-handoff",
        anchorPhaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
        phaseName: "Plan",
        nextPhaseName: "Deliberate",
      },
      latestPhaseEvent: null,
      previousChildThreadIds: [ThreadId.makeUnsafe("child-old")],
      childThreads: [
        {
          threadId: ThreadId.makeUnsafe("child-old"),
          updatedAt: "2026-04-06T02:00:10.000Z",
        },
        newChildThread,
      ],
    });

    expect(target).toBe(newChildThread.threadId);
  });

  it("does not navigate when no new child session has appeared", () => {
    expect(
      resolveWorkflowAutoNavigationTarget({
        transitionState: {
          kind: "bootstrap",
          anchorPhaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
          phaseName: "Plan",
          nextPhaseName: "Deliberate",
          status: "running",
          output: "",
          error: null,
        },
        latestPhaseEvent: makeWorkflowPhaseEvent({
          event: "started",
          timestamp: "2026-04-06T02:00:20.000Z",
        }),
        previousChildThreadIds: [ThreadId.makeUnsafe("child-existing")],
        childThreads: [
          {
            threadId: ThreadId.makeUnsafe("child-existing"),
            updatedAt: "2026-04-06T02:00:20.000Z",
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("selectLatestWorkflowPhaseEvent", () => {
  it("returns the newest phase event by timestamp", () => {
    const latestEvent = makeWorkflowPhaseEvent({
      event: "started",
      timestamp: "2026-04-06T02:00:30.000Z",
    });

    expect(
      selectLatestWorkflowPhaseEvent(
        makeRuntimeState({
          phaseEventsByPhaseRunId: {
            [PhaseRunId.makeUnsafe("phase-run-plan")]: makeWorkflowPhaseEvent({
              phaseRunId: PhaseRunId.makeUnsafe("phase-run-plan"),
              phaseInfo: {
                phaseId: WorkflowPhaseId.makeUnsafe("phase-plan"),
                phaseName: "Plan",
                phaseType: "single-agent",
                iteration: 1,
              },
            }),
            [PhaseRunId.makeUnsafe("phase-run-implement")]: latestEvent,
          },
        }),
      ),
    ).toEqual(latestEvent);
  });
});

describe("isWorkflowContainerThread", () => {
  it("identifies top-level workflow container threads", () => {
    expect(isWorkflowContainerThread(makeWorkflowContainerThread())).toBe(true);
    expect(
      isWorkflowContainerThread(
        makeWorkflowContainerThread({
          phaseRunId: PhaseRunId.makeUnsafe("phase-run-child"),
        }),
      ),
    ).toBe(false);
    expect(
      isWorkflowContainerThread(
        makeWorkflowContainerThread({
          workflowId: null,
        }),
      ),
    ).toBe(false);
  });
});
