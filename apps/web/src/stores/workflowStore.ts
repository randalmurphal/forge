import type {
  PhaseOutputEntry,
  PhaseRunId,
  ThreadId,
  WorkflowBootstrapEvent,
  ProjectId,
  WorkflowGateEvent,
  WorkflowDefinition,
  WorkflowId,
  WorkflowPhaseEvent,
  WorkflowPushEvent,
  WorkflowQualityCheckEvent,
  WorkflowSummary,
} from "@forgetools/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import { getWsRpcClient } from "../wsRpcClient";

export type WorkflowEditScope = "global" | "project";

type WorkflowDefinitionMap = Partial<Record<WorkflowId, WorkflowDefinition>>;
type WorkflowThreadRuntimeMap = Partial<Record<ThreadId, WorkflowThreadRuntimeState>>;

type WorkflowPhaseEventMap = Partial<Record<PhaseRunId, WorkflowPhaseEvent>>;
type WorkflowQualityCheckMap = Partial<Record<PhaseRunId, WorkflowQualityCheckEvent[]>>;
type WorkflowGateEventMap = Partial<Record<PhaseRunId, WorkflowGateEvent>>;
type WorkflowPhaseOutputMap = Partial<Record<PhaseRunId, PhaseOutputEntry[]>>;

export interface WorkflowThreadRuntimeState {
  phaseEventsByPhaseRunId: WorkflowPhaseEventMap;
  phaseOutputsByPhaseRunId: WorkflowPhaseOutputMap;
  qualityChecksByPhaseRunId: WorkflowQualityCheckMap;
  gateEventsByPhaseRunId: WorkflowGateEventMap;
  bootstrapEvents: WorkflowBootstrapEvent[];
  latestBootstrapEvent: WorkflowBootstrapEvent | null;
}

