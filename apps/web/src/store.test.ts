import {
  CheckpointRef,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  type ForgeEvent,
  InteractiveRequestId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@forgetools/contracts";
import { describe, expect, it } from "vitest";

import {
  bootstrapWorkLogProjectionState,
  deriveTimelineEntries,
  deriveWorkLogEntries,
} from "./session-logic";
import {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  selectThreadsByIds,
  syncServerReadModel,
  type AppState,
} from "./store";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Thread,
  type ThreadDesignSlice,
  type ThreadDiffsSlice,
  type ThreadPlansSlice,
  type ThreadSessionSlice,
} from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    parentThreadId: null,
    forkedFromThreadId: null,
    phaseRunId: null,
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    workflowId: null,
    currentPhaseId: null,
    role: null,
    childThreadIds: [],
    messages: [],
    activities: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    branch: null,
    worktreePath: null,
    ...overrides,
    pinnedAt: overrides.pinnedAt ?? null,
  };
}

interface SliceOverrides {
  session?: Partial<ThreadSessionSlice>;
  diffs?: Partial<ThreadDiffsSlice>;
  plans?: Partial<ThreadPlansSlice>;
  design?: Partial<ThreadDesignSlice>;
}

function makeSlices(
  threadId: string,
  overrides: SliceOverrides = {},
): {
  threadSessionById: Record<string, ThreadSessionSlice>;
  threadDiffsById: Record<string, ThreadDiffsSlice>;
  threadPlansById: Record<string, ThreadPlansSlice>;
  threadDesignById: Record<string, ThreadDesignSlice>;
} {
  return {
    threadSessionById: {
      [threadId]: {
        session: null,
        latestTurn: null,
        error: null,
        ...overrides.session,
      },
    },
    threadDiffsById: {
      [threadId]: {
        turnDiffSummaries: [],
        ...overrides.diffs,
      },
    },
    threadPlansById: {
      [threadId]: {
        proposedPlans: [],
        ...overrides.plans,
      },
    },
    threadDesignById: {
      [threadId]: {
        designArtifacts: [],
        designPendingOptions: null,
        ...overrides.design,
      },
    },
  };
}

const EMPTY_SLICES = {
  threadSessionById: {},
  threadDiffsById: {},
  threadPlansById: {},
  threadDesignById: {},
  streamingMessageByThreadId: {},
} as const;

function makeState(thread: Thread, sliceOverrides: SliceOverrides = {}): AppState {
  const threadIdsByProjectId: AppState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
      },
    ],
    threads: [thread],
    sidebarThreadsById: {},
    threadIdsByProjectId,
    bootstrapComplete: true,
    streamingMessageByThreadId: {},
    ...makeSlices(thread.id, sliceOverrides),
  };
}

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

