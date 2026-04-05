import {
  ChannelId,
  ChannelMessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  InteractiveRequestId,
  PhaseRunId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  decideOrchestrationCommand,
  type DecidableOrchestrationCommand,
  type DecidedOrchestrationEvent,
} from "./decider.ts";

const now = "2026-04-05T13:00:00.000Z";
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
  snapshotSequence: 12,
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
    makeThread("thread-parent", "project-a"),
    makeThread("thread-child", "project-a"),
    makeThread("thread-other-project", "project-b"),
  ],
  phaseRuns: [],
  channels: [
    {
      id: ChannelId.makeUnsafe("channel-open"),
      threadId: ThreadId.makeUnsafe("thread-parent"),
      phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
      type: "guidance",
      status: "open",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: ChannelId.makeUnsafe("channel-closed"),
      threadId: ThreadId.makeUnsafe("thread-parent"),
      type: "review",
      status: "closed",
      createdAt: now,
      updatedAt: now,
    },
  ],
  pendingRequests: [
    {
      id: InteractiveRequestId.makeUnsafe("request-pending"),
      threadId: ThreadId.makeUnsafe("thread-parent"),
      childThreadId: ThreadId.makeUnsafe("thread-child"),
      type: "approval",
      status: "pending",
      payload: {
        type: "approval",
        requestType: "apply_patch",
        detail: "Need approval",
        toolName: "apply_patch",
        toolInput: {},
      },
      createdAt: now,
    },
  ],
  workflows: [],
});

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

function expectSingleEvent<TType extends DecidedOrchestrationEvent["type"]>(
  result: DecidedOrchestrationEvent | ReadonlyArray<DecidedOrchestrationEvent>,
  type: TType,
): Extract<DecidedOrchestrationEvent, { type: TType }> {
  expect(Array.isArray(result)).toBe(false);
  const event = result as DecidedOrchestrationEvent;
  expect(event.type).toBe(type);
  return event as Extract<DecidedOrchestrationEvent, { type: TType }>;
}

describe("decider channel commands", () => {
  it("emits channel.created for channel.create", async () => {
    const result = await run({
      type: "channel.create",
      commandId: CommandId.makeUnsafe("cmd-channel-create"),
      channelId: ChannelId.makeUnsafe("channel-new"),
      threadId: ThreadId.makeUnsafe("thread-parent"),
      channelType: "deliberation",
      phaseRunId: PhaseRunId.makeUnsafe("phase-run-2"),
      createdAt: now,
    });

    const event = expectSingleEvent(result, "channel.created");
    expect(event.aggregateKind).toBe("channel");
    expect(event.aggregateId).toBe(ChannelId.makeUnsafe("channel-new"));
    expect(event.payload).toEqual({
      channelId: ChannelId.makeUnsafe("channel-new"),
      threadId: ThreadId.makeUnsafe("thread-parent"),
      channelType: "deliberation",
      phaseRunId: PhaseRunId.makeUnsafe("phase-run-2"),
      createdAt: now,
    });
  });

  it("rejects channel.create when the parent thread is missing", async () => {
    await expect(
      run({
        type: "channel.create",
        commandId: CommandId.makeUnsafe("cmd-channel-create-missing"),
        channelId: ChannelId.makeUnsafe("channel-new"),
        threadId: ThreadId.makeUnsafe("thread-missing"),
        channelType: "guidance",
        createdAt: now,
      }),
    ).rejects.toThrow("does not exist");
  });

  it("emits channel.message-posted with a deterministic sequence", async () => {
    const result = await run({
      type: "channel.post-message",
      commandId: CommandId.makeUnsafe("cmd-channel-post"),
      channelId: ChannelId.makeUnsafe("channel-open"),
      messageId: ChannelMessageId.makeUnsafe("channel-message-1"),
      fromType: "agent",
      fromId: "thread-child",
      fromRole: "reviewer",
      content: "I found a gap in the plan.",
      createdAt: now,
    });

    const event = expectSingleEvent(result, "channel.message-posted");
    expect(event.payload).toEqual({
      channelId: ChannelId.makeUnsafe("channel-open"),
      messageId: ChannelMessageId.makeUnsafe("channel-message-1"),
      sequence: 13,
      fromType: "agent",
      fromId: "thread-child",
      fromRole: "reviewer",
      content: "I found a gap in the plan.",
      createdAt: now,
    });
  });

  it("rejects channel.post-message when the channel is closed", async () => {
    await expect(
      run({
        type: "channel.post-message",
        commandId: CommandId.makeUnsafe("cmd-channel-post-closed"),
        channelId: ChannelId.makeUnsafe("channel-closed"),
        messageId: ChannelMessageId.makeUnsafe("channel-message-closed"),
        fromType: "human",
        fromId: "human",
        content: "Stop here.",
        createdAt: now,
      }),
    ).rejects.toThrow("is not open");
  });

  it("emits channel.conclusion-proposed for channel.conclude", async () => {
    const result = await run({
      type: "channel.conclude",
      commandId: CommandId.makeUnsafe("cmd-channel-conclude"),
      channelId: ChannelId.makeUnsafe("channel-open"),
      threadId: ThreadId.makeUnsafe("thread-child"),
      summary: "Consensus reached.",
      createdAt: now,
    });

    const event = expectSingleEvent(result, "channel.conclusion-proposed");
    expect(event.payload).toEqual({
      channelId: ChannelId.makeUnsafe("channel-open"),
      threadId: ThreadId.makeUnsafe("thread-child"),
      summary: "Consensus reached.",
      proposedAt: now,
    });
  });

  it("emits channel.closed for channel.close", async () => {
    const result = await run({
      type: "channel.close",
      commandId: CommandId.makeUnsafe("cmd-channel-close"),
      channelId: ChannelId.makeUnsafe("channel-open"),
      createdAt: now,
    });

    const event = expectSingleEvent(result, "channel.closed");
    expect(event.payload).toEqual({
      channelId: ChannelId.makeUnsafe("channel-open"),
      closedAt: now,
    });
  });
});