export interface WorkflowStoreSnapshot {
  availableWorkflows: WorkflowSummary[];
  workflowsById: WorkflowDefinitionMap;
  runtimeByThreadId: WorkflowThreadRuntimeMap;
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

export interface WorkflowEditingMetadataInput {
  scope?: WorkflowEditScope;
  projectId?: ProjectId | null;
  dirty?: boolean;
}

export interface WorkflowStoreState extends WorkflowStoreSnapshot {
  setAvailableWorkflows: (workflows: readonly WorkflowSummary[]) => void;
  cacheWorkflow: (workflow: WorkflowDefinition) => void;
  applyWorkflowPushEvent: (event: WorkflowPushEvent) => void;
  setSelectedWorkflowId: (workflowId: WorkflowId | null) => void;
  setEditingState: (input: WorkflowEditingStateInput) => void;
  setEditingMetadata: (input: WorkflowEditingMetadataInput) => void;
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
  runtimeByThreadId: {},
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
        candidate.builtIn === workflow.builtIn &&
        candidate.projectId === workflow.projectId
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

function workflowPushEventsEqual<TEvent extends { timestamp: string }>(
  left: TEvent | null | undefined,
  right: TEvent | null,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right);
}

function workflowPushEventListsEqual<TEvent extends { timestamp: string }>(
  left: readonly TEvent[] | undefined,
  right: readonly TEvent[],
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right);
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

function workflowThreadRuntimeStateEquals(
  left: WorkflowThreadRuntimeState | undefined,
  right: WorkflowThreadRuntimeState,
): boolean {
  return (
    JSON.stringify(left?.phaseEventsByPhaseRunId ?? {}) ===
      JSON.stringify(right.phaseEventsByPhaseRunId) &&
    JSON.stringify(left?.phaseOutputsByPhaseRunId ?? {}) ===
      JSON.stringify(right.phaseOutputsByPhaseRunId) &&
    JSON.stringify(left?.qualityChecksByPhaseRunId ?? {}) ===
      JSON.stringify(right.qualityChecksByPhaseRunId) &&
    JSON.stringify(left?.gateEventsByPhaseRunId ?? {}) ===
      JSON.stringify(right.gateEventsByPhaseRunId) &&
    JSON.stringify(left?.bootstrapEvents ?? []) === JSON.stringify(right.bootstrapEvents) &&
    workflowPushEventsEqual(left?.latestBootstrapEvent, right.latestBootstrapEvent)
  );
}

function getEmptyWorkflowThreadRuntimeState(): WorkflowThreadRuntimeState {
  return {
    phaseEventsByPhaseRunId: {},
    phaseOutputsByPhaseRunId: {},
    qualityChecksByPhaseRunId: {},
    gateEventsByPhaseRunId: {},
    bootstrapEvents: [],
    latestBootstrapEvent: null,
  };
}

function mergeWorkflowQualityCheckEvents(
  current: readonly WorkflowQualityCheckEvent[],
  event: WorkflowQualityCheckEvent,
): WorkflowQualityCheckEvent[] {
  const next = [...current];
  const existingIndex = next.findIndex((entry) => entry.checkName === event.checkName);
  if (existingIndex >= 0) {
    next[existingIndex] = event;
  } else {
    next.push(event);
  }

  return next.toSorted((left, right) => {
    const checkNameComparison = left.checkName.localeCompare(right.checkName, undefined, {
      sensitivity: "base",
    });
    if (checkNameComparison !== 0) {
      return checkNameComparison;
    }
    return left.timestamp.localeCompare(right.timestamp);
  });
}

function mergeWorkflowBootstrapEvents(
  current: readonly WorkflowBootstrapEvent[],
  event: WorkflowBootstrapEvent,
): WorkflowBootstrapEvent[] {
  if (event.event === "started") {
    return [event];
  }

  if (
    current.some(
      (candidate) =>
        candidate.timestamp === event.timestamp &&
        candidate.event === event.event &&
        candidate.data === event.data &&
        candidate.error === event.error,
    )
  ) {
    return [...current];
  }

  return [...current, event].toSorted((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}

function updateWorkflowThreadRuntimeState(
  state: WorkflowStoreSnapshot,
  threadId: ThreadId,
  updater: (runtime: WorkflowThreadRuntimeState) => WorkflowThreadRuntimeState,
): WorkflowStoreSnapshot {
  const currentRuntime = state.runtimeByThreadId[threadId] ?? getEmptyWorkflowThreadRuntimeState();
  const nextRuntime = updater(currentRuntime);
  if (workflowThreadRuntimeStateEquals(state.runtimeByThreadId[threadId], nextRuntime)) {
    return state;
  }

  return {
    ...state,
    runtimeByThreadId: {
      ...state.runtimeByThreadId,
      [threadId]: nextRuntime,
    },
  };
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

export function applyWorkflowPushEventState(
  state: WorkflowStoreSnapshot,
  event: WorkflowPushEvent,
): WorkflowStoreSnapshot {
  return updateWorkflowThreadRuntimeState(state, event.threadId, (runtime) => {
    switch (event.channel) {
      case "workflow.phase": {
        const nextPhaseEventsByPhaseRunId = {
          ...runtime.phaseEventsByPhaseRunId,
          [event.phaseRunId]: event,
        };
        const nextPhaseOutputsByPhaseRunId =
          event.outputs === undefined
            ? runtime.phaseOutputsByPhaseRunId
            : {
                ...runtime.phaseOutputsByPhaseRunId,
                [event.phaseRunId]: [...event.outputs],
              };

        if (
          workflowPushEventsEqual(runtime.phaseEventsByPhaseRunId[event.phaseRunId], event) &&
          JSON.stringify(runtime.phaseOutputsByPhaseRunId[event.phaseRunId] ?? []) ===
            JSON.stringify(nextPhaseOutputsByPhaseRunId[event.phaseRunId] ?? [])
        ) {
          return runtime;
        }

        return {
          ...runtime,
          phaseEventsByPhaseRunId: nextPhaseEventsByPhaseRunId,
          phaseOutputsByPhaseRunId: nextPhaseOutputsByPhaseRunId,
        };
      }
      case "workflow.quality-check": {
        const nextQualityChecks = mergeWorkflowQualityCheckEvents(
          runtime.qualityChecksByPhaseRunId[event.phaseRunId] ?? [],
          event,
        );
        if (
          workflowPushEventListsEqual(
            runtime.qualityChecksByPhaseRunId[event.phaseRunId],
            nextQualityChecks,
          )
        ) {
          return runtime;
        }
        return {
          ...runtime,
          qualityChecksByPhaseRunId: {
            ...runtime.qualityChecksByPhaseRunId,
            [event.phaseRunId]: nextQualityChecks,
          },
        };
      }
      case "workflow.bootstrap":
        const nextBootstrapEvents = mergeWorkflowBootstrapEvents(runtime.bootstrapEvents, event);
        if (
          workflowPushEventsEqual(runtime.latestBootstrapEvent, event) &&
          workflowPushEventListsEqual(runtime.bootstrapEvents, nextBootstrapEvents)
        ) {
          return runtime;
        }
        return {
          ...runtime,
          bootstrapEvents: nextBootstrapEvents,
          latestBootstrapEvent: event,
        };
      case "workflow.gate":
        if (workflowPushEventsEqual(runtime.gateEventsByPhaseRunId[event.phaseRunId], event)) {
          return runtime;
        }
        return {
          ...runtime,
          gateEventsByPhaseRunId: {
            ...runtime.gateEventsByPhaseRunId,
            [event.phaseRunId]: event,
          },
        };
    }
  });
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

export function setWorkflowEditingMetadataState(
  state: WorkflowStoreSnapshot,
  input: WorkflowEditingMetadataInput,
): WorkflowStoreSnapshot {
  return setWorkflowEditingState(state, {
    workflowId: state.editingWorkflowId,
    draft: state.editingWorkflowDraft,
    scope: input.scope === undefined ? state.editingScope : input.scope,
    projectId: input.projectId === undefined ? state.editingProjectId : input.projectId,
    dirty: input.dirty === undefined ? state.editingDirty : input.dirty,
  });
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
  applyWorkflowPushEvent: (event) => set((state) => applyWorkflowPushEventState(state, event)),
  setSelectedWorkflowId: (workflowId) =>
    set((state) =>
      state.selectedWorkflowId === workflowId
        ? state
        : { ...state, selectedWorkflowId: workflowId },
    ),
  setEditingState: (input) => set((state) => setWorkflowEditingState(state, input)),
  setEditingMetadata: (input) => set((state) => setWorkflowEditingMetadataState(state, input)),
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
