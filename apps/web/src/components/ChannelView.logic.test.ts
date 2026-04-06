import { ChannelId, ChannelMessageId, ProjectId, ThreadId } from "@forgetools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildChannelViewModel,
  isChannelContainerThread,
  shouldFocusChannelIntervention,
  shouldToggleChannelSplitView,
} from "./ChannelView.logic";
import type { Thread } from "../types";

function makeChildThread(overrides: Partial<Thread> & Pick<Thread, "id" | "title">): Thread {
  const { id, title, ...rest } = overrides;
  return {
    id,
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title,
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      createdAt: "2026-04-06T00:00:00.000Z",
      updatedAt: "2026-04-06T00:00:00.000Z",
    },
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-06T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...rest,
  };
}

describe("buildChannelViewModel", () => {
  it("labels participants by role and assigns stable per-participant tones", () => {
    const advocateThreadId = ThreadId.makeUnsafe("thread-advocate");
    const interrogatorThreadId = ThreadId.makeUnsafe("thread-interrogator");

    const viewModel = buildChannelViewModel({
      channel: {
        id: ChannelId.makeUnsafe("channel-1"),
        threadId: ThreadId.makeUnsafe("thread-parent"),
        type: "deliberation",
        status: "open",
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T00:00:00.000Z",
      },
      messages: [
        {
          id: ChannelMessageId.makeUnsafe("message-1"),
          channelId: ChannelId.makeUnsafe("channel-1"),
          sequence: 1,
          fromType: "agent",
          fromId: advocateThreadId,
          fromRole: "advocate",
          content: "Caching fits the access pattern.",
          createdAt: "2026-04-06T00:00:01.000Z",
        },
        {
          id: ChannelMessageId.makeUnsafe("message-2"),
          channelId: ChannelId.makeUnsafe("channel-1"),
          sequence: 2,
          fromType: "agent",
          fromId: interrogatorThreadId,
          fromRole: "interrogator",
          content: "How do we handle cold starts?",
          createdAt: "2026-04-06T00:00:02.000Z",
        },
      ],
      deliberationState: {
        turnCount: 2,
        participants: [
          {
            id: advocateThreadId,
            role: "advocate",
            type: "agent",
          },
          {
            id: interrogatorThreadId,
            role: "interrogator",
            type: "agent",
          },
        ],
      },
      thread: { title: "Is Redis right?" },
      childThreads: [
        makeChildThread({
          id: advocateThreadId,
          title: "Advocate transcript",
          role: "advocate",
          session: {
            provider: "claudeAgent",
            status: "running",
            orchestrationStatus: "running",
            createdAt: "2026-04-06T00:00:00.000Z",
            updatedAt: "2026-04-06T00:00:00.000Z",
          },
        }),
        makeChildThread({
          id: interrogatorThreadId,
          title: "Interrogator transcript",
          role: "interrogator",
        }),
      ],
    });

    expect(viewModel.headline).toBe("Advocate vs Interrogator");
    expect(viewModel.participants).toEqual([
      expect.objectContaining({
        label: "Advocate",
        roleLabel: "Advocate",
        providerLabel: "Claude",
        threadId: advocateThreadId,
        tone: "sky",
      }),
      expect.objectContaining({
        label: "Interrogator",
        roleLabel: "Interrogator",
        providerLabel: "Codex",
        threadId: interrogatorThreadId,
        tone: "amber",
      }),
    ]);
    expect(viewModel.messages).toEqual([
      expect.objectContaining({
        speakerLabel: "Advocate",
        roleLabel: "Advocate",
        tone: "sky",
      }),
      expect.objectContaining({
        speakerLabel: "Interrogator",
        roleLabel: "Interrogator",
        tone: "amber",
      }),
    ]);
    expect(viewModel.transcriptPanes.map((pane) => pane.threadId)).toEqual([
      advocateThreadId,
      interrogatorThreadId,
    ]);
  });

  it("derives the turn counter from messages when deliberation state is unavailable", () => {
    const threadId = ThreadId.makeUnsafe("thread-advocate");
    const viewModel = buildChannelViewModel({
      channel: null,
      messages: [
        {
          id: ChannelMessageId.makeUnsafe("message-1"),
          channelId: ChannelId.makeUnsafe("channel-1"),
          sequence: 1,
          fromType: "agent",
          fromId: threadId,
          fromRole: "advocate",
          content: "One",
          createdAt: "2026-04-06T00:00:01.000Z",
        },
        {
          id: ChannelMessageId.makeUnsafe("message-2"),
          channelId: ChannelId.makeUnsafe("channel-1"),
          sequence: 2,
          fromType: "system",
          fromId: "system",
          content: "Pause",
          createdAt: "2026-04-06T00:00:02.000Z",
        },
        {
          id: ChannelMessageId.makeUnsafe("message-3"),
          channelId: ChannelId.makeUnsafe("channel-1"),
          sequence: 3,
          fromType: "human",
          fromId: "human",
          content: "Clarify the rollback path.",
          createdAt: "2026-04-06T00:00:03.000Z",
        },
      ],
      deliberationState: null,
      thread: { title: "Fallback channel" },
      childThreads: [
        makeChildThread({ id: threadId, title: "Advocate transcript", role: "advocate" }),
      ],
    });

    expect(viewModel.turnCount).toBe(2);
    expect(viewModel.messages[2]).toEqual(
      expect.objectContaining({
        speakerLabel: "You",
        tone: "human",
      }),
    );
  });

  it("seeds participants and transcript panes from child threads before channel messages exist", () => {
    const advocateThreadId = ThreadId.makeUnsafe("thread-advocate");
    const interrogatorThreadId = ThreadId.makeUnsafe("thread-interrogator");

    const viewModel = buildChannelViewModel({
      channel: {
        id: ChannelId.makeUnsafe("channel-1"),
        threadId: ThreadId.makeUnsafe("thread-parent"),
        type: "deliberation",
        status: "open",
        createdAt: "2026-04-06T00:00:00.000Z",
        updatedAt: "2026-04-06T00:00:00.000Z",
      },
      messages: [],
      deliberationState: null,
      thread: { title: "Evaluate the rollout" },
      childThreads: [
        makeChildThread({
          id: advocateThreadId,
          title: "Advocate transcript",
          role: "advocate",
          session: {
            provider: "claudeAgent",
            status: "running",
            orchestrationStatus: "running",
            createdAt: "2026-04-06T00:00:00.000Z",
            updatedAt: "2026-04-06T00:00:00.000Z",
          },
        }),
        makeChildThread({
          id: interrogatorThreadId,
          title: "Interrogator transcript",
          role: "interrogator",
        }),
      ],
    });

    expect(viewModel.headline).toBe("Advocate vs Interrogator");
    expect(viewModel.participants).toEqual([
      expect.objectContaining({
        label: "Advocate",
        roleLabel: "Advocate",
        providerLabel: "Claude",
        threadId: advocateThreadId,
        tone: "sky",
      }),
      expect.objectContaining({
        label: "Interrogator",
        roleLabel: "Interrogator",
        providerLabel: "Codex",
        threadId: interrogatorThreadId,
        tone: "amber",
      }),
    ]);
    expect(viewModel.transcriptPanes.map((pane) => pane.threadId)).toEqual([
      advocateThreadId,
      interrogatorThreadId,
    ]);
  });
});

