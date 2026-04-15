import { ThreadId } from "@forgetools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "./useHandleNewThread";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { toastManager } from "../components/ui/toast";
import { useSettings } from "./useSettings";

export function useThreadActions() {
  const appSettings = useSettings();
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));

  const archiveThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      const storeState = useStore.getState();
      const thread = storeState.threadsById[threadId];
      if (!thread) return;
      const sessionSlice = storeState.threadSessionById[threadId];
      if (
        sessionSlice?.session?.status === "running" &&
        sessionSlice.session.activeTurnId != null
      ) {
        throw new Error("Cannot archive a running thread.");
      }

      await api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId,
      });

      if (routeThreadId === threadId) {
        await handleNewThread(thread.projectId);
      }
    },
    [handleNewThread, routeThreadId],
  );

  const unarchiveThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId,
    });
  }, []);

  const pinThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.pin",
      commandId: newCommandId(),
      threadId,
    });
  }, []);

  const unpinThread = useCallback(async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unpin",
      commandId: newCommandId(),
      threadId,
    });
  }, []);

  const deleteThread = useCallback(
    async (threadId: ThreadId, opts: { deletedThreadIds?: ReadonlySet<ThreadId> } = {}) => {
      const api = readNativeApi();
      if (!api) return;
      const { projectsById, threads, threadsById } = useStore.getState();
      const thread = threadsById[threadId];
      if (!thread) return;
      const threadProject = projectsById[thread.projectId];
      const deletedIds = opts.deletedThreadIds;
      const childIds = new Set(thread.childThreadIds ?? []);
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter(
              (entry) =>
                entry.id === threadId || (!deletedIds.has(entry.id) && !childIds.has(entry.id)),
            )
          : threads.filter((entry) => entry.id === threadId || !childIds.has(entry.id));
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      const deleteSessionSlice = useStore.getState().threadSessionById[threadId];
      if (deleteSessionSlice?.session && deleteSessionSlice.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed.
      }

      const deletedThreadIds = opts.deletedThreadIds ?? new Set<ThreadId>();
      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadId,
        deletedThreadIds,
        sortOrder: appSettings.sidebarThreadSortOrder,
      });
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to delete thread",
          description: error instanceof Error ? error.message : "Unknown error",
        });
        return;
      }
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);

      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          await navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      appSettings.sidebarThreadSortOrder,
      navigate,
      removeWorktreeMutation,
      routeThreadId,
    ],
  );

  const forkThread = useCallback(
    async (sourceThreadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      const sourceThread = useStore.getState().threadsById[sourceThreadId];
      if (!sourceThread) return;

      const forkId = newThreadId();
      await api.orchestration.dispatchCommand({
        type: "thread.fork",
        commandId: newCommandId(),
        sourceThreadId,
        newThreadId: forkId,
      });

      await navigate({
        to: "/$threadId",
        params: { threadId: forkId },
      });
    },
    [navigate],
  );

  const confirmAndDeleteThread = useCallback(
    async (threadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = useStore.getState().threadsById[threadId];
      if (!thread) return;

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await deleteThread(threadId);
    },
    [appSettings.confirmThreadDelete, deleteThread],
  );

  return {
    archiveThread,
    unarchiveThread,
    pinThread,
    unpinThread,
    deleteThread,
    confirmAndDeleteThread,
    forkThread,
  };
}
