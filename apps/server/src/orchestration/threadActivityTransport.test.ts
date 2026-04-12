import { describe, expect, it } from "vitest";

import {
  ProjectId,
  ThreadId,
  TurnId,
  type ForgeEvent,
  type OrchestrationThreadActivity,
} from "@forgetools/contracts";

import { asEventId } from "../__test__/ids.ts";
import {
  resolveCommandOutputForActivities,
  sanitizeForgeEventForTransport,
  sanitizeReadModelForTransport,
  sanitizeThreadActivityForTransport,
} from "./threadActivityTransport.ts";

describe("threadActivityTransport", () => {
  it("strips final command output from transport activities and keeps summary metadata", () => {
    const activity = makeActivity({
      id: "activity-1",
      kind: "tool.completed",
      payload: {
        itemType: "command_execution",
        itemId: "tool-1",
        data: {
          item: {
            id: "tool-1",
            aggregatedOutput: "line 1\nline 2\n",
          },
        },
      },
    });

    const sanitized = sanitizeThreadActivityForTransport(activity);
    const payload = sanitized.payload as Record<string, unknown>;
    const data = payload.data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;

    expect(item.aggregatedOutput).toBeUndefined();
    expect(payload.outputSummary).toEqual({
      available: true,
      source: "final",
      byteLength: Buffer.byteLength("line 1\nline 2\n", "utf8"),
    });
  });

  it("strips streamed command deltas from transport activities", () => {
    const activity = makeActivity({
      id: "activity-2",
      kind: "tool.output.delta",
      payload: {
        itemId: "tool-2",
        streamKind: "command_output",
        delta: "watch tick\n",
      },
    });

    const sanitized = sanitizeThreadActivityForTransport(activity);
    expect(sanitized.payload).toEqual({
      itemId: "tool-2",
      streamKind: "command_output",
      deltaLength: Buffer.byteLength("watch tick\n", "utf8"),
    });
  });

  it("reconstructs final command output on demand from raw activities", () => {
    const resolved = resolveCommandOutputForActivities(
      [
        makeActivity({
          id: "activity-3",
          kind: "tool.completed",
          payload: {
            itemType: "command_execution",
            itemId: "tool-3",
            data: {
              item: {
                id: "tool-3",
                aggregatedOutput: "done\n",
              },
            },
          },
        }),
      ],
      {
        activityId: asEventId("activity-3"),
      },
    );

    expect(resolved).toEqual({
      toolCallId: "tool-3",
      output: "done\n",
      source: "final",
      omittedLineCount: 0,
    });
  });

  it("reconstructs streamed command output on demand from raw activities", () => {
    const activities = [
      makeActivity({
        id: "activity-start",
        kind: "tool.started",
        payload: {
          itemType: "command_execution",
          itemId: "tool-4",
          data: {
            item: {
              id: "tool-4",
            },
          },
        },
      }),
      makeActivity({
        id: "delta-1",
        kind: "tool.output.delta",
        payload: {
          itemId: "tool-4",
          streamKind: "command_output",
          delta: "tick 1\n",
        },
      }),
      makeActivity({
        id: "delta-2",
        kind: "tool.output.delta",
        payload: {
          itemId: "tool-4",
          streamKind: "command_output",
          delta: "tick 2\n",
        },
      }),
    ];

    const resolved = resolveCommandOutputForActivities(activities, {
      activityId: asEventId("activity-start"),
    });

    expect(resolved).toEqual({
      toolCallId: "tool-4",
      output: "tick 1\ntick 2\n",
      source: "stream",
      omittedLineCount: 0,
    });
  });

  it("returns only the tail of very long command output", () => {
    const output = Array.from({ length: 140 }, (_, index) => `line ${index + 1}`).join("\n");
    const resolved = resolveCommandOutputForActivities(
      [
        makeActivity({
          id: "activity-tail",
          kind: "tool.completed",
          payload: {
            itemType: "command_execution",
            itemId: "tool-tail",
            data: {
              item: {
                id: "tool-tail",
                aggregatedOutput: output,
              },
            },
          },
        }),
      ],
      {
        activityId: asEventId("activity-tail"),
      },
    );

    expect(resolved).toEqual({
      toolCallId: "tool-tail",
      output: Array.from({ length: 100 }, (_, index) => `line ${index + 41}`).join("\n"),
      source: "final",
      omittedLineCount: 40,
    });
  });

  it("sanitizes thread activities in snapshots and appended events", () => {
    const activity = makeActivity({
      id: "activity-5",
      kind: "tool.completed",
      payload: {
        itemType: "command_execution",
        itemId: "tool-5",
        data: {
          item: {
            id: "tool-5",
            aggregatedOutput: "huge output",
          },
        },
      },
    });
    const readModel = sanitizeReadModelForTransport({
      snapshotSequence: 1,
      projects: [],
      threads: [
        {
          id: ThreadId.makeUnsafe("thread-1"),
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          pinnedAt: null,
          archivedAt: null,
          deletedAt: null,
          parentThreadId: null,
          phaseRunId: null,
          workflowId: null,
          currentPhaseId: null,
          discussionId: null,
          role: null,
          forkedFromThreadId: null,
          childThreadIds: [],
          bootstrapStatus: null,
          messages: [],
          proposedPlans: [],
          activities: [activity],
          checkpoints: [],
          agentDiffs: [],
          session: null,
        },
      ],
      phaseRuns: [],
      channels: [],
      pendingRequests: [],
      workflows: [],
      updatedAt: "2026-04-10T00:00:00.000Z",
    });

    const event = sanitizeForgeEventForTransport({
      sequence: 1,
      eventId: asEventId("event-1"),
      aggregateKind: "thread",
      aggregateId: ThreadId.makeUnsafe("thread-1"),
      occurredAt: "2026-04-10T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.activity-appended",
      payload: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity,
      },
    } satisfies Extract<ForgeEvent, { type: "thread.activity-appended" }>);
    const appendedEvent = event as Extract<ForgeEvent, { type: "thread.activity-appended" }>;

    const snapshotThread = readModel.threads[0];
    expect(snapshotThread).toBeDefined();
    const snapshotActivity = snapshotThread!.activities[0];
    expect(snapshotActivity).toBeDefined();
    const snapshotPayload = (
      (snapshotActivity!.payload as Record<string, unknown>).data as Record<string, unknown>
    ).item as Record<string, unknown>;
    const eventPayload = (
      (appendedEvent.payload.activity.payload as Record<string, unknown>).data as Record<
        string,
        unknown
      >
    ).item as Record<string, unknown>;

    expect(snapshotPayload.aggregatedOutput).toBeUndefined();
    expect(eventPayload.aggregatedOutput).toBeUndefined();
  });
});

function makeActivity(
  overrides: Omit<Partial<OrchestrationThreadActivity>, "id" | "kind"> & {
    id: string;
    kind: OrchestrationThreadActivity["kind"];
  },
): OrchestrationThreadActivity {
  return {
    id: asEventId(overrides.id),
    tone: overrides.tone ?? "tool",
    kind: overrides.kind,
    summary: overrides.summary ?? "Command updated",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ?? TurnId.makeUnsafe("turn-1"),
    createdAt: overrides.createdAt ?? "2026-04-10T00:00:00.000Z",
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}