function makeForgeEvent<T extends ForgeEvent["type"]>(
  type: T,
  payload: Extract<ForgeEvent, { type: T }>["payload"],
  overrides: Partial<Extract<ForgeEvent, { type: T }>> = {},
): Extract<ForgeEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`forge-event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<ForgeEvent, { type: T }>;
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    parentThreadId: null,
    phaseRunId: null,
    workflowId: null,
    currentPhaseId: null,
    discussionId: null,
    role: null,
    childThreadIds: [],
    bootstrapStatus: null,
    forkedFromThreadId: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
    pinnedAt: overrides.pinnedAt ?? null,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
    phaseRuns: [],
    channels: [],
    pendingRequests: [],
    workflows: [],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

function makeDesignPendingRequest(
  overrides: Partial<OrchestrationReadModel["pendingRequests"][number]> = {},
): OrchestrationReadModel["pendingRequests"][number] {
  return {
    id: InteractiveRequestId.makeUnsafe("design-request-1"),
    threadId: ThreadId.makeUnsafe("thread-1"),
    type: "design-option",
    status: "pending",
    payload: {
      type: "design-option",
      prompt: "Pick a direction",
      options: [
        {
          id: "option-a",
          title: "Option A",
          description: "First option",
          artifactId: "artifact-a",
          artifactPath: "/tmp/artifact-a.html",
        },
      ],
    },
    createdAt: "2026-02-27T00:05:00.000Z",
    ...overrides,
  };
}

function makePermissionPendingRequest(
  overrides: Partial<OrchestrationReadModel["pendingRequests"][number]> = {},
): OrchestrationReadModel["pendingRequests"][number] {
  return {
    id: InteractiveRequestId.makeUnsafe("permission-request-1"),
    threadId: ThreadId.makeUnsafe("thread-1"),
    type: "permission",
    status: "pending",
    payload: {
      type: "permission",
      reason: "Need write access",
      permissions: {
        network: {
          enabled: true,
        },
        fileSystem: {
          read: ["/tmp/project/src"],
          write: ["/tmp/project/out"],
        },
      },
    },
    createdAt: "2026-02-27T00:06:00.000Z",
    ...overrides,
  };
}

describe("store read model sync", () => {
  it("marks bootstrap complete after snapshot sync", () => {
    const initialState: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = syncServerReadModel(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.bootstrapComplete).toBe(true);
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-sonnet-4-6");
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const archivedAt = "2026-02-28T00:00:00.000Z";
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          archivedAt,
        }),
      ),
    );

    expect(next.threads[0]?.archivedAt).toBe(archivedAt);
  });

  it("hydrates pending requests from read model pending requests", () => {
    const initialState = makeState(makeThread());
    const readModel = {
      ...makeReadModel(makeReadModelThread({})),
      pendingRequests: [makeDesignPendingRequest(), makePermissionPendingRequest()],
    } satisfies OrchestrationReadModel;

    const next = syncServerReadModel(initialState, readModel);

    const threadId = ThreadId.makeUnsafe("thread-1");
    expect(next.threadDesignById[threadId]?.designPendingOptions).toMatchObject({
      requestId: InteractiveRequestId.makeUnsafe("design-request-1"),
      prompt: "Pick a direction",
      chosenOptionId: null,
    });
    expect(
      next.threadSessionById[threadId]?.pendingRequests?.map((request) => request.type),
    ).toEqual(["design-option", "permission"]);
    expect(next.sidebarThreadsById[ThreadId.makeUnsafe("thread-1")]?.hasPendingDesignChoice).toBe(
      true,
    );
    expect(next.sidebarThreadsById[ThreadId.makeUnsafe("thread-1")]?.hasPendingUserInput).toBe(
      true,
    );
  });

  it("replaces projects using snapshot order during recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      bootstrapComplete: true,
      ...EMPTY_SLICES,
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
      phaseRuns: [],
      channels: [],
      pendingRequests: [],
      workflows: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project1, project2, project3]);
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.bootstrapComplete).toBe(false);
  });

  it("applies thread pin and unpin events without mutating updatedAt", () => {
    const threadId = ThreadId.makeUnsafe("thread-pin");
    const initialState = makeState(
      makeThread({
        id: threadId,
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const pinned = applyOrchestrationEvent(
      initialState,
      makeEvent("thread.pinned", {
        threadId,
        pinnedAt: "2026-02-27T00:06:00.000Z",
      }),
    );

    expect(pinned.threads[0]?.pinnedAt).toBe("2026-02-27T00:06:00.000Z");
    expect(pinned.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
    expect(pinned.sidebarThreadsById[threadId]?.pinnedAt).toBe("2026-02-27T00:06:00.000Z");

    const unpinned = applyOrchestrationEvent(
      pinned,
      makeEvent("thread.unpinned", {
        threadId,
        unpinnedAt: "2026-02-27T00:07:00.000Z",
      }),
    );

    expect(unpinned.threads[0]?.pinnedAt).toBeNull();
    expect(unpinned.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("applies session-style thread.message-sent events", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = makeState(makeThread({ id: threadId }), {
      session: {
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: turnId,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        error: null,
      },
    });

    const next = applyOrchestrationEvent(
      initialState,
      makeForgeEvent("thread.message-sent", {
        threadId,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        content: "Done.",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(next.threads[0]?.messages.at(-1)?.text).toBe("Done.");
    expect(next.threadSessionById[threadId]?.latestTurn).toMatchObject({
      turnId,
      state: "completed",
      assistantMessageId: MessageId.makeUnsafe("message-1"),
      completedAt: "2026-02-27T00:00:03.000Z",
    });
  });

  it("preserves runtime sequence on buffered assistant chunks", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = makeState(makeThread({ id: threadId }));

    const next = applyOrchestrationEvent(
      initialState,
      makeEvent(
        "thread.message-sent",
        {
          threadId,
          messageId: MessageId.makeUnsafe("assistant-buffered"),
          role: "assistant",
          text: "Buffered answer",
          turnId,
          streaming: false,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt: "2026-02-27T00:00:05.000Z",
        },
        {
          sequence: 25,
        },
      ),
    );

    expect(next.threads[0]?.messages.at(-1)).toMatchObject({
      id: MessageId.makeUnsafe("assistant-buffered"),
      createdAt: "2026-02-27T00:00:01.000Z",
      completedAt: "2026-02-27T00:00:05.000Z",
      sequence: 25,
      streaming: false,
    });
  });

  it("anchors appended activities to orchestration event order for timeline stability", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = makeState(
      makeThread({
        id: threadId,
        messages: [
          {
            id: MessageId.makeUnsafe("assistant-before-command"),
            role: "assistant",
            text: "I am about to run a command.",
            turnId,
            createdAt: "2026-02-27T00:00:05.000Z",
            sequence: 10,
            streaming: false,
            completedAt: "2026-02-27T00:00:05.000Z",
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      initialState,
      makeEvent(
        "thread.activity-appended",
        {
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-inline-command"),
            tone: "tool",
            kind: "tool.started",
            summary: "Command started",
            payload: {
              itemType: "command_execution",
              data: {
                item: {
                  command: ["sleep", "2"],
                },
              },
            },
            turnId,
            createdAt: "2026-02-27T00:00:05.000Z",
            sequence: 1,
          },
        },
        {
          sequence: 11,
        },
      ),
    );

    expect(next.threads[0]?.activities[0]).toMatchObject({
      id: EventId.makeUnsafe("activity-inline-command"),
      sequence: 11,
    });
    const workEntries = deriveWorkLogEntries(next.threads[0]?.activities ?? [], undefined);
    expect(workEntries[0]).toMatchObject({
      id: EventId.makeUnsafe("activity-inline-command"),
      sequence: 11,
    });

    const timeline = deriveTimelineEntries(next.threads[0]?.messages ?? [], [], workEntries);
    expect(
      timeline.map((entry) =>
        entry.kind === "message"
          ? entry.message.id
          : entry.kind === "work"
            ? entry.entry.id
            : entry.id,
      ),
    ).toEqual([
      MessageId.makeUnsafe("assistant-before-command"),
      EventId.makeUnsafe("activity-inline-command"),
    ]);
  });

  it("applies forge turn lifecycle events to session state", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");
    const initialState = makeState(makeThread({ id: threadId }), {
      session: {
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          activeTurnId: undefined,
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
        latestTurn: null,
        error: null,
      },
    });

    const started = applyOrchestrationEvent(
      initialState,
      makeForgeEvent("thread.turn-started", {
        threadId,
        turnId,
        startedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(started.threadSessionById[threadId]?.session).toMatchObject({
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: turnId,
    });

    const completed = applyOrchestrationEvent(
      started,
      makeForgeEvent("thread.turn-completed", {
        threadId,
        turnId,
        completedAt: "2026-02-27T00:00:02.000Z",
      }),
    );

    expect(completed.threadSessionById[threadId]?.session).toMatchObject({
      status: "ready",
      orchestrationStatus: "ready",
    });
    expect(completed.threadSessionById[threadId]?.latestTurn).toMatchObject({
      turnId,
      state: "completed",
      completedAt: "2026-02-27T00:00:02.000Z",
    });
  });

  it("maps forge session status changes onto the UI session model", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const initialState = makeState(makeThread({ id: threadId }), {
      session: {
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
        latestTurn: null,
        error: null,
      },
    });

    const next = applyOrchestrationEvent(
      initialState,
      makeForgeEvent("thread.status-changed", {
        threadId,
        status: "completed",
        previousStatus: "running",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(next.threadSessionById[threadId]?.session).toMatchObject({
      status: "closed",
      orchestrationStatus: "idle",
      activeTurnId: undefined,
      updatedAt: "2026-02-27T00:00:03.000Z",
    });
  });

  it("opens pending design choice state from request.opened events", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const state = makeState(
      makeThread({
        id: threadId,
        interactionMode: "design",
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeForgeEvent("request.opened", {
        requestId: InteractiveRequestId.makeUnsafe("design-request-1"),
        threadId,
        childThreadId: null,
        phaseRunId: null,
        requestType: "design-option",
        payload: {
          type: "design-option",
          prompt: "Pick a direction",
          options: [
            {
              id: "option-a",
              title: "Option A",
              description: "First option",
              artifactId: "artifact-a",
              artifactPath: "/tmp/artifact-a.html",
            },
          ],
        },
        createdAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
    expect(next.threadDesignById[threadId]?.designPendingOptions?.requestId).toBe(
      InteractiveRequestId.makeUnsafe("design-request-1"),
    );
    expect(next.sidebarThreadsById[threadId]?.hasPendingDesignChoice).toBe(true);
  });

  it("clears pending design choice state from request.resolved events", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const state = makeState(
      makeThread({
        id: threadId,
        interactionMode: "design",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      {
        design: {
          designPendingOptions: {
            requestId: InteractiveRequestId.makeUnsafe("design-request-1"),
            prompt: "Pick a direction",
            options: [
              {
                id: "option-a",
                title: "Option A",
                description: "First option",
                artifactId: "artifact-a",
                artifactPath: "/tmp/artifact-a.html",
              },
            ],
            chosenOptionId: null,
          },
        },
      },
    );

    const next = applyOrchestrationEvent(
      state,
      makeForgeEvent("request.resolved", {
        requestId: InteractiveRequestId.makeUnsafe("design-request-1"),
        resolvedWith: {
          chosenOptionId: "option-a",
        },
        resolvedAt: "2026-02-27T00:06:00.000Z",
      }),
    );

    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:06:00.000Z");
    expect(next.threadDesignById[threadId]?.designPendingOptions).toBeNull();
  });

  it("clears pending design choice state from request.stale events", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const state = makeState(
      makeThread({
        id: threadId,
        interactionMode: "design",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      {
        design: {
          designPendingOptions: {
            requestId: InteractiveRequestId.makeUnsafe("design-request-1"),
            prompt: "Pick a direction",
            options: [
              {
                id: "option-a",
                title: "Option A",
                description: "First option",
                artifactId: "artifact-a",
                artifactPath: "/tmp/artifact-a.html",
              },
            ],
            chosenOptionId: null,
          },
        },
      },
    );

    const next = applyOrchestrationEvent(
      state,
      makeForgeEvent("request.stale", {
        requestId: InteractiveRequestId.makeUnsafe("design-request-1"),
        reason: "stale",
        staleAt: "2026-02-27T00:07:00.000Z",
      }),
    );

    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:07:00.000Z");
    expect(next.threadDesignById[threadId]?.designPendingOptions).toBeNull();
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.makeUnsafe("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.makeUnsafe("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      bootstrapComplete: true,
      ...EMPTY_SLICES,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe(recreatedProjectId);
    expect(next.projects[0]?.cwd).toBe("/tmp/project");
    expect(next.projects[0]?.name).toBe("Project Recreated");
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: recreatedProjectId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [thread],
      sidebarThreadsById: {},
      threadIdsByProjectId: {
        [originalProjectId]: [threadId],
      },
      bootstrapComplete: true,
      ...EMPTY_SLICES,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        workflowId: null,
        discussionId: null,
        parentThreadId: null,
        forkedFromThreadId: null,
        role: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.projectId).toBe(recreatedProjectId);
    expect(next.threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[recreatedProjectId]).toEqual([threadId]);
  });

  it("streaming deltas go to the streaming buffer without mutating committed messages", () => {
    const thread1 = makeThread({
      id: ThreadId.makeUnsafe("thread-1"),
    });
    const thread2 = makeThread({ id: ThreadId.makeUnsafe("thread-2") });
    const state: AppState = {
      ...makeState(thread1),
      threads: [thread1, thread2],
    };

    // First streaming delta creates the buffer entry
    const next1 = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: "hello",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
    );

    // Committed messages unchanged; streaming buffer populated
    expect(next1.threads[0]?.messages).toHaveLength(0);
    expect(next1.streamingMessageByThreadId[thread1.id]?.text).toBe("hello");
    expect(next1.threadSessionById[thread1.id]?.latestTurn?.state).toBe("running");
    expect(next1.threads[1]).toBe(thread2);

    // Second delta concatenates in the buffer
    const next2 = applyOrchestrationEvent(
      next1,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next2.threads[0]?.messages).toHaveLength(0);
    expect(next2.streamingMessageByThreadId[thread1.id]?.text).toBe("hello world");

    // Completion commits the message and clears the buffer
    const next3 = applyOrchestrationEvent(
      next2,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: "hello world",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );

    expect(next3.threads[0]?.messages).toHaveLength(1);
    expect(next3.threads[0]?.messages[0]?.text).toBe("hello world");
    expect(next3.threads[0]?.messages[0]?.streaming).toBe(false);
    expect(next3.streamingMessageByThreadId[thread1.id]).toBeUndefined();
    expect(next3.threadSessionById[thread1.id]?.latestTurn?.state).toBe("completed");
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread();
    const state = makeState(thread, {
      session: {
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      },
    });

    const next = applyOrchestrationEvents(state, [
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            lastError: null,
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        },
        { sequence: 2 },
      ),
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "done",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: 3 },
      ),
    ]);

    expect(next.threadSessionById[thread.id]?.session?.status).toBe("running");
    expect(next.threadSessionById[thread.id]?.latestTurn?.state).toBe("completed");
    expect(next.threads[0]?.messages).toHaveLength(1);
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(makeThread(), {
      session: {
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
    );

    const threadId = ThreadId.makeUnsafe("thread-1");
    expect(next.threadDiffsById[threadId]?.turnDiffSummaries).toHaveLength(1);
    expect(next.threadSessionById[threadId]?.latestTurn).toEqual(
      state.threadSessionById[threadId]?.latestTurn,
    );
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(makeThread(), {
      session: {
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
        },
      },
      diffs: {
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
            assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    const threadId = ThreadId.makeUnsafe("thread-1");
    expect(next.threadDiffsById[threadId]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
    expect(next.threadSessionById[threadId]?.latestTurn?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
  });

  it("rebinds agent diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(makeThread(), {
      session: {
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
        },
      },
      diffs: {
        agentDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            provenance: "agent",
            coverage: "complete",
            source: "native_turn_diff",
            assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      },
    });

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(
      next.threadDiffsById[ThreadId.makeUnsafe("thread-1")]?.agentDiffSummaries?.[0]
        ?.assistantMessageId,
    ).toBe(MessageId.makeUnsafe("assistant-real"));
  });

  it("applies live activity inline diff upserts to the thread and work log state", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const activityId = EventId.makeUnsafe("activity-inline-diff-1");
    const state: AppState = {
      ...makeState(
        makeThread({
          id: threadId,
          activities: [
            {
              id: activityId,
              createdAt: "2026-02-27T00:00:01.000Z",
              tone: "tool",
              kind: "tool.completed",
              summary: "Command",
              turnId: TurnId.makeUnsafe("turn-1"),
              sequence: 5,
              payload: {
                itemType: "command_execution",
                itemId: "cmd-inline-diff-1",
                status: "completed",
                data: {
                  item: {
                    id: "cmd-inline-diff-1",
                    command: ["/bin/zsh", "-lc", "git diff --stat"],
                    aggregatedOutput: "done",
                    exitCode: 0,
                  },
                },
              },
            },
          ],
        }),
      ),
      threadWorkLogById: {
        [threadId]: bootstrapWorkLogProjectionState(
          [
            {
              id: activityId,
              createdAt: "2026-02-27T00:00:01.000Z",
              tone: "tool",
              kind: "tool.completed",
              summary: "Command",
              turnId: TurnId.makeUnsafe("turn-1"),
              sequence: 5,
              payload: {
                itemType: "command_execution",
                itemId: "cmd-inline-diff-1",
                status: "completed",
                data: {
                  item: {
                    id: "cmd-inline-diff-1",
                    command: ["/bin/zsh", "-lc", "git diff --stat"],
                    aggregatedOutput: "done",
                    exitCode: 0,
                  },
                },
              },
            },
          ],
          { messages: [], latestTurn: null },
        ),
      },
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.activity-inline-diff-upserted", {
        threadId,
        activityId,
        updatedAt: "2026-02-27T00:00:02.000Z",
        inlineDiff: {
          availability: "summary_only",
          files: [{ path: "src/store.ts", additions: 3, deletions: 1 }],
          additions: 3,
          deletions: 1,
        },
      }),
    );

    const activity = next.threads[0]?.activities[0];
    expect(activity).toMatchObject({
      id: activityId,
      payload: {
        inlineDiff: {
          availability: "summary_only",
          additions: 3,
          deletions: 1,
        },
      },
    });

    const workLogEntry = next.threadWorkLogById?.[threadId]?.entries.find(
      (entry) => entry.id === activityId,
    );
    expect(workLogEntry).toMatchObject({
      id: activityId,
      inlineDiff: {
        availability: "summary_only",
        additions: 3,
        deletions: 1,
      },
    });
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.makeUnsafe("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
      }),
      {
        plans: {
          proposedPlans: [
            {
              id: "plan-1",
              turnId: TurnId.makeUnsafe("turn-1"),
              planMarkdown: "plan 1",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-02-27T00:00:00.000Z",
              updatedAt: "2026-02-27T00:00:00.000Z",
            },
            {
              id: "plan-2",
              turnId: TurnId.makeUnsafe("turn-2"),
              planMarkdown: "plan 2",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: "2026-02-27T00:00:02.000Z",
              updatedAt: "2026-02-27T00:00:02.000Z",
            },
          ],
        },
        diffs: {
          turnDiffSummaries: [
            {
              turnId: TurnId.makeUnsafe("turn-1"),
              completedAt: "2026-02-27T00:00:01.000Z",
              status: "ready",
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
              files: [],
            },
            {
              turnId: TurnId.makeUnsafe("turn-2"),
              completedAt: "2026-02-27T00:00:03.000Z",
              status: "ready",
              checkpointTurnCount: 2,
              checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
              files: [],
            },
          ],
        },
      },
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId,
        turnCount: 1,
      }),
    );

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(next.threadPlansById[threadId]?.proposedPlans.map((plan) => plan.id)).toEqual([
      "plan-1",
    ]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(
      next.threadDiffsById[threadId]?.turnDiffSummaries.map((summary) => summary.turnId),
    ).toEqual([TurnId.makeUnsafe("turn-1")]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread();
    const state = makeState(thread, {
      session: {
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "completed",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:02.000Z",
          completedAt: "2026-02-27T00:00:03.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant-2"),
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-source"),
            planId: "plan-2" as never,
          },
        },
        pendingSourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: "plan-2" as never,
        },
      },
      diffs: {
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
            files: [],
          },
        ],
      },
    });
    const reverted = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
    );

    expect(reverted.threadSessionById[thread.id]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
    );

    expect(next.threadSessionById[thread.id]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-3"),
      state: "running",
    });
    expect(next.threadSessionById[thread.id]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });
});

describe("store selectors", () => {
  it("selects threads by id in requested order and ignores missing ids", () => {
    const parentThreadId = ThreadId.makeUnsafe("thread-parent");
    const childThreadId = ThreadId.makeUnsafe("thread-child");
    const state: AppState = {
      ...makeState(
        makeThread({
          id: parentThreadId,
          childThreadIds: [childThreadId],
        }),
      ),
      threads: [
        makeThread({
          id: parentThreadId,
          childThreadIds: [childThreadId],
        }),
        makeThread({
          id: childThreadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          parentThreadId,
          title: "Child thread",
        }),
      ],
    };

    const selected = selectThreadsByIds([
      childThreadId,
      ThreadId.makeUnsafe("thread-missing"),
      parentThreadId,
    ])(state);

    expect(selected.map((thread) => thread.id)).toEqual([childThreadId, parentThreadId]);
  });

  it("returns a shared empty array when no thread ids are requested", () => {
    const selectedWithoutIds = selectThreadsByIds(null)(makeState(makeThread()));
    const selectedWithEmptyIds = selectThreadsByIds([])(makeState(makeThread()));

    expect(selectedWithoutIds).toEqual([]);
    expect(selectedWithEmptyIds).toEqual([]);
    expect(selectedWithoutIds).toBe(selectedWithEmptyIds);
  });
});
