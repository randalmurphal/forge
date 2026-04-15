import { MessageId, ProjectId, ThreadId, TurnId, WorkflowId } from "@forgetools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import type { Thread, ThreadSessionSlice } from "../types";

import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildLocalDraftThread,
  buildExpiredTerminalContextToastCopy,
  buildTemporaryWorktreeBranchName,
  createLocalDispatchSnapshot,
  deriveAssistantMessageIdByTurnId,
  deriveSettledTurnDiffSummaryByAssistantMessageId,
  deriveComposerSendState,
  hasServerAcknowledgedLocalDispatch,
  prepareWorktree,
  reconcileMountedTerminalThreadIds,
  waitForServerThreadMatch,
  waitForStartedServerThread,
} from "./ChatView.logic";

describe("buildLocalDraftThread", () => {
  it("projects workflow selection from the draft thread", () => {
    const workflowId = WorkflowId.makeUnsafe("workflow-build-loop");
    const thread = buildLocalDraftThread(
      ThreadId.makeUnsafe("draft-thread"),
      {
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-04-06T00:00:00.000Z",
        runtimeMode: "full-access",
        interactionMode: "default",
        workflowId,
        discussionId: null,
        discussionRoleModels: null,
        branch: null,
        worktreePath: null,
        worktreeBranchName: null,
        envMode: "local",
      },
      {
        provider: "codex",
        model: "gpt-5.4",
      },
    );

    expect(thread.workflowId).toBe(workflowId);
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("buildTemporaryWorktreeBranchName", () => {
  it("uses the Forge worktree branch namespace with an 8-hex suffix", () => {
    expect(buildTemporaryWorktreeBranchName()).toMatch(/^forge\/[0-9a-f]{8}$/);
  });

  it("uses a custom prefix when provided", () => {
    expect(buildTemporaryWorktreeBranchName("myteam")).toMatch(/^myteam\/[0-9a-f]{8}$/);
  });

  it("does not use the default forge prefix when a custom prefix is provided", () => {
    expect(buildTemporaryWorktreeBranchName("myteam")).not.toMatch(/^forge\//);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps previously mounted open threads and adds the active open thread", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-hidden"),
          ThreadId.makeUnsafe("thread-stale"),
        ],
        openThreadIds: [ThreadId.makeUnsafe("thread-hidden"), ThreadId.makeUnsafe("thread-active")],
        activeThreadId: ThreadId.makeUnsafe("thread-active"),
        activeThreadTerminalOpen: true,
      }),
    ).toEqual([ThreadId.makeUnsafe("thread-hidden"), ThreadId.makeUnsafe("thread-active")]);
  });

  it("drops mounted threads once their terminal drawer is no longer open", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.makeUnsafe("thread-closed")],
        openThreadIds: [],
        activeThreadId: ThreadId.makeUnsafe("thread-closed"),
        activeThreadTerminalOpen: false,
      }),
    ).toEqual([]);
  });

  it("keeps only the most recently active hidden terminal threads", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
        ],
        openThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
          ThreadId.makeUnsafe("thread-4"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-4"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });

  it("moves the active thread to the end so it is treated as most recently used", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-a"),
          ThreadId.makeUnsafe("thread-b"),
          ThreadId.makeUnsafe("thread-c"),
        ],
        openThreadIds: [
          ThreadId.makeUnsafe("thread-a"),
          ThreadId.makeUnsafe("thread-b"),
          ThreadId.makeUnsafe("thread-c"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-a"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-b"),
      ThreadId.makeUnsafe("thread-c"),
      ThreadId.makeUnsafe("thread-a"),
    ]);
  });

  it("defaults to the hidden mounted terminal cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => ThreadId.makeUnsafe(`thread-${index + 1}`),
    );

    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("deriveAssistantMessageIdByTurnId", () => {
  it("tracks the latest assistant message id for each turn", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const byTurnId = deriveAssistantMessageIdByTurnId([
      {
        id: MessageId.makeUnsafe("assistant-early"),
        role: "assistant",
        turnId,
      },
      {
        id: MessageId.makeUnsafe("user-1"),
        role: "user",
        turnId: null,
      },
      {
        id: MessageId.makeUnsafe("assistant-late"),
        role: "assistant",
        turnId,
      },
    ]);

    expect(byTurnId.get(turnId)).toBe(MessageId.makeUnsafe("assistant-late"));
  });
});

describe("deriveSettledTurnDiffSummaryByAssistantMessageId", () => {
  it("prefers the authoritative assistant message id for each turn", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const authoritativeMessageId = MessageId.makeUnsafe("assistant-real");
    const byMessageId = deriveSettledTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: [
        {
          turnId,
          completedAt: "2026-04-09T00:00:02.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: "checkpoint-1" as never,
          assistantMessageId: MessageId.makeUnsafe("assistant-stale"),
          files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
        },
      ],
      assistantMessageIdByTurnId: new Map([[turnId, authoritativeMessageId]]),
    });

    expect([...byMessageId.keys()]).toEqual([authoritativeMessageId]);
  });
});

