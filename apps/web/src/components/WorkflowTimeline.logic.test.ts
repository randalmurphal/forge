import {
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
  resolveWorkflowTimelineOutput,
  type WorkflowTimelineChildSession,
  type WorkflowTimelinePhaseOutputRecord,
} from "./WorkflowTimeline.logic";

function makeWorkflowDefinition(): WorkflowDefinition {
  return {
    id: WorkflowId.makeUnsafe("workflow-1"),
    name: "Build Loop",
    description: "Workflow description",
    builtIn: true,
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
