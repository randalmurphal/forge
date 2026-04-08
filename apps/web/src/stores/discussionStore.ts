import type { DiscussionManagedSummary, DiscussionSummary, ProjectId } from "@forgetools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import { getWsRpcClient } from "../wsRpcClient";

const DEFAULT_STALE_TIME = 30_000;
export const ALL_PROJECTS_DISCUSSION_FILTER = "__all_projects__" as const;
export type DiscussionProjectFilter = ProjectId | typeof ALL_PROJECTS_DISCUSSION_FILTER;

export const discussionQueryKeys = {
  all: ["discussions"] as const,
  list: (workspaceRoot?: string) => ["discussions", "list", workspaceRoot ?? "global"] as const,
  detail: (name: string | null, workspaceRoot?: string) =>
    ["discussions", "detail", name, workspaceRoot ?? "global"] as const,
  managedList: (workspaceRoot?: string) =>
    ["discussions", "managed-list", workspaceRoot ?? "global"] as const,
  managedDetail: (
    scope: "global" | "project" | null,
    name: string | null,
    workspaceRoot?: string,
  ) => ["discussions", "managed-detail", scope, name, workspaceRoot ?? "global"] as const,
};

export interface DiscussionStoreState {
  availableDiscussions: ReadonlyArray<DiscussionSummary>;
  availableManagedDiscussions: ReadonlyArray<DiscussionManagedSummary>;
  managedProjectFilter: DiscussionProjectFilter;
  setAvailableDiscussions: (discussions: ReadonlyArray<DiscussionSummary>) => void;
  setAvailableManagedDiscussions: (discussions: ReadonlyArray<DiscussionManagedSummary>) => void;
  setManagedProjectFilter: (projectFilter: DiscussionProjectFilter) => void;
}

export const useDiscussionStore = create<DiscussionStoreState>((set) => ({
  availableDiscussions: [],
  availableManagedDiscussions: [],
  managedProjectFilter: ALL_PROJECTS_DISCUSSION_FILTER,
  setAvailableDiscussions: (discussions) => set({ availableDiscussions: discussions }),
  setAvailableManagedDiscussions: (discussions) =>
    set({ availableManagedDiscussions: discussions }),
  setManagedProjectFilter: (managedProjectFilter) => set({ managedProjectFilter }),
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

export function discussionManagedListQueryOptions(workspaceRoot?: string) {
  return queryOptions({
    queryKey: discussionQueryKeys.managedList(workspaceRoot),
    queryFn: async () =>
      (await getWsRpcClient().discussion.listManaged({ workspaceRoot })).discussions,
    staleTime: DEFAULT_STALE_TIME,
    placeholderData: (previous) => previous ?? [],
  });
}

export function discussionManagedDetailQueryOptions(input: {
  scope: "global" | "project" | null;
  name: string | null;
  workspaceRoot?: string;
}) {
  return queryOptions({
    queryKey: discussionQueryKeys.managedDetail(input.scope, input.name, input.workspaceRoot),
    queryFn: async () => {
      if (!input.name || !input.scope) {
        throw new Error("Discussion scope and name are required.");
      }
      return (
        await getWsRpcClient().discussion.getManaged({
          name: input.name,
          scope: input.scope,
          workspaceRoot: input.workspaceRoot,
        })
      ).discussion;
    },
    enabled: input.name !== null && input.scope !== null,
    staleTime: DEFAULT_STALE_TIME,
  });
}

export function useManagedDiscussions(workspaceRoot?: string) {
  const setAvailableManagedDiscussions = useDiscussionStore(
    (s) => s.setAvailableManagedDiscussions,
  );
  const query = useQuery(discussionManagedListQueryOptions(workspaceRoot));

  useEffect(() => {
    if (query.data) {
      setAvailableManagedDiscussions(query.data);
    }
  }, [query.data, setAvailableManagedDiscussions]);

  return query;
}

export function useManagedDiscussion(input: {
  scope: "global" | "project" | null;
  name: string | null;
  workspaceRoot?: string;
}) {
  return useQuery(discussionManagedDetailQueryOptions(input));
}
