import {
  type ForgeEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  SessionArchivedPayload,
  SessionCancelledPayload,
  SessionCompletedPayload,
  SessionFailedPayload,
  SessionMessageSentPayload,
  SessionStatusChangedPayload,
  SessionTurnCompletedPayload,
  SessionTurnRestartedPayload,
  SessionTurnStartedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadForkedPayload,
  ThreadMessageSentPayload,
} from "@forgetools/contracts";
import { Schema } from "effect";
import { newMessageId } from "./lib/utils";
import {
  mapAgentDiffSummary,
  mapMessageAttachments,
  mapProject,
  mapProposedPlan,
  mapSession,
  mapThread,
  mapTurnDiffSummary,
  normalizeModelSelection,
  mapProjectScripts,
  toDesignPendingOptions,
  toLegacySessionStatus,
  toOrchestrationSessionStatusFromForgeStatus,
} from "./storeMappers";
import {
  buildSidebarThreadSummary,
  buildSidebarThreadsById,
  sidebarThreadSummariesEqual,
} from "./storeSidebar";
import {
  applyActivityToWorkLogProjectionState,
  applyLatestTurnToWorkLogProjectionState,
  applyMessageToWorkLogProjectionState,
  bootstrapWorkLogProjectionState,
  type WorkLogProjectionState,
} from "./session-logic";
import {
  appendThreadIdByProjectId,
  buildLatestTurn,
  buildThreadIdsByProjectId,
  checkpointStatusToLatestTurnState,
  compareActivities,
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
  patchThreadSession,
  rebindAgentDiffSummariesForAssistantMessage,
  rebindTurnDiffSummariesForAssistantMessage,
  removeThreadIdByProjectId,
  retainThreadActivitiesAfterRevert,
  retainThreadMessagesAfterRevert,
  retainThreadProposedPlansAfterRevert,
  updateProject,
  updateThreadByDesignRequestId,
  updateThreadState,
} from "./storeStateHelpers";
import type { ChatMessage, DesignArtifact, Thread } from "./types";
import type { AppState } from "./store";

// ── Schema validators ────────────────────────────────────────────────

const isThreadCreatedPayload = Schema.is(ThreadCreatedPayload);
const isThreadForkedPayload = Schema.is(ThreadForkedPayload);
const isThreadArchivedPayload = Schema.is(ThreadArchivedPayload);
const isSessionArchivedPayload = Schema.is(SessionArchivedPayload);
const isThreadMessageSentPayload = Schema.is(ThreadMessageSentPayload);
const isSessionMessageSentPayload = Schema.is(SessionMessageSentPayload);
const isSessionTurnStartedPayload = Schema.is(SessionTurnStartedPayload);
const isSessionTurnCompletedPayload = Schema.is(SessionTurnCompletedPayload);
const isSessionTurnRestartedPayload = Schema.is(SessionTurnRestartedPayload);
const isSessionStatusChangedPayload = Schema.is(SessionStatusChangedPayload);
const isSessionCompletedPayload = Schema.is(SessionCompletedPayload);
const isSessionFailedPayload = Schema.is(SessionFailedPayload);
const isSessionCancelledPayload = Schema.is(SessionCancelledPayload);

function setThreadWorkLogState(
  state: AppState,
  threadId: Thread["id"],
  workLogState: WorkLogProjectionState,
): AppState {
  const previous = state.threadWorkLogById?.[threadId];
  if (previous === workLogState) {
    return state;
  }
  return {
    ...state,
    threadWorkLogById: {
      ...state.threadWorkLogById,
      [threadId]: workLogState,
    },
  };
}

function deleteThreadWorkLogState(state: AppState, threadId: Thread["id"]): AppState {
  if (!state.threadWorkLogById || !(threadId in state.threadWorkLogById)) {
    return state;
  }
  const threadWorkLogById = { ...state.threadWorkLogById };
  delete threadWorkLogById[threadId];
  return {
    ...state,
    threadWorkLogById,
  };
}

// ── Project events ───────────────────────────────────────────────────

function handleProjectEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "project.created": {
      const existingIndex = state.projects.findIndex(
        (project) =>
          project.id === event.payload.projectId || project.cwd === event.payload.workspaceRoot,
      );
      const nextProject = mapProject({
        id: event.payload.projectId,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        scripts: event.payload.scripts,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        deletedAt: null,
      });
      const projects =
        existingIndex >= 0
          ? state.projects.map((project, index) =>
              index === existingIndex ? nextProject : project,
            )
          : [...state.projects, nextProject];
      return { ...state, projects };
    }

    case "project.meta-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
        ...project,
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? normalizeModelSelection(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.deleted": {
      const projects = state.projects.filter((project) => project.id !== event.payload.projectId);
      return projects.length === state.projects.length ? state : { ...state, projects };
    }
  }

  return undefined;
}

// ── Thread lifecycle events ──────────────────────────────────────────

function handleThreadLifecycleEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.created": {
      if (!isThreadCreatedPayload(event.payload)) {
        return state;
      }
      const payload = event.payload;
      const existing = state.threads.find((thread) => thread.id === event.payload.threadId);
      const stagedThreadPayload = event.payload as Partial<
        Pick<
          OrchestrationThread,
          | "parentThreadId"
          | "phaseRunId"
          | "workflowId"
          | "currentPhaseId"
          | "discussionId"
          | "role"
          | "childThreadIds"
        >
      >;
      const parentThreadId: OrchestrationThread["parentThreadId"] =
        stagedThreadPayload.parentThreadId ?? null;
      const phaseRunId: OrchestrationThread["phaseRunId"] = stagedThreadPayload.phaseRunId ?? null;
      const workflowId: OrchestrationThread["workflowId"] = stagedThreadPayload.workflowId ?? null;
      const currentPhaseId: OrchestrationThread["currentPhaseId"] =
        stagedThreadPayload.currentPhaseId ?? null;
      const discussionId: OrchestrationThread["discussionId"] =
        stagedThreadPayload.discussionId ?? null;
      const role: OrchestrationThread["role"] = stagedThreadPayload.role ?? null;
      const childThreadIds: OrchestrationThread["childThreadIds"] =
        stagedThreadPayload.childThreadIds ?? [];
      const spawnMode: OrchestrationThread["spawnMode"] =
        payload.spawnMode ??
        ((
          payload.spawnWorktreePath !== undefined ? payload.spawnWorktreePath : payload.worktreePath
        )
          ? "worktree"
          : "local");
      const spawnBranch: OrchestrationThread["spawnBranch"] =
        payload.spawnBranch !== undefined ? payload.spawnBranch : payload.branch;
      const spawnWorktreePath: OrchestrationThread["spawnWorktreePath"] =
        payload.spawnWorktreePath !== undefined ? payload.spawnWorktreePath : payload.worktreePath;
      const nextThread = mapThread(
        {
          id: payload.threadId,
          projectId: payload.projectId,
          title: payload.title,
          modelSelection: payload.modelSelection,
          runtimeMode: payload.runtimeMode,
          interactionMode: payload.interactionMode,
          branch: payload.branch,
          worktreePath: payload.worktreePath,
          spawnMode,
          latestTurn: null,
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
          pinnedAt: null,
          archivedAt: null,
          deletedAt: null,
          spawnBranch,
          spawnWorktreePath,
          parentThreadId,
          phaseRunId,
          workflowId,
          currentPhaseId,
          discussionId: discussionId,
          role,
          childThreadIds,
          bootstrapStatus: null,
          forkedFromThreadId: payload.forkedFromThreadId ?? null,
          messages: [],
          proposedPlans: [],
          activities: [],
          agentDiffs: [],
          checkpoints: [],
          session: null,
        },
        [],
      );
      let threads = existing
        ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
        : [...state.threads, nextThread];
      let updatedSidebarThreadsById = state.sidebarThreadsById;

      // If this child thread has a parent, add it to the parent's childThreadIds.
      if (parentThreadId !== null) {
        threads = threads.map((thread) =>
          thread.id === parentThreadId && !(thread.childThreadIds ?? []).includes(nextThread.id)
            ? { ...thread, childThreadIds: [...(thread.childThreadIds ?? []), nextThread.id] }
            : thread,
        );
        const updatedParent = threads.find((t) => t.id === parentThreadId);
        if (updatedParent) {
          const parentSummary = buildSidebarThreadSummary(updatedParent);
          updatedSidebarThreadsById = {
            ...updatedSidebarThreadsById,
            [parentThreadId]: parentSummary,
          };
        }
      }

      const nextSummary = buildSidebarThreadSummary(nextThread);
      const previousSummary = updatedSidebarThreadsById[nextThread.id];
      const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
        ? updatedSidebarThreadsById
        : {
            ...updatedSidebarThreadsById,
            [nextThread.id]: nextSummary,
          };
      const nextThreadIdsByProjectId =
        existing !== undefined && existing.projectId !== nextThread.projectId
          ? removeThreadIdByProjectId(state.threadIdsByProjectId, existing.projectId, existing.id)
          : state.threadIdsByProjectId;
      const threadIdsByProjectId = appendThreadIdByProjectId(
        nextThreadIdsByProjectId,
        nextThread.projectId,
        nextThread.id,
      );
      const nextState = {
        ...state,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
      };
      return setThreadWorkLogState(
        nextState,
        nextThread.id,
        bootstrapWorkLogProjectionState([], { latestTurn: nextThread.latestTurn, messages: [] }),
      );
    }

    case "thread.deleted": {
      const threads = state.threads.filter((thread) => thread.id !== event.payload.threadId);
      if (threads.length === state.threads.length) {
        return state;
      }
      const deletedThread = state.threads.find((thread) => thread.id === event.payload.threadId);
      const sidebarThreadsById = { ...state.sidebarThreadsById };
      delete sidebarThreadsById[event.payload.threadId];
      const threadIdsByProjectId = deletedThread
        ? removeThreadIdByProjectId(
            state.threadIdsByProjectId,
            deletedThread.projectId,
            deletedThread.id,
          )
        : state.threadIdsByProjectId;
      return deleteThreadWorkLogState(
        {
          ...state,
          threads,
          sidebarThreadsById,
          threadIdsByProjectId,
        },
        event.payload.threadId,
      );
    }

    case "thread.archived": {
      if (!isThreadArchivedPayload(event.payload) && !isSessionArchivedPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: isThreadArchivedPayload(event.payload)
          ? event.payload.updatedAt
          : event.payload.archivedAt,
      }));
    }

    case "thread.unarchived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.pinned": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        pinnedAt: event.payload.pinnedAt,
      }));
    }

    case "thread.unpinned": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        pinnedAt: null,
      }));
    }

    case "thread.meta-updated": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
      }));
    }

    case "thread.runtime-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        runtimeMode: event.payload.runtimeMode,
      }));
    }

    case "thread.interaction-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        interactionMode: event.payload.interactionMode,
      }));
    }

    case "thread.forked": {
      if (!isThreadForkedPayload(event.payload)) {
        return state;
      }
      const { threadId: forkThreadId, sourceThreadId } = event.payload;
      const sourceThread = state.threads.find((t) => t.id === sourceThreadId);
      const forkThread = state.threads.find((t) => t.id === forkThreadId);
      if (!sourceThread || !forkThread) {
        return state;
      }
      // oxlint-disable-next-line no-map-spread -- immutable state; copy-on-write required
      const copiedMessages: ChatMessage[] = sourceThread.messages.map((m) => ({
        ...m,
        id: newMessageId(),
      }));
      const updatedFork: Thread = {
        ...forkThread,
        forkedFromThreadId: sourceThreadId,
        messages: copiedMessages,
      };
      const threads = state.threads.map((t) => (t.id === forkThreadId ? updatedFork : t));
      const nextSummary = buildSidebarThreadSummary(updatedFork);
      const previousSummary = state.sidebarThreadsById[forkThreadId];
      const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
        ? state.sidebarThreadsById
        : { ...state.sidebarThreadsById, [forkThreadId]: nextSummary };
      return { ...state, threads, sidebarThreadsById };
    }

    case "thread.bootstrap-started":
    case "thread.bootstrap-completed":
    case "thread.bootstrap-failed":
    case "thread.bootstrap-skipped":
      return state;
  }

  return undefined;
}

