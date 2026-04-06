import type {
  ProjectId,
  WorkflowDefinition,
  WorkflowId,
  WorkflowSummary,
} from "@forgetools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import { getWsRpcClient } from "../wsRpcClient";

export type WorkflowEditScope = "global" | "project";

type WorkflowDefinitionMap = Partial<Record<WorkflowId, WorkflowDefinition>>;

export interface WorkflowStoreSnapshot {
  availableWorkflows: WorkflowSummary[];
  workflowsById: WorkflowDefinitionMap;
  selectedWorkflowId: WorkflowId | null;
  editingWorkflowId: WorkflowId | null;
  editingWorkflowDraft: WorkflowDefinition | null;
  editingScope: WorkflowEditScope;
  editingProjectId: ProjectId | null;
  editingDirty: boolean;
}

export interface WorkflowEditingStateInput {
  workflowId: WorkflowId | null;
  draft: WorkflowDefinition | null;
  scope?: WorkflowEditScope;
  projectId?: ProjectId | null;
  dirty?: boolean;
}

export interface WorkflowStoreState extends WorkflowStoreSnapshot {
  setAvailableWorkflows: (workflows: readonly WorkflowSummary[]) => void;
  cacheWorkflow: (workflow: WorkflowDefinition) => void;
  setSelectedWorkflowId: (workflowId: WorkflowId | null) => void;
  setEditingState: (input: WorkflowEditingStateInput) => void;
  setEditingDraft: (draft: WorkflowDefinition | null, options?: { dirty?: boolean }) => void;
  resetEditingState: () => void;
}

const DEFAULT_WORKFLOW_STALE_TIME = 30_000;

export const workflowQueryKeys = {
  all: ["workflows"] as const,
  list: () => ["workflows", "list"] as const,
  detail: (workflowId: WorkflowId | null) => ["workflows", "detail", workflowId] as const,
};

export const initialWorkflowStoreState: WorkflowStoreSnapshot = {
  availableWorkflows: [],
  workflowsById: {},
  selectedWorkflowId: null,
  editingWorkflowId: null,
  editingWorkflowDraft: null,
  editingScope: "global",
  editingProjectId: null,
  editingDirty: false,
};

function workflowSummariesEqual(
  left: readonly WorkflowSummary[],
  right: readonly WorkflowSummary[],
): boolean {
  return (
    left.length === right.length &&
    left.every((workflow, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        candidate.workflowId === workflow.workflowId &&
        candidate.name === workflow.name &&
        candidate.description === workflow.description &&
        candidate.builtIn === workflow.builtIn
      );
    })
  );
}

function workflowDefinitionsEqual(
  left: WorkflowDefinition | null,
  right: WorkflowDefinition | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function workflowDefinitionMapsEqual(
  left: WorkflowDefinitionMap,
  right: WorkflowDefinitionMap,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([workflowId, workflow]) =>
    workflowDefinitionsEqual(workflow ?? null, right[workflowId as WorkflowId] ?? null),
  );
}

export function syncAvailableWorkflowState(
  state: WorkflowStoreSnapshot,
  workflows: readonly WorkflowSummary[],
): WorkflowStoreSnapshot {
  const nextAvailableWorkflows = [...workflows];
  const selectedWorkflowStillExists =
    state.selectedWorkflowId === null ||
    nextAvailableWorkflows.some((workflow) => workflow.workflowId === state.selectedWorkflowId);
  const nextSelectedWorkflowId = selectedWorkflowStillExists ? state.selectedWorkflowId : null;

  if (
    workflowSummariesEqual(state.availableWorkflows, nextAvailableWorkflows) &&
    state.selectedWorkflowId === nextSelectedWorkflowId
  ) {
    return state;
  }

  return {
    ...state,
    availableWorkflows: nextAvailableWorkflows,
    selectedWorkflowId: nextSelectedWorkflowId,
  };
}

