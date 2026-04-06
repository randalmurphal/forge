import { type ThreadId } from "@forgetools/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  selectProjectById,
  selectSidebarThreadSummaryById,
  selectThreadById,
  selectThreadsByIds,
  useStore,
} from "./store";
import { type Project, type SidebarThreadSummary, type Thread } from "./types";

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