// ── Session events ───────────────────────────────────────────────────

function handleSessionEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.status-changed": {
      if (!isSessionStatusChangedPayload(event.payload)) {
        return state;
      }
      const orchestrationStatus = toOrchestrationSessionStatusFromForgeStatus(event.payload.status);
      return updateThreadState(state, event.payload.threadId, (thread) =>
        patchThreadSession(thread, {
          status: toLegacySessionStatus(orchestrationStatus),
          orchestrationStatus,
          activeTurnId:
            orchestrationStatus === "running" ? thread.session?.activeTurnId : undefined,
          updatedAt: event.payload.updatedAt,
        }),
      );
    }

    case "thread.completed": {
      if (!isSessionCompletedPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "closed",
          orchestrationStatus: "idle",
          activeTurnId: undefined,
          updatedAt: event.payload.completedAt,
        }),
        updatedAt: event.payload.completedAt,
      }));
    }

    case "thread.failed": {
      if (!isSessionFailedPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(
          thread,
          {
            status: "error",
            orchestrationStatus: "error",
            activeTurnId: undefined,
            updatedAt: event.payload.failedAt,
            lastError: event.payload.error,
          },
          event.payload.error,
        ),
        updatedAt: event.payload.failedAt,
      }));
    }

    case "thread.cancelled": {
      if (!isSessionCancelledPayload(event.payload)) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "closed",
          orchestrationStatus: "stopped",
          activeTurnId: undefined,
          updatedAt: event.payload.cancelledAt,
        }),
        updatedAt: event.payload.cancelledAt,
      }));
    }

    case "thread.session-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        session: mapSession(event.payload.session),
        error: event.payload.session.lastError ?? null,
        latestTurn:
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.assistantMessageId
                    : null,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn,
      }));
    }

    case "thread.session-stop-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) =>
        thread.session === null
          ? thread
          : {
              ...thread,
              session: {
                ...thread.session,
                status: "closed",
                orchestrationStatus: "stopped",
                activeTurnId: undefined,
                updatedAt: event.payload.createdAt,
              },
            },
      );
    }
  }

  return undefined;
}

