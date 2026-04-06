import type {
  ChannelPushEvent,
  WorkflowBootstrapEvent,
  WorkflowGateEvent,
  WorkflowPhaseEvent,
  WorkflowQualityCheckEvent,
} from "@forgetools/contracts";
import {
  ChannelId,
  ChannelMessageId,
  PhaseRunId,
  ThreadId,
  WorkflowPhaseId,
} from "@forgetools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workflowTimelineQueryKeys } from "./components/WorkflowTimeline.logic";
import { routeChannelPushEvent, routeWorkflowPushEvent } from "./pushEventRouter";

type ChannelMessagePushEvent = Extract<ChannelPushEvent, { channel: "channel.message" }>;

function makeWorkflowPhaseEvent(overrides: Partial<WorkflowPhaseEvent> = {}): WorkflowPhaseEvent {
  return {
    channel: "workflow.phase",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
    event: "completed",
    phaseInfo: {
      phaseId: WorkflowPhaseId.makeUnsafe("workflow-phase-1"),
      phaseName: "Implement",
      phaseType: "single-agent",
      iteration: 1,
    },
    outputs: [
      {
        key: "output",
        content: "phase output",
        sourceType: "conversation",
      },
    ],
    timestamp: "2026-04-06T00:00:20.000Z",
    ...overrides,
  };
}

function makeWorkflowQualityCheckEvent(
  overrides: Partial<WorkflowQualityCheckEvent> = {},
): WorkflowQualityCheckEvent {
  return {
    channel: "workflow.quality-check",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
    checkName: "lint",
    status: "failed",
    output: "Expected semicolon",
    timestamp: "2026-04-06T00:00:21.000Z",
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
    data: "Installing dependencies",
    timestamp: "2026-04-06T00:00:22.000Z",
    ...overrides,
  };
}

function makeWorkflowGateEvent(overrides: Partial<WorkflowGateEvent> = {}): WorkflowGateEvent {
  return {
    channel: "workflow.gate",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
    gateType: "human-approval",
    status: "waiting-human",
    requestId: "interactive-request-1" as WorkflowGateEvent["requestId"],
    timestamp: "2026-04-06T00:00:23.000Z",
    ...overrides,
  };
}

function makeChannelMessageEvent(
  overrides: Partial<ChannelMessagePushEvent> = {},
): ChannelMessagePushEvent {
  const baseEvent: ChannelMessagePushEvent = {
    channel: "channel.message",
    channelId: ChannelId.makeUnsafe("channel-1"),
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    message: {
      id: ChannelMessageId.makeUnsafe("channel-message-1"),
      channelId: ChannelId.makeUnsafe("channel-1"),
      sequence: 1,
      fromType: "agent",
      fromId: ThreadId.makeUnsafe("participant-1"),
      fromRole: "advocate",
      content: "message content",
      createdAt: "2026-04-06T00:00:24.000Z",
    },
    timestamp: "2026-04-06T00:00:24.000Z",
  };

  return {
    ...baseEvent,
    ...overrides,
  };
}

describe("pushEventRouter", () => {
  const invalidateQueries = vi.fn().mockResolvedValue(undefined);
  const applyWorkflowPushEvent = vi.fn();
  const applyChannelPushEvent = vi.fn();
  const onDecodeFailure = vi.fn();

  beforeEach(() => {
    invalidateQueries.mockClear();
    applyWorkflowPushEvent.mockClear();
    applyChannelPushEvent.mockClear();
    onDecodeFailure.mockClear();
  });

  it("routes workflow phase events into workflow state and invalidates phase data", () => {
    const event = makeWorkflowPhaseEvent();

    const accepted = routeWorkflowPushEvent(event, {
      queryClient: { invalidateQueries },
      workflowStore: { applyWorkflowPushEvent },
      onDecodeFailure,
    });

    expect(accepted).toBe(true);
    expect(applyWorkflowPushEvent).toHaveBeenCalledWith(event);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: workflowTimelineQueryKeys.phaseRuns(event.threadId),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: workflowTimelineQueryKeys.phaseOutputPrefix(event.phaseRunId),
    });
  });

  it("routes workflow quality-check events and invalidates phase runs once checks finish", () => {
    const event = makeWorkflowQualityCheckEvent();

    const accepted = routeWorkflowPushEvent(event, {
      queryClient: { invalidateQueries },
      workflowStore: { applyWorkflowPushEvent },
      onDecodeFailure,
    });

    expect(accepted).toBe(true);
    expect(applyWorkflowPushEvent).toHaveBeenCalledWith(event);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: workflowTimelineQueryKeys.phaseRuns(event.threadId),
    });
  });

  it("keeps running quality-check events in store state without invalidating queries", () => {
    const event = makeWorkflowQualityCheckEvent({ status: "running" });

    const accepted = routeWorkflowPushEvent(event, {
      queryClient: { invalidateQueries },
      workflowStore: { applyWorkflowPushEvent },
      onDecodeFailure,
    });

    expect(accepted).toBe(true);
    expect(applyWorkflowPushEvent).toHaveBeenCalledWith(event);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("routes workflow bootstrap events without invalidating timeline queries", () => {
    const event = makeWorkflowBootstrapEvent();

    const accepted = routeWorkflowPushEvent(event, {
      queryClient: { invalidateQueries },
      workflowStore: { applyWorkflowPushEvent },
      onDecodeFailure,
    });

    expect(accepted).toBe(true);
    expect(applyWorkflowPushEvent).toHaveBeenCalledWith(event);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("routes workflow gate events into workflow state and invalidates phase runs", () => {
    const event = makeWorkflowGateEvent();

    const accepted = routeWorkflowPushEvent(event, {
      queryClient: { invalidateQueries },
      workflowStore: { applyWorkflowPushEvent },
      onDecodeFailure,
    });

    expect(accepted).toBe(true);
    expect(applyWorkflowPushEvent).toHaveBeenCalledWith(event);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: workflowTimelineQueryKeys.phaseRuns(event.threadId),
    });
  });

  it("routes channel message events into the channel store", () => {
    const event = makeChannelMessageEvent();

    const accepted = routeChannelPushEvent(event, {
      queryClient: { invalidateQueries },
      channelStore: { applyChannelPushEvent },
      onDecodeFailure,
    });

    expect(accepted).toBe(true);
    expect(applyChannelPushEvent).toHaveBeenCalledWith(event);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads without updating stores", () => {
    const accepted = routeWorkflowPushEvent(
      {
        channel: "workflow.phase",
        threadId: "thread-workflow",
      },
      {
        queryClient: { invalidateQueries },
        workflowStore: { applyWorkflowPushEvent },
        onDecodeFailure,
      },
    );

    expect(accepted).toBe(false);
    expect(applyWorkflowPushEvent).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(onDecodeFailure).toHaveBeenCalledTimes(1);
    expect(onDecodeFailure.mock.calls[0]?.[0]).toMatchObject({
      kind: "workflow",
    });
  });

  it("rejects malformed channel payloads without updating the channel store", () => {
    const accepted = routeChannelPushEvent(
      {
        channel: "channel.message",
        channelId: "channel-1",
      },
      {
        queryClient: { invalidateQueries },
        channelStore: { applyChannelPushEvent },
        onDecodeFailure,
      },
    );

    expect(accepted).toBe(false);
    expect(applyChannelPushEvent).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(onDecodeFailure).toHaveBeenCalledTimes(1);
    expect(onDecodeFailure.mock.calls[0]?.[0]).toMatchObject({
      kind: "channel",
    });
  });
});