describe("ChannelView keyboard helpers", () => {
  it("toggles split view only for the bare d shortcut outside editable targets", () => {
    expect(shouldToggleChannelSplitView({ key: "d" })).toBe(true);
    expect(
      shouldToggleChannelSplitView({
        key: "d",
        target: { tagName: "TEXTAREA" } as unknown as EventTarget,
      }),
    ).toBe(false);
    expect(shouldToggleChannelSplitView({ key: "d", metaKey: true })).toBe(false);
  });

  it("opens the intervention composer only for the bare c shortcut", () => {
    expect(shouldFocusChannelIntervention({ key: "c" })).toBe(true);
    expect(shouldFocusChannelIntervention({ key: "c", ctrlKey: true })).toBe(false);
  });
});

describe("isChannelContainerThread", () => {
  it("matches only top-level patterned container threads", () => {
    expect(
      isChannelContainerThread({
        parentThreadId: null,
        workflowId: null,
        patternId: "interrogate",
        childThreadIds: [ThreadId.makeUnsafe("child-1"), ThreadId.makeUnsafe("child-2")],
      }),
    ).toBe(true);

    expect(
      isChannelContainerThread({
        parentThreadId: ThreadId.makeUnsafe("parent"),
        workflowId: null,
        patternId: "interrogate",
        childThreadIds: [ThreadId.makeUnsafe("child-1")],
      }),
    ).toBe(false);

    expect(
      isChannelContainerThread({
        parentThreadId: null,
        workflowId: null,
        patternId: null,
        childThreadIds: [ThreadId.makeUnsafe("child-1")],
      }),
    ).toBe(false);
  });
});
