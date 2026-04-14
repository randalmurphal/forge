import { type ThreadId } from "@forgetools/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectById,
  selectSidebarThreadSummaryById,
  selectStreamingMessageByThreadId,
  selectThreadById,
  selectThreadDesignById,
  selectThreadDiffsById,
  selectThreadPlansById,
  selectThreadSessionById,
  selectThreadsByIds,
  useStore,
} from "./store";
import type {
  ChatMessage,
  Project,
  SidebarThreadSummary,
  Thread,
  ThreadDesignSlice,
  ThreadDiffsSlice,
  ThreadPlansSlice,
  ThreadSessionSlice,
} from "./types";

export function useProjectById(projectId: Project["id"] | null | undefined): Project | undefined {
  const selector = useMemo(() => selectProjectById(projectId), [projectId]);
  return useStore(selector);
}

export function useThreadById(threadId: ThreadId | null | undefined): Thread | undefined {
  const selector = useMemo(() => selectThreadById(threadId), [threadId]);
  return useStore(selector);
}

export function useSidebarThreadSummaryById(
  threadId: ThreadId | null | undefined,
): SidebarThreadSummary | undefined {
  const selector = useMemo(() => selectSidebarThreadSummaryById(threadId), [threadId]);
  return useStore(selector);
}

export function useThreadsByIds(
  threadIds: readonly ThreadId[] | null | undefined,
): readonly Thread[] {
  const baseSelector = useMemo(() => selectThreadsByIds(threadIds), [threadIds]);
  const selector = useShallow(baseSelector);
  return useStore(selector);
}

// ── Per-thread slice hooks ────────────────────────────────────────────
// These let components subscribe to only the thread data they need,
// preventing cross-concern re-render cascades.

export function useThreadSession(
  threadId: ThreadId | null | undefined,
): ThreadSessionSlice | undefined {
  const selector = useMemo(() => selectThreadSessionById(threadId), [threadId]);
  return useStore(selector);
}

export function useThreadDiffs(
  threadId: ThreadId | null | undefined,
): ThreadDiffsSlice | undefined {
  const selector = useMemo(() => selectThreadDiffsById(threadId), [threadId]);
  return useStore(selector);
}

export function useThreadPlans(
  threadId: ThreadId | null | undefined,
): ThreadPlansSlice | undefined {
  const selector = useMemo(() => selectThreadPlansById(threadId), [threadId]);
  return useStore(selector);
}

export function useThreadDesign(
  threadId: ThreadId | null | undefined,
): ThreadDesignSlice | undefined {
  const selector = useMemo(() => selectThreadDesignById(threadId), [threadId]);
  return useStore(selector);
}

export function useStreamingMessage(
  threadId: ThreadId | null | undefined,
): ChatMessage | undefined {
  const selector = useMemo(() => selectStreamingMessageByThreadId(threadId), [threadId]);
  return useStore(selector);
}