export function cacheWorkflowDefinitionState(
  state: WorkflowStoreSnapshot,
  workflow: WorkflowDefinition,
): WorkflowStoreSnapshot {
  const nextWorkflowsById = {
    ...state.workflowsById,
    [workflow.id]: workflow,
  };

  if (workflowDefinitionMapsEqual(state.workflowsById, nextWorkflowsById)) {
    return state;
  }

  return {
    ...state,
    workflowsById: nextWorkflowsById,
  };
}

export function setWorkflowEditingState(
  state: WorkflowStoreSnapshot,
  input: WorkflowEditingStateInput,
): WorkflowStoreSnapshot {
  const nextScope = input.scope ?? "global";
  const nextProjectId = nextScope === "project" ? (input.projectId ?? null) : null;
  const nextDirty = input.dirty ?? false;

  if (
    state.editingWorkflowId === input.workflowId &&
    workflowDefinitionsEqual(state.editingWorkflowDraft, input.draft) &&
    state.editingScope === nextScope &&
    state.editingProjectId === nextProjectId &&
    state.editingDirty === nextDirty
  ) {
    return state;
  }

  return {
    ...state,
    editingWorkflowId: input.workflowId,
    editingWorkflowDraft: input.draft,
    editingScope: nextScope,
    editingProjectId: nextProjectId,
    editingDirty: nextDirty,
  };
}

export function workflowListQueryOptions() {
  return queryOptions({
    queryKey: workflowQueryKeys.list(),
    queryFn: async () => (await getWsRpcClient().workflow.list()).workflows,
    staleTime: DEFAULT_WORKFLOW_STALE_TIME,
    placeholderData: (previous) => previous ?? [],
  });
}

export function workflowQueryOptions(workflowId: WorkflowId | null) {
  return queryOptions({
    queryKey: workflowQueryKeys.detail(workflowId),
    queryFn: async () => {
      if (!workflowId) {
        throw new Error("Workflow is unavailable.");
      }
      return (await getWsRpcClient().workflow.get({ workflowId })).workflow;
    },
    enabled: workflowId !== null,
    staleTime: DEFAULT_WORKFLOW_STALE_TIME,
  });
}

export const useWorkflowStore = create<WorkflowStoreState>((set) => ({
  ...initialWorkflowStoreState,
  setAvailableWorkflows: (workflows) =>
    set((state) => syncAvailableWorkflowState(state, workflows)),
  cacheWorkflow: (workflow) => set((state) => cacheWorkflowDefinitionState(state, workflow)),
  setSelectedWorkflowId: (workflowId) =>
    set((state) =>
      state.selectedWorkflowId === workflowId
        ? state
        : { ...state, selectedWorkflowId: workflowId },
    ),
  setEditingState: (input) => set((state) => setWorkflowEditingState(state, input)),
  setEditingDraft: (draft, options) =>
    set((state) =>
      setWorkflowEditingState(state, {
        workflowId: state.editingWorkflowId,
        draft,
        scope: state.editingScope,
        projectId: state.editingProjectId,
        dirty: options?.dirty ?? true,
      }),
    ),
  resetEditingState: () =>
    set((state) =>
      setWorkflowEditingState(state, {
        workflowId: null,
        draft: null,
        scope: "global",
        projectId: null,
        dirty: false,
      }),
    ),
}));

export function useWorkflows() {
  const setAvailableWorkflows = useWorkflowStore((state) => state.setAvailableWorkflows);
  const query = useQuery(workflowListQueryOptions());

  useEffect(() => {
    if (query.data) {
      setAvailableWorkflows(query.data);
    }
  }, [query.data, setAvailableWorkflows]);

  return query;
}

export function useWorkflow(workflowId: WorkflowId | null) {
  const cacheWorkflow = useWorkflowStore((state) => state.cacheWorkflow);
  const query = useQuery(workflowQueryOptions(workflowId));

  useEffect(() => {
    if (query.data) {
      cacheWorkflow(query.data);
    }
  }, [cacheWorkflow, query.data]);

  return query;
}