const makeThread = (input?: {
  id?: ThreadId;
  childThreadIds?: ThreadId[];
  latestTurn?: {
    turnId: TurnId;
    state: "running" | "completed";
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}): Thread => ({
  id: input?.id ?? ThreadId.makeUnsafe("thread-1"),
  codexThreadId: null,
  projectId: ProjectId.makeUnsafe("project-1"),
  forkedFromThreadId: null,
  title: "Thread",
  modelSelection: { provider: "codex" as const, model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  messages: [],
  createdAt: "2026-03-29T00:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  updatedAt: "2026-03-29T00:00:00.000Z",
  branch: null,
  worktreePath: null,
  childThreadIds: input?.childThreadIds ?? [],
  activities: [],
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useStore.setState((state) => ({
    ...state,
    projects: [],
    threads: [],
    bootstrapComplete: true,
  }));
});

describe("waitForStartedServerThread", () => {
  it("waits for an arbitrary server thread predicate", async () => {
    const threadId = ThreadId.makeUnsafe("thread-materialized");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));

    const promise = waitForServerThreadMatch(
      threadId,
      (thread) => (thread.childThreadIds?.length ?? 0) === 2,
      500,
    );

    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          id: threadId,
          childThreadIds: [
            ThreadId.makeUnsafe("thread-child-1"),
            ThreadId.makeUnsafe("thread-child-2"),
          ],
        }),
      ],
    }));

    await expect(promise).resolves.toBe(true);
  });

  it("resolves immediately when the thread is already started", async () => {
    const threadId = ThreadId.makeUnsafe("thread-started");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
      threadSessionById: {
        ...state.threadSessionById,
        [threadId]: {
          session: null,
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-started"),
            state: "running",
            requestedAt: "2026-03-29T00:00:01.000Z",
            startedAt: "2026-03-29T00:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          error: null,
        },
      },
    }));

    await expect(waitForStartedServerThread(threadId)).resolves.toBe(true);
  });

  it("waits for the thread to start via subscription updates", async () => {
    const threadId = ThreadId.makeUnsafe("thread-wait");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));

    const promise = waitForStartedServerThread(threadId, 500);

    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
      threadSessionById: {
        ...state.threadSessionById,
        [threadId]: {
          session: null,
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-started"),
            state: "running",
            requestedAt: "2026-03-29T00:00:01.000Z",
            startedAt: "2026-03-29T00:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          error: null,
        },
      },
    }));

    await expect(promise).resolves.toBe(true);
  });

  it("handles the thread starting between the initial read and subscription setup", async () => {
    const threadId = ThreadId.makeUnsafe("thread-race");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));

    const originalSubscribe = useStore.subscribe.bind(useStore);
    let raced = false;
    vi.spyOn(useStore, "subscribe").mockImplementation((listener) => {
      if (!raced) {
        raced = true;
        useStore.setState((state) => ({
          ...state,
          threads: [makeThread({ id: threadId })],
          threadSessionById: {
            ...state.threadSessionById,
            [threadId]: {
              session: null,
              latestTurn: {
                turnId: TurnId.makeUnsafe("turn-race"),
                state: "running",
                requestedAt: "2026-03-29T00:00:01.000Z",
                startedAt: "2026-03-29T00:00:01.000Z",
                completedAt: null,
                assistantMessageId: null,
              },
              error: null,
            },
          },
        }));
      }
      return originalSubscribe(listener);
    });

    await expect(waitForStartedServerThread(threadId, 500)).resolves.toBe(true);
  });

  it("returns false after the timeout when the thread never starts", async () => {
    vi.useFakeTimers();

    const threadId = ThreadId.makeUnsafe("thread-timeout");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));
    const promise = waitForStartedServerThread(threadId, 500);

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const projectId = ProjectId.makeUnsafe("project-1");
  const previousLatestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: "2026-03-29T00:00:01.000Z",
    completedAt: "2026-03-29T00:00:10.000Z",
    assistantMessageId: null,
  };

  const previousSession = {
    provider: "codex" as const,
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:10.000Z",
    orchestrationStatus: "idle" as const,
  };

  it("does not clear local dispatch before server state changes", () => {
    const dispatchThread: Thread = {
      id: ThreadId.makeUnsafe("thread-1"),
      codexThreadId: null,
      projectId,
      forkedFromThreadId: null,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      messages: [],
      createdAt: "2026-03-29T00:00:00.000Z",
      pinnedAt: null,
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      branch: null,
      worktreePath: null,
      activities: [],
    };
    const dispatchSessionSlice: ThreadSessionSlice = {
      session: previousSession,
      latestTurn: previousLatestTurn,
      error: null,
    };
    const localDispatch = createLocalDispatchSnapshot(dispatchThread, dispatchSessionSlice);

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: previousSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch when a new turn is already settled", () => {
    const dispatchThread: Thread = {
      id: ThreadId.makeUnsafe("thread-1"),
      codexThreadId: null,
      projectId,
      forkedFromThreadId: null,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      messages: [],
      createdAt: "2026-03-29T00:00:00.000Z",
      pinnedAt: null,
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      branch: null,
      worktreePath: null,
      activities: [],
    };
    const dispatchSessionSlice: ThreadSessionSlice = {
      session: previousSession,
      latestTurn: previousLatestTurn,
      error: null,
    };
    const localDispatch = createLocalDispatchSnapshot(dispatchThread, dispatchSessionSlice);

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.makeUnsafe("turn-2"),
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
        },
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:01:30.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the session changes without an observed running phase", () => {
    const dispatchThread: Thread = {
      id: ThreadId.makeUnsafe("thread-1"),
      codexThreadId: null,
      projectId,
      forkedFromThreadId: null,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      messages: [],
      createdAt: "2026-03-29T00:00:00.000Z",
      pinnedAt: null,
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      branch: null,
      worktreePath: null,
      activities: [],
    };
    const dispatchSessionSlice: ThreadSessionSlice = {
      session: previousSession,
      latestTurn: previousLatestTurn,
      error: null,
    };
    const localDispatch = createLocalDispatchSnapshot(dispatchThread, dispatchSessionSlice);

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:00:11.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

describe("prepareWorktree", () => {
  /** Mock that echoes back `newBranch` as the created branch so tests verify
   *  the full pipeline: input → sanitize/generate → createWorktree → result. */
  const echoCreateWorktree = (worktreePath = "/worktrees/test") =>
    vi
      .fn()
      .mockImplementation(({ newBranch }: { newBranch: string }) =>
        Promise.resolve({ worktree: { branch: newBranch, path: worktreePath } }),
      );

  it("uses a sanitized user-supplied branch name when provided", async () => {
    const createWorktree = echoCreateWorktree();
    const result = await prepareWorktree({
      cwd: "/repo",
      baseBranch: "main",
      userBranchName: "My Feature!!",
      branchPrefix: "forge",
      createWorktree,
    });

    expect(createWorktree).toHaveBeenCalledOnce();
    const call = createWorktree.mock.calls[0]!;
    expect(call[0].cwd).toBe("/repo");
    expect(call[0].branch).toBe("main");
    // Branch name should be sanitized (lowercased, special chars removed)
    expect(call[0].newBranch).toBe("my-feature");
    // Result reflects the sanitized name end-to-end (echoed by the mock)
    expect(result.branch).toBe("my-feature");
    expect(result.worktreePath).toBe("/worktrees/test");
  });

  it("generates a temporary branch name when userBranchName is null", async () => {
    const createWorktree = echoCreateWorktree();
    const result = await prepareWorktree({
      cwd: "/repo",
      baseBranch: "main",
      userBranchName: null,
      branchPrefix: "forge",
      createWorktree,
    });

    const call = createWorktree.mock.calls[0]!;
    // Should match the temporary branch pattern: prefix/8-hex-chars
    expect(call[0].newBranch).toMatch(/^forge\/[0-9a-f]{8}$/);
    // Result branch matches what was passed to createWorktree
    expect(result.branch).toBe(call[0].newBranch);
  });

  it("generates a temporary branch name when userBranchName is empty string", async () => {
    const createWorktree = echoCreateWorktree();
    const result = await prepareWorktree({
      cwd: "/repo",
      baseBranch: "main",
      userBranchName: "",
      branchPrefix: "forge",
      createWorktree,
    });

    const call = createWorktree.mock.calls[0]!;
    expect(call[0].newBranch).toMatch(/^forge\/[0-9a-f]{8}$/);
    expect(result.branch).toBe(call[0].newBranch);
  });

  it("generates a temporary branch name when userBranchName is whitespace-only", async () => {
    const createWorktree = echoCreateWorktree();
    const result = await prepareWorktree({
      cwd: "/repo",
      baseBranch: "develop",
      userBranchName: "   ",
      branchPrefix: "my-prefix",
      createWorktree,
    });

    const call = createWorktree.mock.calls[0]!;
    expect(call[0].newBranch).toMatch(/^my-prefix\/[0-9a-f]{8}$/);
    expect(call[0].branch).toBe("develop");
    expect(result.branch).toBe(call[0].newBranch);
  });

  it("returns the worktreePath from the createWorktree result", async () => {
    const createWorktree = echoCreateWorktree("/home/user/.forge/worktrees/abc-123");
    const result = await prepareWorktree({
      cwd: "/repo",
      baseBranch: "main",
      userBranchName: null,
      branchPrefix: "forge",
      createWorktree,
    });

    expect(result.worktreePath).toBe("/home/user/.forge/worktrees/abc-123");
  });

  it("propagates errors from createWorktree", async () => {
    const createWorktree = vi.fn().mockRejectedValue(new Error("git worktree add failed"));
    await expect(
      prepareWorktree({
        cwd: "/repo",
        baseBranch: "main",
        userBranchName: null,
        branchPrefix: "forge",
        createWorktree,
      }),
    ).rejects.toThrow("git worktree add failed");
  });
});
