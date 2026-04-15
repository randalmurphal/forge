import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@forgetools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveCompletionDividerBeforeEntryId,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  PROVIDER_OPTIONS,
  deriveTimelineEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.makeUnsafe("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.makeUnsafe("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        plansByThreadId: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.makeUnsafe("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.makeUnsafe("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.makeUnsafe("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.makeUnsafe("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        plansByThreadId: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.makeUnsafe("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.makeUnsafe("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.makeUnsafe("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("surfaces agent turn diffs as standalone timeline entries at completion time", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "done",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
      [
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          completedAt: "2026-02-23T00:00:02.000Z",
          provenance: "agent",
          coverage: "complete",
          source: "native_turn_diff",
          files: [{ path: "src/app.ts", additions: 2, deletions: 1 }],
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "turn-diff"]);
    expect(entries[1]).toMatchObject({
      kind: "turn-diff",
      turnDiffSummary: {
        turnId: TurnId.makeUnsafe("turn-1"),
      },
    });
  });

  it("surfaces completed subagents at completion time instead of child activity start time", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-before"),
          role: "assistant",
          text: "before",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("message-after"),
          role: "assistant",
          text: "after",
          createdAt: "2026-02-23T00:00:05.000Z",
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "spawn-agent",
          createdAt: "2026-02-23T00:00:02.000Z",
          label: "Spawn agent",
          tone: "tool",
          itemType: "collab_agent_tool_call",
          receiverThreadIds: ["child-1"],
          agentModel: "gpt-5.4-mini",
          agentPrompt: "Inspect background history",
        },
        {
          id: "child-started",
          createdAt: "2026-02-23T00:00:02.100Z",
          startedAt: "2026-02-23T00:00:02.100Z",
          label: "Task started",
          tone: "info",
          activityKind: "task.started",
          childThreadAttribution: {
            taskId: "task-1",
            childProviderThreadId: "child-1",
          },
        },
        {
          id: "child-work",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Run checks",
          tone: "tool",
          itemType: "command_execution",
          command: "sleep 20",
          childThreadAttribution: {
            taskId: "task-1",
            childProviderThreadId: "child-1",
          },
        },
        {
          id: "child-completed",
          createdAt: "2026-02-23T00:00:04.000Z",
          completedAt: "2026-02-23T00:00:04.000Z",
          label: "Task completed",
          tone: "info",
          activityKind: "task.completed",
          itemStatus: "completed",
          childThreadAttribution: {
            taskId: "task-1",
            childProviderThreadId: "child-1",
          },
        },
      ],
    );

    // Child entries are consumed into subagentGroupMeta on the parent spawn entry.
    // No separate subagent-section entry is created.
    expect(
      entries.map((entry) => ({ id: entry.id, kind: entry.kind, createdAt: entry.createdAt })),
    ).toEqual([
      { id: "message-before", kind: "message", createdAt: "2026-02-23T00:00:01.000Z" },
      { id: "spawn-agent", kind: "work", createdAt: "2026-02-23T00:00:02.000Z" },
      { id: "message-after", kind: "message", createdAt: "2026-02-23T00:00:05.000Z" },
    ]);

    const spawnEntry = entries.find((e) => e.kind === "work" && e.id === "spawn-agent");
    expect(spawnEntry).toBeDefined();
    expect(spawnEntry!.kind).toBe("work");
    const workEntry = (spawnEntry as Extract<(typeof entries)[number], { kind: "work" }>).entry;
    expect(workEntry.subagentGroupMeta).toMatchObject({
      childProviderThreadId: "child-1",
      status: "completed",
      recordedActionCount: 1,
    });
    expect(workEntry.agentModel).toBe("gpt-5.4-mini");
    expect(workEntry.agentPrompt).toBe("Inspect background history");
  });

  it("orders sequenced assistant messages by event order instead of backdated timestamps", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-earlier-visible"),
          role: "assistant",
          text: "visible first",
          createdAt: "2026-02-23T00:00:05.000Z",
          sequence: 10,
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("message-later-visible"),
          role: "assistant",
          text: "visible second",
          createdAt: "2026-02-23T00:00:01.000Z",
          sequence: 11,
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      entries.map((entry) => (entry.kind === "message" ? entry.message.text : entry.kind)),
    ).toEqual(["visible first", "visible second"]);
  });

  it("enriches parent spawn entry with subagent group metadata for sequenced entries", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-response"),
          role: "assistant",
          text: "The child finished.",
          createdAt: "2026-02-23T00:00:03.000Z",
          completedAt: "2026-02-23T00:00:03.000Z",
          sequence: 30,
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "spawn-agent-sequenced",
          createdAt: "2026-02-23T00:00:01.000Z",
          sequence: 10,
          label: "Spawn agent",
          tone: "tool",
          itemType: "collab_agent_tool_call",
          receiverThreadIds: ["child-sequenced"],
          agentModel: "gpt-5.4-mini",
          agentPrompt: "Wait for child completion",
        },
        {
          id: "child-started-sequenced",
          createdAt: "2026-02-23T00:00:01.100Z",
          sequence: 11,
          startedAt: "2026-02-23T00:00:01.100Z",
          label: "Task started",
          tone: "info",
          activityKind: "task.started",
          childThreadAttribution: {
            taskId: "task-sequenced",
            childProviderThreadId: "child-sequenced",
          },
        },
        {
          id: "child-completed-sequenced",
          createdAt: "2026-02-23T00:00:02.000Z",
          sequence: 31,
          completedAt: "2026-02-23T00:00:02.000Z",
          label: "Task completed",
          tone: "info",
          activityKind: "task.completed",
          itemStatus: "completed",
          childThreadAttribution: {
            taskId: "task-sequenced",
            childProviderThreadId: "child-sequenced",
          },
        },
      ],
    );

    // Parent spawn entry stays at its original position; no separate completion entry is created.
    expect(entries.map((entry) => entry.id)).toEqual([
      "spawn-agent-sequenced",
      "assistant-response",
    ]);

    const spawnEntry = entries.find((e) => e.kind === "work" && e.id === "spawn-agent-sequenced");
    expect(spawnEntry).toBeDefined();
    const workEntry = (spawnEntry as Extract<(typeof entries)[number], { kind: "work" }>).entry;
    expect(workEntry.subagentGroupMeta).toMatchObject({
      childProviderThreadId: "child-sequenced",
      status: "completed",
    });
  });

  it("keeps background command completion rows ordered by runtime sequence instead of backfilling", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-after-command"),
          role: "assistant",
          text: "The watcher completed.",
          createdAt: "2026-02-23T00:00:05.000Z",
          completedAt: "2026-02-23T00:00:05.000Z",
          sequence: 40,
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "bg-launch-sequenced",
          createdAt: "2026-02-23T00:00:01.000Z",
          sequence: 10,
          label: "Command started",
          tone: "tool",
          activityKind: "tool.started",
          itemType: "command_execution",
          command: "sleep 20",
          toolCallId: "bg-sequenced-1",
          isBackgroundCommand: true,
          backgroundLifecycleRole: "launch",
          itemStatus: "inProgress",
        },
        {
          id: "bg-complete-sequenced",
          createdAt: "2026-02-23T00:00:02.000Z",
          completedAt: "2026-02-23T00:00:02.000Z",
          sequence: 41,
          label: "Background command completed",
          tone: "tool",
          activityKind: "task.completed",
          itemType: "command_execution",
          command: "sleep 20",
          toolCallId: "bg-sequenced-1",
          isBackgroundCommand: true,
          backgroundLifecycleRole: "completion",
          itemStatus: "completed",
        },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "bg-launch-sequenced",
      "assistant-after-command",
      "bg-complete-sequenced",
    ]);
  });

  it("keeps buffered assistant chunks interleaved with tool rows by runtime sequence", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-buffered-before-command"),
          role: "assistant",
          text: "before tool",
          createdAt: "2026-02-23T00:00:01.000Z",
          completedAt: "2026-02-23T00:00:01.000Z",
          sequence: 10,
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-buffered-after-command"),
          role: "assistant",
          text: "after tool",
          createdAt: "2026-02-23T00:00:03.000Z",
          completedAt: "2026-02-23T00:00:03.000Z",
          sequence: 12,
          streaming: false,
        },
      ],
      [],
      [
        {
          id: "bg-launch-after-buffered-text",
          createdAt: "2026-02-23T00:00:03.000Z",
          sequence: 11,
          label: "Command started",
          tone: "tool",
          activityKind: "tool.started",
          itemType: "command_execution",
          command: "npm run watch",
          toolCallId: "bg-after-buffered-text",
          isBackgroundCommand: true,
          backgroundLifecycleRole: "launch",
          itemStatus: "inProgress",
        },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual([
      "assistant-buffered-before-command",
      "bg-launch-after-buffered-text",
      "assistant-buffered-after-command",
    ]);
  });

  it("anchors the completion divider to latestTurn.assistantMessageId before timestamp fallback", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        assistantMessageId: MessageId.makeUnsafe("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe("assistant-final");
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("advertises Claude as available while keeping Cursor as a placeholder", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "codex", label: "Codex", available: true },
      { value: "claudeAgent", label: "Claude", available: true },
      { value: "cursor", label: "Cursor", available: false },
    ]);
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: false,
    });
  });
});