// ── Message events ───────────────────────────────────────────────────

function handleMessageEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.message-sent": {
      if (
        !isThreadMessageSentPayload(event.payload) &&
        !isSessionMessageSentPayload(event.payload)
      ) {
        return state;
      }
      const nextState = updateThreadState(state, event.payload.threadId, (thread) => {
        const messageUpdatedAt = isThreadMessageSentPayload(event.payload)
          ? event.payload.updatedAt
          : event.payload.createdAt;
        const attachments =
          isThreadMessageSentPayload(event.payload) && event.payload.attachments !== undefined
            ? mapMessageAttachments(event.payload.attachments)
            : undefined;
        const message: ChatMessage = {
          id: event.payload.messageId,
          role: event.payload.role as ChatMessage["role"],
          text: isThreadMessageSentPayload(event.payload)
            ? event.payload.text
            : event.payload.content,
          turnId: event.payload.turnId,
          createdAt: event.payload.createdAt,
          ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
          streaming: event.payload.streaming,
          ...(event.payload.streaming ? {} : { completedAt: messageUpdatedAt }),
          ...(attachments !== undefined ? { attachments } : {}),
          ...(isThreadMessageSentPayload(event.payload) && event.payload.attribution !== undefined
            ? { attribution: event.payload.attribution }
            : {}),
        };
        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id !== message.id
                ? entry
                : {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
                    ...(entry.sequence !== undefined
                      ? { sequence: entry.sequence }
                      : message.sequence !== undefined
                        ? { sequence: message.sequence }
                        : {}),
                    ...(message.streaming
                      ? entry.completedAt !== undefined
                        ? { completedAt: entry.completedAt }
                        : {}
                      : message.completedAt !== undefined
                        ? { completedAt: message.completedAt }
                        : {}),
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                    ...(message.attribution !== undefined
                      ? { attribution: message.attribution }
                      : {}),
                  },
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);
        const turnDiffSummaries =
          event.payload.role === "assistant" && event.payload.turnId !== null
            ? rebindTurnDiffSummariesForAssistantMessage(
                thread.turnDiffSummaries,
                event.payload.turnId,
                event.payload.messageId,
              )
            : thread.turnDiffSummaries;
        const agentDiffSummaries =
          event.payload.role === "assistant" &&
          event.payload.turnId !== null &&
          thread.agentDiffSummaries !== undefined
            ? rebindAgentDiffSummariesForAssistantMessage(
                thread.agentDiffSummaries,
                event.payload.turnId,
                event.payload.messageId,
              )
            : thread.agentDiffSummaries;
        const latestTurn: Thread["latestTurn"] =
          event.payload.role === "assistant" &&
          event.payload.turnId !== null &&
          (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: event.payload.streaming
                  ? "running"
                  : thread.latestTurn?.state === "interrupted"
                    ? "interrupted"
                    : thread.latestTurn?.state === "error"
                      ? "error"
                      : "completed",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.createdAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                    : event.payload.createdAt,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
                completedAt: event.payload.streaming
                  ? thread.latestTurn?.turnId === event.payload.turnId
                    ? (thread.latestTurn.completedAt ?? null)
                    : null
                  : messageUpdatedAt,
                assistantMessageId: event.payload.messageId,
              })
            : thread.latestTurn;
        return {
          ...thread,
          messages: cappedMessages,
          turnDiffSummaries,
          ...(agentDiffSummaries ? { agentDiffSummaries } : {}),
          latestTurn,
        };
      });
      const nextThread = nextState.threads.find((thread) => thread.id === event.payload.threadId);
      if (!nextThread) {
        return nextState;
      }
      const workLogState = nextState.threadWorkLogById?.[event.payload.threadId];
      if (!workLogState) {
        return nextState;
      }
      const latestMessage = nextThread.messages.find(
        (message) => message.id === event.payload.messageId,
      );
      if (!latestMessage) {
        return nextState;
      }
      let nextWorkLogState = workLogState;
      if (latestMessage.role === "assistant") {
        nextWorkLogState = applyMessageToWorkLogProjectionState(nextWorkLogState, latestMessage);
      }
      if (nextThread.latestTurn !== workLogState.latestTurn) {
        nextWorkLogState = applyLatestTurnToWorkLogProjectionState(
          nextWorkLogState,
          nextThread.latestTurn,
        );
      }
      return setThreadWorkLogState(nextState, event.payload.threadId, nextWorkLogState);
    }
  }

  return undefined;
}