describe("decider interactive request commands", () => {
  it("emits request.opened for request.open", async () => {
    const result = await run({
      type: "request.open",
      commandId: CommandId.makeUnsafe("cmd-request-open"),
      requestId: InteractiveRequestId.makeUnsafe("request-new"),
      threadId: ThreadId.makeUnsafe("thread-parent"),
      childThreadId: ThreadId.makeUnsafe("thread-child"),
      phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
      requestType: "gate",
      payload: {
        type: "gate",
        gateType: "human-approval",
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        phaseOutput: "Ship it?",
      },
      createdAt: now,
    });

    const event = expectSingleEvent(result, "request.opened");
    expect(event.aggregateKind).toBe("request");
    expect(event.aggregateId).toBe(InteractiveRequestId.makeUnsafe("request-new"));
    expect(event.payload).toEqual({
      requestId: InteractiveRequestId.makeUnsafe("request-new"),
      threadId: ThreadId.makeUnsafe("thread-parent"),
      childThreadId: ThreadId.makeUnsafe("thread-child"),
      phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
      requestType: "gate",
      payload: {
        type: "gate",
        gateType: "human-approval",
        phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
        phaseOutput: "Ship it?",
      },
      createdAt: now,
    });
  });

  it("rejects request.open when the child thread is in another project", async () => {
    await expect(
      run({
        type: "request.open",
        commandId: CommandId.makeUnsafe("cmd-request-open-cross-project"),
        requestId: InteractiveRequestId.makeUnsafe("request-cross-project"),
        threadId: ThreadId.makeUnsafe("thread-parent"),
        childThreadId: ThreadId.makeUnsafe("thread-other-project"),
        requestType: "correction-needed",
        payload: {
          type: "correction-needed",
          reason: "Fix the branch assumptions.",
        },
        createdAt: now,
      }),
    ).rejects.toThrow("must belong to the same project");
  });

  it("emits request.resolved for request.resolve", async () => {
    const result = await run({
      type: "request.resolve",
      commandId: CommandId.makeUnsafe("cmd-request-resolve"),
      requestId: InteractiveRequestId.makeUnsafe("request-pending"),
      resolvedWith: {
        decision: "accept",
      },
      createdAt: now,
    });

    const event = expectSingleEvent(result, "request.resolved");
    expect(event.payload).toEqual({
      requestId: InteractiveRequestId.makeUnsafe("request-pending"),
      resolvedWith: {
        decision: "accept",
      },
      resolvedAt: now,
    });
  });

  it("rejects request.resolve when the pending request does not exist", async () => {
    await expect(
      run({
        type: "request.resolve",
        commandId: CommandId.makeUnsafe("cmd-request-resolve-missing"),
        requestId: InteractiveRequestId.makeUnsafe("request-missing"),
        resolvedWith: {
          decision: "accept",
        },
        createdAt: now,
      }),
    ).rejects.toThrow("Pending request");
  });

  it("emits request.stale for request.mark-stale", async () => {
    const result = await run({
      type: "request.mark-stale",
      commandId: CommandId.makeUnsafe("cmd-request-stale"),
      requestId: InteractiveRequestId.makeUnsafe("request-pending"),
      reason: "Provider callback state was lost.",
      createdAt: now,
    });

    const event = expectSingleEvent(result, "request.stale");
    expect(event.payload).toEqual({
      requestId: InteractiveRequestId.makeUnsafe("request-pending"),
      reason: "Provider callback state was lost.",
      staleAt: now,
    });
  });
});
