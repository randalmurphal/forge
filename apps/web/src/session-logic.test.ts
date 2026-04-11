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
  deriveBackgroundTrayState,
  PROVIDER_OPTIONS,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  filterTrayOwnedWorkEntries,
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

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Stale pending user-input request: req-user-input-stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

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
        threads: [
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
        threads: [
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

describe("deriveWorkLogEntries", () => {
  it("omits non-command tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("keeps command tool.started entries so running commands are visible", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "command-start",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "command-live-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-live-1",
                command: ["/bin/zsh", "-lc", "sleep 30"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry).toMatchObject({
      id: "command-start",
      activityKind: "tool.started",
      itemType: "command_execution",
      itemStatus: "inProgress",
      toolCallId: "command-live-1",
      command: "/bin/zsh -lc sleep 30",
    });
  });

  it("collapses command tool.started into the later completion entry", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "command-start",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "command-collapse-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-collapse-1",
                command: ["/bin/zsh", "-lc", "sleep 5"],
              },
            },
          },
        }),
        makeActivity({
          id: "command-complete",
          createdAt: "2026-02-23T00:00:07.000Z",
          kind: "tool.completed",
          summary: "Command",
          payload: {
            itemType: "command_execution",
            itemId: "command-collapse-1",
            status: "completed",
            data: {
              item: {
                id: "command-collapse-1",
                command: ["/bin/zsh", "-lc", "sleep 5"],
                aggregatedOutput: "done",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry).toMatchObject({
      id: "command-complete",
      activityKind: "tool.completed",
      itemType: "command_execution",
      itemStatus: "completed",
      toolCallId: "command-collapse-1",
      startedAt: "2026-02-23T00:00:02.000Z",
      output: "done",
    });
  });

  it("collapses command lifecycle entries even when other activities are interleaved", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "command-start",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "command-interleaved-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-interleaved-1",
                command: ["/bin/zsh", "-lc", "sleep 5"],
              },
            },
          },
        }),
        makeActivity({
          id: "read-file",
          createdAt: "2026-02-23T00:00:03.000Z",
          kind: "tool.completed",
          summary: "Read file",
          payload: {
            itemType: "file_read",
            status: "completed",
            data: {
              input: {
                path: "README.md",
              },
            },
          },
        }),
        makeActivity({
          id: "command-complete",
          createdAt: "2026-02-23T00:00:07.000Z",
          kind: "tool.completed",
          summary: "Command",
          payload: {
            itemType: "command_execution",
            itemId: "command-interleaved-1",
            status: "completed",
            data: {
              item: {
                id: "command-interleaved-1",
                command: ["/bin/zsh", "-lc", "sleep 5"],
                aggregatedOutput: "done",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.toolCallId === "command-interleaved-1")).toMatchObject({
      id: "command-complete",
      activityKind: "tool.completed",
      itemStatus: "completed",
      startedAt: "2026-02-23T00:00:02.000Z",
    });
    expect(entries.find((entry) => entry.id === "read-file")?.itemType).toBe("file_read");
  });

  it("omits task start and completion lifecycle entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths from persisted tool diff artifacts", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              { path: "apps/web/src/components/ChatView.tsx" },
              { path: "apps/web/src/session-logic.ts" },
            ],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("keeps historical tool rows across turns in all-turns scope", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-turn-1",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Edited file",
        payload: {
          itemType: "file_change",
          title: "Edit",
          detail: "Updated README",
        },
      }),
      makeActivity({
        id: "tool-turn-2",
        turnId: "turn-2",
        kind: "tool.completed",
        summary: "Edited file",
        payload: {
          itemType: "file_change",
          title: "Edit",
          detail: "Updated README",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries.map((entry) => entry.id)).toEqual(["tool-turn-1", "tool-turn-2"]);
  });

  it("reads an exact tool patch from a persisted inline diff artifact", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool-with-patch",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          inlineDiff: {
            availability: "exact_patch",
            files: [{ path: "apps/web/src/app.tsx", additions: 1, deletions: 0 }],
            additions: 1,
            deletions: 0,
            unifiedDiff: [
              "diff --git a/apps/web/src/app.tsx b/apps/web/src/app.tsx",
              "--- a/apps/web/src/app.tsx",
              "+++ b/apps/web/src/app.tsx",
              "@@ -1 +1,2 @@",
              " export const App = () => null;",
              "+console.log('changed');",
            ].join("\n"),
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toMatchObject({
      availability: "exact_patch",
      additions: 1,
      deletions: 0,
      files: [{ path: "apps/web/src/app.tsx", additions: 1, deletions: 0 }],
    });
  });

  it("does not parse raw payload diffs when no persisted inline diff artifact exists", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool-with-hunk",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [{ path: "apps/server/src/orchestration/projector.test.ts" }],
            },
            diff: [
              "@@ -199,12 +199,12 @@",
              '           diff: "diff --git a/src/app.ts b/src/app.ts\\n+hello\\n",',
              '-          files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],',
              '+          files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],',
            ].join("\n"),
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toBeUndefined();
  });

  it("does not create a diff block for file-change tools without patch or file metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "empty-file-change",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {},
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toBeUndefined();
  });

  it("does not create a tool diff block for non-file-change tools even when their payload contains diff-like text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-with-diff-output",
        kind: "tool.completed",
        summary: "Command execution",
        payload: {
          itemType: "command_execution",
          title: "Command execution",
          data: {
            diff: [
              "diff --git a/apps/web/src/app.tsx b/apps/web/src/app.tsx",
              "--- a/apps/web/src/app.tsx",
              "+++ b/apps/web/src/app.tsx",
              "@@ -1 +1,2 @@",
              " export const App = () => null;",
              "+console.log('changed');",
            ].join("\n"),
            item: {
              command: ["git", "diff", "--", "apps/web/src/app.tsx"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.itemType).toBe("command_execution");
    expect(entry?.inlineDiff).toBeUndefined();
  });

  it("reads persisted exact inline diffs for command rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-with-inline-diff",
        kind: "tool.completed",
        summary: "Command execution",
        payload: {
          itemType: "command_execution",
          title: "Run command",
          inlineDiff: {
            availability: "exact_patch",
            files: [{ path: "src/remove.ts", kind: "deleted", deletions: 1 }],
            deletions: 1,
            unifiedDiff: [
              "diff --git a/src/remove.ts b/src/remove.ts",
              "deleted file mode 100644",
              "--- a/src/remove.ts",
              "+++ /dev/null",
              "@@ -1,1 +0,0 @@",
              "-export const removed = true;",
            ].join("\n"),
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.itemType).toBe("command_execution");
    expect(entry?.changedFiles).toEqual(["src/remove.ts"]);
    expect(entry?.inlineDiff).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "src/remove.ts", kind: "deleted", deletions: 1 }],
      deletions: 1,
    });
  });

  it("reads summary-only persisted inline diffs for command rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-summary-only-diff",
        kind: "tool.completed",
        summary: "Command execution",
        payload: {
          itemType: "command_execution",
          title: "Run command",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "src/new.ts", kind: "renamed" }],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toMatchObject({
      availability: "summary_only",
      files: [{ path: "src/new.ts", kind: "renamed" }],
    });
    expect(entry?.changedFiles).toEqual(["src/new.ts"]);
  });

  it("reads summary-only persisted artifacts without attempting client-side patch reconstruction", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mixed-file-change",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              { path: "diff-render-smoke/tool-created-file.md", kind: "added" },
              { path: "diff-render-smoke/tool-deleted-file.md", kind: "deleted" },
              { path: "apps/web/src/session-logic.ts", kind: "modified" },
            ],
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entry?.inlineDiff).toMatchObject({
      availability: "summary_only",
      files: [
        { path: "diff-render-smoke/tool-created-file.md" },
        { path: "diff-render-smoke/tool-deleted-file.md" },
        { path: "apps/web/src/session-logic.ts" },
      ],
    });
    expect(entry?.inlineDiff?.unifiedDiff).toBeUndefined();
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:03.000Z",
      label: "Tool call completed",
      detail: '{"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("preserves an exact file-change patch when the completion row only has summary metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-change-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          title: "File change",
          detail: "Editing apps/web/src/session-logic.ts",
          inlineDiff: {
            availability: "exact_patch",
            files: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
            unifiedDiff: [
              "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
              "--- a/apps/web/src/session-logic.ts",
              "+++ b/apps/web/src/session-logic.ts",
              "@@ -1 +1,2 @@",
              " export const value = 1;",
              "+export const next = 2;",
            ].join("\n"),
          },
        },
      }),
      makeActivity({
        id: "file-change-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "File change completed",
        payload: {
          itemType: "file_change",
          title: "File change",
          detail: "Updated 1 file",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "file-change-completed",
      inlineDiff: {
        availability: "exact_patch",
        files: [{ path: "apps/web/src/session-logic.ts" }],
      },
    });
  });

  it("preserves an exact command patch when the completion row only has summary metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Command execution",
        payload: {
          itemType: "command_execution",
          itemId: "command-tool-a",
          title: "Run command",
          inlineDiff: {
            availability: "exact_patch",
            files: [{ path: "src/new.ts", kind: "renamed" }],
            unifiedDiff: [
              "diff --git a/src/old.ts b/src/new.ts",
              "rename from src/old.ts",
              "rename to src/new.ts",
              "--- a/src/old.ts",
              "+++ b/src/new.ts",
            ].join("\n"),
          },
        },
      }),
      makeActivity({
        id: "command-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Command completed",
        payload: {
          itemType: "command_execution",
          itemId: "command-tool-a",
          title: "Run command",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "src/new.ts", kind: "renamed" }],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "command-completed",
      inlineDiff: {
        availability: "exact_patch",
        files: [{ path: "src/new.ts", kind: "renamed" }],
      },
    });
  });

  it("collapses file-change lifecycle rows even when file order changes between updates", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-change-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              { path: "apps/web/src/session-logic.ts" },
              { path: "apps/web/src/components/ChatView.tsx" },
            ],
          },
        },
      }),
      makeActivity({
        id: "file-change-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "File change completed",
        payload: {
          itemType: "file_change",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              { path: "apps/web/src/components/ChatView.tsx" },
              { path: "apps/web/src/session-logic.ts" },
            ],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("file-change-completed");
    expect(entries[0]?.changedFiles).toEqual([
      "apps/web/src/session-logic.ts",
      "apps/web/src/components/ChatView.tsx",
    ]);
  });

  it("does not double-count per-file stats when collapsing repeated file-change lifecycle rows", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-change-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          itemId: "tool-a",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              {
                path: "apps/web/src/session-logic.ts",
                additions: 1,
                deletions: 0,
              },
            ],
          },
        },
      }),
      makeActivity({
        id: "file-change-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "File change completed",
        payload: {
          itemType: "file_change",
          itemId: "tool-a",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [
              {
                path: "apps/web/src/session-logic.ts",
                additions: 1,
                deletions: 0,
              },
            ],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.inlineDiff).toMatchObject({
      files: [{ path: "apps/web/src/session-logic.ts", additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
    });
  });

  it("keeps separate file-change tool rows when two different tool ids touch the same files", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-change-tool-a",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          itemId: "tool-a",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "apps/web/src/session-logic.ts" }],
          },
        },
      }),
      makeActivity({
        id: "file-change-tool-b",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "File change",
        payload: {
          itemType: "file_change",
          itemId: "tool-b",
          title: "File change",
          inlineDiff: {
            availability: "summary_only",
            files: [{ path: "apps/web/src/session-logic.ts" }],
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, { scope: "all-turns" });
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.toolCallId)).toEqual(["tool-a", "tool-b"]);
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });

  it("extracts agent enrichments from Claude-shaped payload", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "agent-claude",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
          detail:
            'Agent: {"description":"Find edge cases","subagent_type":"Reviewer","model":"opus","prompt":"Review the auth module"}',
          data: {
            toolName: "Agent",
            input: {
              description: "Find edge cases",
              subagent_type: "Reviewer",
              model: "opus",
              prompt: "Review the auth module for security issues",
            },
          },
          childThreadAttribution: { taskId: "test-task", childProviderThreadId: "test-thread" },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      itemType: "collab_agent_tool_call",
      toolName: "Agent",
      agentDescription: "Find edge cases",
      agentType: "Reviewer",
      agentModel: "opus",
      agentPrompt: "Review the auth module for security issues",
    });
  });

  it("extracts agent enrichments from Codex-shaped payload", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "agent-codex",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "collabAgentToolCall",
          detail: "Refactor the auth module",
          data: {
            item: {
              type: "collabAgentToolCall",
              id: "call_collab_1",
              receiverThreadIds: ["child_thread_1"],
              description: "Refactor the auth module",
              prompt: "Write unit tests for the parser module",
            },
          },
          childThreadAttribution: { taskId: "test-task", childProviderThreadId: "test-thread" },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      itemType: "collab_agent_tool_call",
      toolName: "collabAgentToolCall",
      agentDescription: "Refactor the auth module",
      agentPrompt: "Write unit tests for the parser module",
    });
    // Codex does not provide subagent_type or model
    expect(entry?.agentType).toBeUndefined();
    expect(entry?.agentModel).toBeUndefined();
  });

  it("falls back gracefully when agent enrichment fields are absent", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "agent-minimal",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Task",
          detail: "Task: some detail",
          data: {
            toolName: "Task",
            input: {},
          },
          childThreadAttribution: { taskId: "test-task", childProviderThreadId: "test-thread" },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.itemType).toBe("collab_agent_tool_call");
    expect(entry?.agentDescription).toBeUndefined();
    expect(entry?.agentType).toBeUndefined();
    expect(entry?.agentModel).toBeUndefined();
    expect(entry?.agentPrompt).toBeUndefined();
  });

  it("filters out unattributed collab_agent_tool_call envelope entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      // Should be filtered out: collab_agent_tool_call without attribution
      makeActivity({
        id: "orphaned-started",
        kind: "tool.started",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
        },
      }),
      // Should be filtered out: collab_agent_tool_call without attribution
      makeActivity({
        id: "orphaned-updated",
        kind: "tool.updated",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
        },
      }),
      makeActivity({
        id: "orphaned-completed",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
        },
      }),
      // Should be retained: collab_agent_tool_call WITH attribution
      makeActivity({
        id: "attributed-updated",
        kind: "tool.updated",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
          toolCallId: "call-2",
          childThreadAttribution: { taskId: "task-2", childProviderThreadId: "thread-2" },
        },
      }),
      makeActivity({
        id: "attributed-completed",
        kind: "tool.completed",
        summary: "Subagent task",
        payload: {
          itemType: "collab_agent_tool_call",
          title: "Subagent task",
          toolName: "Agent",
          childThreadAttribution: { taskId: "task-1", childProviderThreadId: "thread-1" },
        },
      }),
      // Should be retained: non-collab_agent_tool_call without attribution
      makeActivity({
        id: "regular-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          toolName: "Bash",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    const ids = entries.map((e) => e.id);

    expect(ids).not.toContain("orphaned-started");
    expect(ids).not.toContain("orphaned-updated");
    expect(ids).not.toContain("orphaned-completed");
    expect(ids).toContain("attributed-updated");
    expect(ids).toContain("attributed-completed");
    expect(ids).toContain("regular-tool");
  });

  it("synthesizes a completed Codex subagent lifecycle entry when only the parent collab item completes", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-collab-complete",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "task-codex-1",
                prompt: "Review the parser",
                model: "gpt-5.4-mini",
                status: "completed",
                receiverThreadIds: ["child-thread-1"],
                agentsStates: {
                  "child-thread-1": {
                    status: "completed",
                  },
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      activityKind: "task.completed",
      itemStatus: "completed",
      childThreadAttribution: {
        taskId: "task-codex-1",
        childProviderThreadId: "child-thread-1",
        label: "Review the parser",
        agentModel: "gpt-5.4-mini",
      },
    });
  });

  it("synthesizes a completed Codex subagent lifecycle entry from the top-level payload status", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-collab-payload-status-complete",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "completed",
            data: {
              item: {
                id: "task-codex-payload-status",
                prompt: "Review tray rendering",
                receiverThreadIds: ["child-thread-2"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry).toMatchObject({
      activityKind: "task.completed",
      itemStatus: "completed",
      childThreadAttribution: {
        taskId: "task-codex-payload-status",
        childProviderThreadId: "child-thread-2",
        label: "Review tray rendering",
      },
    });
  });

  it.each(["errored", "interrupted", "notFound"] as const)(
    "maps Codex fallback agent state %s to failed",
    (status) => {
      const [entry] = deriveWorkLogEntries(
        [
          makeActivity({
            id: `codex-collab-${status}`,
            kind: "tool.completed",
            summary: "Subagent task",
            payload: {
              itemType: "collab_agent_tool_call",
              data: {
                item: {
                  id: `task-${status}`,
                  prompt: "Investigate failures",
                  receiverThreadIds: ["child-thread-1"],
                  agentsStates: {
                    "child-thread-1": {
                      status,
                    },
                  },
                },
              },
            },
          }),
        ],
        undefined,
      );

      expect(entry).toMatchObject({
        activityKind: "task.completed",
        tone: "error",
        itemStatus: "failed",
      });
    },
  );

  it("prefers a terminal parent collab status over a non-terminal child agent state", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-collab-parent-complete-child-pending",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            status: "completed",
            data: {
              item: {
                id: "task-parent-complete-child-pending",
                tool: "spawnAgent",
                status: "completed",
                prompt: "Inspect tray state",
                receiverThreadIds: ["child-thread-3"],
                agentsStates: {
                  "child-thread-3": {
                    status: "pendingInit",
                  },
                },
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry).toMatchObject({
      activityKind: "task.completed",
      itemStatus: "completed",
      childThreadAttribution: {
        taskId: "task-parent-complete-child-pending",
        childProviderThreadId: "child-thread-3",
        label: "Inspect tray state",
      },
    });
  });

  it("prefers a real attributed task.completed over a synthetic Codex fallback completion", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-parent-complete",
          kind: "tool.completed",
          summary: "Subagent task",
          payload: {
            itemType: "collab_agent_tool_call",
            data: {
              item: {
                id: "task-real-complete",
                prompt: "Investigate regressions",
                receiverThreadIds: ["child-thread-1"],
                agentsStates: {
                  "child-thread-1": {
                    status: "completed",
                  },
                },
              },
            },
          },
        }),
        makeActivity({
          id: "real-task-complete",
          kind: "task.completed",
          summary: "Task completed",
          tone: "info",
          payload: {
            taskId: "task-real-complete",
            status: "completed",
            childThreadAttribution: {
              taskId: "task-real-complete",
              childProviderThreadId: "child-thread-1",
            },
          },
        }),
      ],
      undefined,
    );

    const completedEntries = entries.filter((entry) => entry.activityKind === "task.completed");
    expect(completedEntries).toHaveLength(1);
    expect(completedEntries[0]?.id).toBe("real-task-complete");
  });

  it.each(["wait", "sendInput"] as const)(
    "does not synthesize a fallback subagent completion from Codex control tool %s",
    (tool) => {
      const entries = deriveWorkLogEntries(
        [
          makeActivity({
            id: `codex-control-${tool}`,
            kind: "tool.completed",
            summary: "Subagent task",
            payload: {
              itemType: "collab_agent_tool_call",
              data: {
                item: {
                  id: `control-${tool}`,
                  tool,
                  prompt: "This should not become a subagent",
                  receiverThreadIds: ["child-thread-1"],
                  agentsStates: {
                    "child-thread-1": {
                      status: "completed",
                    },
                  },
                },
              },
            },
          }),
        ],
        undefined,
      );

      expect(entries).toEqual([]);
    },
  );

  it("keeps full Claude command output and marks explicit background commands", () => {
    const longOutput = `${"stdout line\n".repeat(80)}stderr line`;
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "claude-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run lint",
                run_in_background: true,
              },
              result: {
                stdout: `${"stdout line\n".repeat(80)}`,
                stderr: "stderr line",
                exit_code: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.output).toBe(longOutput);
    expect(entry?.outputSource).toBe("final");
    expect(entry?.isBackgroundCommand).toBe(true);
  });

  it("keeps full Codex aggregated command output", () => {
    const output = `${"build line\n".repeat(90)}done`;
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              item: {
                id: "codex-command-1",
                command: ["bun", "run", "build"],
                aggregatedOutput: output,
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.output).toBe(output);
    expect(entry?.outputSource).toBe("final");
  });

  it("marks sanitized command payloads as having output without requiring the full text", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "sanitized-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            outputSummary: {
              available: true,
              source: "final",
              byteLength: 2048,
            },
            data: {
              item: {
                id: "sanitized-command-1",
                command: ["bun", "run", "build"],
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.hasOutput).toBe(true);
    expect(entry?.output).toBeUndefined();
    expect(entry?.outputByteLength).toBe(2048);
    expect(entry?.outputSource).toBe("final");
  });

  it("marks Codex unified-exec commands as background from the command source", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "codex-unified-exec",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            itemId: "codex-unified-exec-1",
            data: {
              item: {
                id: "codex-unified-exec-1",
                command: ["/bin/zsh", "-lc", "bun run build --watch"],
                source: "unifiedExecStartup",
                processId: "proc-build-watch",
                aggregatedOutput: "watching...\n",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.isBackgroundCommand).toBe(true);
    expect(entry?.commandSource).toBe("unifiedExecStartup");
    expect(entry?.processId).toBe("proc-build-watch");
  });

  it("only marks commands as background when run_in_background is explicitly true", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "background-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            data: {
              input: {
                command: "bun run build",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "foreground-command",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            data: {
              input: {
                command: "bun run test",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entries.find((entry) => entry.id === "background-command")?.isBackgroundCommand).toBe(
      true,
    );
    expect(
      entries.find((entry) => entry.id === "foreground-command")?.isBackgroundCommand,
    ).toBeUndefined();
  });

  it("marks a Codex command as background when terminal interaction is observed", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "background-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "background-command-1",
            status: "inProgress",
            data: {
              item: {
                id: "background-command-1",
                command: ["/bin/zsh", "-lc", "bun run build --watch"],
                processId: "proc-watch-1",
              },
            },
          },
        }),
        makeActivity({
          id: "background-command-terminal-interaction",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.terminal.interaction",
          summary: "Background terminal waited",
          payload: {
            itemId: "background-command-1",
            processId: "proc-watch-1",
            stdin: "",
          },
        }),
      ],
      undefined,
    );

    expect(entry?.toolCallId).toBe("background-command-1");
    expect(entry?.isBackgroundCommand).toBe(true);
  });

  it("does not mark overlapping commands as background during work-log derivation", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "long-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "command-overlap-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-overlap-1",
                command: ["/bin/zsh", "-lc", "sleep 30"],
              },
            },
          },
        }),
        makeActivity({
          id: "subagent-work",
          createdAt: "2026-04-10T12:00:10.000Z",
          kind: "task.started",
          summary: "Task started",
          tone: "info",
          payload: {
            taskId: "spawned-child",
            childThreadAttribution: {
              taskId: "spawned-child",
              childProviderThreadId: "child-thread-1",
              label: "Inspect parser",
            },
          },
        }),
        makeActivity({
          id: "long-command-complete",
          createdAt: "2026-04-10T12:00:30.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            itemId: "command-overlap-1",
            status: "completed",
            data: {
              item: {
                id: "command-overlap-1",
                command: ["/bin/zsh", "-lc", "sleep 30"],
                aggregatedOutput: "done",
                exitCode: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(
      entries.find((entry) => entry.toolCallId === "command-overlap-1")?.isBackgroundCommand,
    ).toBeUndefined();
  });

  it("keeps a top-level command inline when later work starts after it completes", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "foreground-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "foreground-command-1",
            status: "inProgress",
            data: {
              item: {
                id: "foreground-command-1",
                command: ["/bin/zsh", "-lc", "sleep 1"],
              },
            },
          },
        }),
        makeActivity({
          id: "foreground-command-complete",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            itemId: "foreground-command-1",
            status: "completed",
            data: {
              item: {
                id: "foreground-command-1",
                command: ["/bin/zsh", "-lc", "sleep 1"],
                aggregatedOutput: "done",
                exitCode: 0,
              },
            },
          },
        }),
        makeActivity({
          id: "later-unrelated-work",
          createdAt: "2026-04-10T12:00:03.000Z",
          kind: "tool.completed",
          summary: "Read file",
          payload: {
            itemType: "file_read",
            status: "completed",
            data: {
              input: {
                path: "README.md",
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(
      entries.find((entry) => entry.toolCallId === "foreground-command-1")?.isBackgroundCommand,
    ).toBeUndefined();
  });

  it("falls back to streamed command output when no final output is present", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "stream-before-row",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.output.delta",
          summary: "Command output updated",
          payload: {
            itemId: "command-stream-1",
            streamKind: "command_output",
            delta: "[watch] bundling...\n",
          },
        }),
        makeActivity({
          id: "command-row",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.updated",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            itemId: "command-stream-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-stream-1",
                command: ["bun", "run", "build", "--watch"],
              },
            },
          },
        }),
        makeActivity({
          id: "stream-after-row",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "tool.output.delta",
          summary: "Command output updated",
          payload: {
            itemId: "command-stream-1",
            streamKind: "command_output",
            delta: "[watch] waiting for changes...\n",
          },
        }),
      ],
      undefined,
    );

    expect(entry?.output).toBe("[watch] bundling...\n[watch] waiting for changes...\n");
    expect(entry?.outputSource).toBe("stream");
  });

  it("marks sanitized streamed command output as available when only delta lengths are present", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id: "sanitized-stream-before-row",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.output.delta",
          summary: "Command output updated",
          payload: {
            itemId: "command-stream-sanitized-1",
            streamKind: "command_output",
            deltaLength: 22,
          },
        }),
        makeActivity({
          id: "sanitized-command-row",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "tool.updated",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            itemId: "command-stream-sanitized-1",
            status: "inProgress",
            data: {
              item: {
                id: "command-stream-sanitized-1",
                command: ["bun", "run", "build", "--watch"],
              },
            },
          },
        }),
      ],
      undefined,
    );

    expect(entry?.hasOutput).toBe(true);
    expect(entry?.output).toBeUndefined();
    expect(entry?.outputSource).toBe("stream");
  });

  it("derives transient background tray visibility for running and recently completed background commands", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "background-running",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.updated",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            data: {
              input: {
                command: "bun run build --watch",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "background-completed",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run build",
                run_in_background: true,
              },
              result: {
                output: "done",
                exit_code: 0,
              },
            },
          },
        }),
      ],
      undefined,
    );

    const visibleState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:06.000Z");
    expect(visibleState.commandEntries.map((entry) => entry.id)).toEqual([
      "background-running",
      "background-completed",
    ]);

    const expiredState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:08.500Z");
    expect(expiredState.commandEntries.map((entry) => entry.id)).toEqual(["background-running"]);
  });

  it("does not infer background tray ownership from overlap alone", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "long-command-start",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.started",
          summary: "Command started",
          payload: {
            itemType: "command_execution",
            itemId: "command-overlap-2",
            status: "inProgress",
            data: {
              item: {
                id: "command-overlap-2",
                command: ["/bin/zsh", "-lc", "sleep 30"],
              },
            },
          },
        }),
        makeActivity({
          id: "subagent-start",
          createdAt: "2026-04-10T12:00:05.000Z",
          kind: "task.started",
          summary: "Task started",
          tone: "info",
          payload: {
            taskId: "spawned-child",
            childThreadAttribution: {
              taskId: "spawned-child",
              childProviderThreadId: "child-thread-1",
              label: "Inspect parser",
            },
          },
        }),
      ],
      undefined,
    );

    const trayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:06.500Z");
    expect(trayState.commandEntries.map((entry) => entry.toolCallId)).not.toContain(
      "command-overlap-2",
    );
  });

  it("filters tray-owned background work from the timeline and restores it after TTL expiry", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "background-running",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "tool.updated",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            data: {
              input: {
                command: "bun run build --watch",
                run_in_background: true,
              },
            },
          },
        }),
        makeActivity({
          id: "background-completed",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run build",
                run_in_background: true,
              },
              result: {
                output: "done",
                exit_code: 0,
              },
            },
          },
        }),
        makeActivity({
          id: "foreground-command",
          createdAt: "2026-04-10T12:00:03.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run lint",
              },
            },
          },
        }),
      ],
      undefined,
    );

    const visibleWhileOwned = filterTrayOwnedWorkEntries(
      workEntries,
      deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:06.000Z"),
    );
    expect(visibleWhileOwned.map((entry) => entry.id)).toEqual(["foreground-command"]);

    const visibleAfterTtl = filterTrayOwnedWorkEntries(
      workEntries,
      deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:08.500Z"),
    );
    expect(visibleAfterTtl.map((entry) => entry.id)).toEqual([
      "background-completed",
      "foreground-command",
    ]);
  });

  it("hides mixed-attribution subagent rows by child thread identity instead of raw task id", () => {
    const workEntries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "child-started-before-parent-mapping",
          createdAt: "2026-04-10T12:00:00.000Z",
          kind: "task.started",
          summary: "Task started",
          payload: {
            taskId: "child-thread-1",
            childThreadAttribution: {
              taskId: "child-thread-1",
              childProviderThreadId: "child-thread-1",
            },
          },
        }),
        makeActivity({
          id: "child-progress-after-parent-mapping",
          createdAt: "2026-04-10T12:00:01.000Z",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: "call-collab-1",
            childThreadAttribution: {
              taskId: "call-collab-1",
              childProviderThreadId: "child-thread-1",
              label: "Inspect tray behavior",
            },
          },
        }),
        makeActivity({
          id: "foreground-command",
          createdAt: "2026-04-10T12:00:02.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            data: {
              input: {
                command: "bun run lint",
              },
            },
          },
        }),
      ],
      undefined,
    );

    const backgroundTrayState = deriveBackgroundTrayState(workEntries, "2026-04-10T12:00:03.000Z");

    expect(backgroundTrayState.subagentGroups).toHaveLength(1);
    expect(backgroundTrayState.subagentGroups[0]).toMatchObject({
      groupId: "child-thread-1",
      taskId: "call-collab-1",
      label: "Inspect tray behavior",
      status: "running",
    });

    const visibleEntries = filterTrayOwnedWorkEntries(workEntries, backgroundTrayState);
    expect(visibleEntries.map((entry) => entry.id)).toEqual(["foreground-command"]);
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

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
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