// ── Turn events ──────────────────────────────────────────────────────

function handleTurnEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.turn-start-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSelection(event.payload.modelSelection) }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        pendingSourceProposedPlan: event.payload.sourceProposedPlan,
      }));
    }

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const latestTurn = thread.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return thread;
        }
        return {
          ...thread,
          latestTurn: buildLatestTurn({
            previous: latestTurn,
            turnId: event.payload.turnId,
            state: "interrupted",
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            assistantMessageId: latestTurn.assistantMessageId,
          }),
        };
      });
    }

    case "thread.turn-started": {
      if (!isSessionTurnStartedPayload(event.payload)) {
        return state;
      }
      const nextState = updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: event.payload.turnId,
          updatedAt: event.payload.startedAt,
        }),
        latestTurn: buildLatestTurn({
          previous: thread.latestTurn,
          turnId: event.payload.turnId,
          state: "running",
          requestedAt:
            thread.latestTurn?.turnId === event.payload.turnId
              ? thread.latestTurn.requestedAt
              : event.payload.startedAt,
          startedAt: event.payload.startedAt,
          completedAt: null,
          assistantMessageId:
            thread.latestTurn?.turnId === event.payload.turnId
              ? thread.latestTurn.assistantMessageId
              : null,
          sourceProposedPlan: thread.pendingSourceProposedPlan,
        }),
      }));
      const latestTurn =
        nextState.threads.find((thread) => thread.id === event.payload.threadId)?.latestTurn ??
        null;
      const workLogState = nextState.threadWorkLogById?.[event.payload.threadId];
      return workLogState
        ? setThreadWorkLogState(
            nextState,
            event.payload.threadId,
            applyLatestTurnToWorkLogProjectionState(workLogState, latestTurn),
          )
        : nextState;
    }

    case "thread.turn-completed": {
      if (!isSessionTurnCompletedPayload(event.payload)) {
        return state;
      }
      const nextState = updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "ready",
          orchestrationStatus: "ready",
          activeTurnId: undefined,
          updatedAt: event.payload.completedAt,
        }),
        latestTurn:
          thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: "completed",
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: thread.latestTurn?.assistantMessageId ?? null,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn,
      }));
      const latestTurn =
        nextState.threads.find((thread) => thread.id === event.payload.threadId)?.latestTurn ??
        null;
      const workLogState = nextState.threadWorkLogById?.[event.payload.threadId];
      return workLogState
        ? setThreadWorkLogState(
            nextState,
            event.payload.threadId,
            applyLatestTurnToWorkLogProjectionState(workLogState, latestTurn),
          )
        : nextState;
    }

    case "thread.turn-restarted": {
      if (!isSessionTurnRestartedPayload(event.payload)) {
        return state;
      }
      const nextState = updateThreadState(state, event.payload.threadId, (thread) => ({
        ...patchThreadSession(thread, {
          status: "ready",
          orchestrationStatus: "interrupted",
          activeTurnId: undefined,
          updatedAt: event.payload.restartedAt,
        }),
        latestTurn:
          thread.latestTurn === null
            ? null
            : {
                ...thread.latestTurn,
                state: "interrupted",
                startedAt: thread.latestTurn.startedAt ?? event.payload.restartedAt,
                completedAt: event.payload.restartedAt,
              },
      }));
      const latestTurn =
        nextState.threads.find((thread) => thread.id === event.payload.threadId)?.latestTurn ??
        null;
      const workLogState = nextState.threadWorkLogById?.[event.payload.threadId];
      return workLogState
        ? setThreadWorkLogState(
            nextState,
            event.payload.threadId,
            applyLatestTurnToWorkLogProjectionState(workLogState, latestTurn),
          )
        : nextState;
    }
  }

  return undefined;
}

