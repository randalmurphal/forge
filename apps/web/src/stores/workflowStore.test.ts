import type { WorkflowDefinition, WorkflowSummary } from "@forgetools/contracts";
import { ProjectId, WorkflowId, WorkflowPhaseId } from "@forgetools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));

import { getWsRpcClient } from "../wsRpcClient";
import {
  cacheWorkflowDefinitionState,
  initialWorkflowStoreState,
  setWorkflowEditingState,
  syncAvailableWorkflowState,
  useWorkflowStore,
  workflowListQueryOptions,
  workflowQueryKeys,
  workflowQueryOptions,
} from "./workflowStore";

const getWsRpcClientMock = vi.mocked(getWsRpcClient);

function makeWorkflowSummary(
  workflowId: string,
  overrides: Partial<WorkflowSummary> = {},
): WorkflowSummary {
  return {
    workflowId: WorkflowId.makeUnsafe(workflowId),
    name: `${workflowId}-name`,
    description: `${workflowId} description`,
    builtIn: true,
    ...overrides,
  };
}

function makeWorkflowDefinition(
  workflowId: string,
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: WorkflowId.makeUnsafe(workflowId),
    name: `${workflowId}-name`,
    description: `${workflowId} description`,
    builtIn: true,
    phases: [
      {
        id: WorkflowPhaseId.makeUnsafe(`${workflowId}-phase-1`),
        name: "Implement",
        type: "single-agent",
        agent: {
          prompt: "Implement the requested change.",
          output: { type: "conversation" },
        },
        gate: {
          after: "done",
          onFail: "stop",
          maxRetries: 0,
        },
      },
    ],
    createdAt: "2026-04-06T00:00:00.000Z",
    updatedAt: "2026-04-06T00:00:00.000Z",
    ...overrides,
  };
}

function resetWorkflowStore() {
  useWorkflowStore.setState(initialWorkflowStoreState);
}

beforeEach(() => {
  resetWorkflowStore();
  vi.resetAllMocks();
});

describe("workflow store state helpers", () => {
  it("syncs fetched workflows and clears an invalid selection", () => {
    const selectedWorkflowId = WorkflowId.makeUnsafe("workflow-2");
    const next = syncAvailableWorkflowState(
      {
        ...initialWorkflowStoreState,
        selectedWorkflowId,
      },
      [makeWorkflowSummary("workflow-1")],
    );

    expect(next.availableWorkflows).toEqual([makeWorkflowSummary("workflow-1")]);
    expect(next.selectedWorkflowId).toBeNull();
  });

  it("caches fetched workflow definitions by id", () => {
    const workflow = makeWorkflowDefinition("workflow-1");
    const next = cacheWorkflowDefinitionState(initialWorkflowStoreState, workflow);

    expect(next.workflowsById[workflow.id]).toEqual(workflow);
  });

  it("tracks workflow editing state with project scope", () => {
    const workflow = makeWorkflowDefinition("workflow-edit");
    const projectId = ProjectId.makeUnsafe("project-1");

    const next = setWorkflowEditingState(initialWorkflowStoreState, {
      workflowId: workflow.id,
      draft: workflow,
      scope: "project",
      projectId,
      dirty: true,
    });

    expect(next.editingWorkflowId).toBe(workflow.id);
    expect(next.editingWorkflowDraft).toEqual(workflow);
    expect(next.editingScope).toBe("project");
    expect(next.editingProjectId).toBe(projectId);
    expect(next.editingDirty).toBe(true);
  });
});

describe("useWorkflowStore actions", () => {
  it("updates workflow selection state", () => {
    const workflowId = WorkflowId.makeUnsafe("workflow-selected");

    useWorkflowStore.getState().setSelectedWorkflowId(workflowId);
    expect(useWorkflowStore.getState().selectedWorkflowId).toBe(workflowId);

    useWorkflowStore.getState().setSelectedWorkflowId(null);
    expect(useWorkflowStore.getState().selectedWorkflowId).toBeNull();
  });

  it("updates available workflows from fetched data", () => {
    const workflows = [makeWorkflowSummary("workflow-1"), makeWorkflowSummary("workflow-2")];

    useWorkflowStore.getState().setAvailableWorkflows(workflows);

    expect(useWorkflowStore.getState().availableWorkflows).toEqual(workflows);
  });
});

describe("workflow query options", () => {
  it("fetches the workflow list with a typed array result", async () => {
    const workflows = [makeWorkflowSummary("workflow-1"), makeWorkflowSummary("workflow-2")];
    getWsRpcClientMock.mockReturnValue({
      workflow: {
        list: vi.fn().mockResolvedValue({ workflows }),
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as ReturnType<typeof getWsRpcClient>);

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(workflowListQueryOptions());
    const typedResult: ReadonlyArray<WorkflowSummary> = result;

    expect(typedResult).toEqual(workflows);
    expect(getWsRpcClientMock().workflow.list).toHaveBeenCalledWith();
  });

  it("fetches a single workflow with a typed definition result", async () => {
    const workflow = makeWorkflowDefinition("workflow-1");
    const get = vi.fn().mockResolvedValue({ workflow });
    getWsRpcClientMock.mockReturnValue({
      workflow: {
        list: vi.fn(),
        get,
        create: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as ReturnType<typeof getWsRpcClient>);

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(workflowQueryOptions(workflow.id));
    const typedResult: WorkflowDefinition = result;

    expect(typedResult).toEqual(workflow);
    expect(get).toHaveBeenCalledWith({ workflowId: workflow.id });
  });

  it("scopes workflow detail queries by workflow id", () => {
    expect(workflowQueryKeys.detail(WorkflowId.makeUnsafe("workflow-1"))).not.toEqual(
      workflowQueryKeys.detail(WorkflowId.makeUnsafe("workflow-2")),
    );
  });
});
