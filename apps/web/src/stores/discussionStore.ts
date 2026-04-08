import type { DiscussionSummary } from "@forgetools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import { getWsRpcClient } from "../wsRpcClient";

const DEFAULT_STALE_TIME = 30_000;

export const discussionQueryKeys = {
  all: ["discussions"] as const,
  list: (workspaceRoot?: string) => ["discussions", "list", workspaceRoot ?? "global"] as const,
  detail: (name: string | null, workspaceRoot?: string) =>
    ["discussions", "detail", name, workspaceRoot ?? "global"] as const,
};

export interface DiscussionStoreState {
  availableDiscussions: ReadonlyArray<DiscussionSummary>;
  setAvailableDiscussions: (discussions: ReadonlyArray<DiscussionSummary>) => void;
}

export const useDiscussionStore = create<DiscussionStoreState>((set) => ({
  availableDiscussions: [],
  setAvailableDiscussions: (discussions) => set({ availableDiscussions: discussions }),
}));

export function discussionListQueryOptions(workspaceRoot?: string) {
  return queryOptions({
    queryKey: discussionQueryKeys.list(workspaceRoot),
    queryFn: async () => (await getWsRpcClient().discussion.list({ workspaceRoot })).discussions,
    staleTime: DEFAULT_STALE_TIME,
    placeholderData: (previous) => previous ?? [],
  });
}

export function discussionDetailQueryOptions(name: string | null, workspaceRoot?: string) {
  return queryOptions({
    queryKey: discussionQueryKeys.detail(name, workspaceRoot),
    queryFn: async () => {
      if (!name) {
        throw new Error("Discussion name is required.");
      }
      return (await getWsRpcClient().discussion.get({ name, workspaceRoot })).discussion;
    },
    enabled: name !== null,
    staleTime: DEFAULT_STALE_TIME,
  });
}

export function useDiscussions(workspaceRoot?: string) {
  const setAvailableDiscussions = useDiscussionStore((s) => s.setAvailableDiscussions);
  const query = useQuery(discussionListQueryOptions(workspaceRoot));

  useEffect(() => {
    if (query.data) {
      setAvailableDiscussions(query.data);
    }
  }, [query.data, setAvailableDiscussions]);

  return query;
}

export function useDiscussion(name: string | null, workspaceRoot?: string) {
  return useQuery(discussionDetailQueryOptions(name, workspaceRoot));
}