// ── Diff events ──────────────────────────────────────────────────────

function handleDiffEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.turn-diff-completed": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          files: event.payload.files,
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existing = thread.turnDiffSummaries.find(
          (entry) => entry.turnId === checkpoint.turnId,
        );
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return thread;
        }
        const turnDiffSummaries = [
          ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const latestTurn =
          thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state: checkpointStatusToLatestTurnState(event.payload.status),
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: event.payload.assistantMessageId,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn;
        return {
          ...thread,
          turnDiffSummaries,
          latestTurn,
        };
      });
    }

    case "thread.agent-diff-upserted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const existingSummary = (thread.agentDiffSummaries ?? []).find(
          (entry) => entry.turnId === event.payload.turnId,
        );
        const agentDiffSummary = mapAgentDiffSummary({
          turnId: event.payload.turnId,
          files: event.payload.files,
          source: event.payload.source,
          coverage: event.payload.coverage,
          assistantMessageId:
            event.payload.assistantMessageId ?? existingSummary?.assistantMessageId ?? null,
          completedAt: event.payload.completedAt,
        });
        const agentDiffSummaries = [
          ...(thread.agentDiffSummaries ?? []).filter(
            (entry) => entry.turnId !== agentDiffSummary.turnId,
          ),
          agentDiffSummary,
        ].toSorted(
          (left, right) =>
            left.completedAt.localeCompare(right.completedAt) ||
            left.turnId.localeCompare(right.turnId),
        );
        return {
          ...thread,
          agentDiffSummaries,
        };
      });
    }

    case "thread.proposed-plan-upserted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
          proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS);
        return {
          ...thread,
          proposedPlans,
        };
      });
    }
  }

  return undefined;
}

// ── Activity events ──────────────────────────────────────────────────

function handleActivityEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.activity-appended": {
      const nextState = updateThreadState(state, event.payload.threadId, (thread) => {
        const activities = [
          ...thread.activities.filter((activity) => activity.id !== event.payload.activity.id),
          { ...event.payload.activity },
        ]
          .toSorted(compareActivities)
          .slice(-MAX_THREAD_ACTIVITIES);
        return {
          ...thread,
          activities,
        };
      });
      const workLogState = nextState.threadWorkLogById?.[event.payload.threadId];
      return workLogState
        ? setThreadWorkLogState(
            nextState,
            event.payload.threadId,
            applyActivityToWorkLogProjectionState(workLogState, event.payload.activity),
          )
        : nextState;
    }
  }

  return undefined;
}

// ── Design events ────────────────────────────────────────────────────

function handleDesignEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType !== "design-option") {
        return state;
      }
      const pendingOptions = toDesignPendingOptions({
        requestId: event.payload.requestId,
        payload: event.payload.payload,
      });
      if (pendingOptions === null) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        updatedAt: event.payload.createdAt,
        designPendingOptions: pendingOptions,
      }));
    }

    case "request.resolved": {
      return updateThreadByDesignRequestId(state, event.payload.requestId, (thread) => ({
        ...thread,
        updatedAt: event.payload.resolvedAt,
        designPendingOptions: null,
      }));
    }

    case "request.stale": {
      return updateThreadByDesignRequestId(state, event.payload.requestId, (thread) => ({
        ...thread,
        updatedAt: event.payload.staleAt,
        designPendingOptions: null,
      }));
    }

    case "thread.design.artifact-rendered": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const artifact: DesignArtifact = {
          artifactId: event.payload.artifactId,
          title: event.payload.title,
          description: event.payload.description ?? null,
          artifactPath: event.payload.artifactPath,
          renderedAt: event.payload.renderedAt,
        };
        return {
          ...thread,
          designArtifacts: [...thread.designArtifacts, artifact],
        };
      });
    }

    case "thread.design.options-presented": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        designPendingOptions: {
          requestId: event.payload.requestId,
          prompt: event.payload.prompt,
          options: event.payload.options.map((opt) => ({
            id: opt.id,
            title: opt.title,
            description: opt.description,
            artifactId: opt.artifactId,
            artifactPath: opt.artifactPath,
          })),
          chosenOptionId: null,
        },
      }));
    }

    case "thread.design.option-chosen": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        if (!thread.designPendingOptions) return thread;
        return {
          ...thread,
          designPendingOptions: {
            ...thread.designPendingOptions,
            chosenOptionId: event.payload.chosenOptionId,
          },
        };
      });
    }
  }

  return undefined;
}

// ── Revert events ────────────────────────────────────────────────────

function handleRevertEvent(state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.reverted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter(
            (entry) =>
              entry.checkpointTurnCount !== undefined &&
              entry.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
        const agentDiffSummaries = (thread.agentDiffSummaries ?? [])
          .filter((entry) => retainedTurnIds.has(entry.turnId))
          .toSorted(
            (left, right) =>
              left.completedAt.localeCompare(right.completedAt) ||
              left.turnId.localeCompare(right.turnId),
          );
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const proposedPlans = retainThreadProposedPlansAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_THREAD_PROPOSED_PLANS);
        const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
        const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

        return {
          ...thread,
          agentDiffSummaries,
          turnDiffSummaries,
          messages,
          proposedPlans,
          activities,
          pendingSourceProposedPlan: undefined,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(
                    (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
        };
      });
    }
  }

  return undefined;
}

// ── No-op events ─────────────────────────────────────────────────────

function handleNoopEvent(_state: AppState, event: ForgeEvent): AppState | undefined {
  switch (event.type) {
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return _state;
  }

  return undefined;
}

// ── Sync from server read model ──────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const threads = readModel.threads
    .filter((thread) => thread.deletedAt === null)
    .map((thread) => mapThread(thread, readModel.pendingRequests));
  const threadWorkLogById = Object.fromEntries(
    threads.map((thread) => [
      thread.id,
      bootstrapWorkLogProjectionState(thread.activities, {
        messages: thread.messages,
        latestTurn: thread.latestTurn,
      }),
    ]),
  );
  const sidebarThreadsById = buildSidebarThreadsById(threads);
  const threadIdsByProjectId = buildThreadIdsByProjectId(threads);
  return {
    ...state,
    projects,
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    threadWorkLogById,
    bootstrapComplete: true,
  };
}

// ── Main dispatcher ──────────────────────────────────────────────────

export function applyOrchestrationEvent(state: AppState, event: ForgeEvent): AppState {
  return (
    handleProjectEvent(state, event) ??
    handleThreadLifecycleEvent(state, event) ??
    handleSessionEvent(state, event) ??
    handleMessageEvent(state, event) ??
    handleTurnEvent(state, event) ??
    handleDiffEvent(state, event) ??
    handleActivityEvent(state, event) ??
    handleDesignEvent(state, event) ??
    handleRevertEvent(state, event) ??
    handleNoopEvent(state, event) ??
    state
  );
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<ForgeEvent>,
): AppState {
  if (events.length === 0) {
    return state;
  }
  return events.reduce((nextState, event) => applyOrchestrationEvent(nextState, event), state);
}
