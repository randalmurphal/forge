import type {
  WorkflowBootstrapEvent,
  WorkflowDefinition,
  WorkflowGateEvent,
  WorkflowPhaseEvent,
  WorkflowQualityCheckEvent,
  WorkflowSummary,
} from "@forgetools/contracts";
import {
  PhaseRunId,
  ProjectId,
  ThreadId,
  WorkflowId,
  WorkflowPhaseId,
} from "@forgetools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));

import { getWsRpcClient } from "../wsRpcClient";
import {
  applyWorkflowPushEventState,
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

function makeWorkflowPhaseEvent(overrides: Partial<WorkflowPhaseEvent> = {}): WorkflowPhaseEvent {
  return {
    channel: "workflow.phase",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
    event: "completed",
    phaseInfo: {
      phaseId: WorkflowPhaseId.makeUnsafe("workflow-phase-1"),
      phaseName: "Implement",
      phaseType: "single-agent",
      iteration: 1,
    },
    outputs: [
      {
        key: "output",
        content: "Completed output",
        sourceType: "conversation",
      },
    ],
    timestamp: "2026-04-06T00:00:10.000Z",
    ...overrides,
  };
}

function makeWorkflowQualityCheckEvent(
  overrides: Partial<WorkflowQualityCheckEvent> = {},
): WorkflowQualityCheckEvent {
  return {
    channel: "workflow.quality-check",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
    checkName: "typecheck",
    status: "running",
    timestamp: "2026-04-06T00:00:11.000Z",
    ...overrides,
  };
}

function makeWorkflowBootstrapEvent(
  overrides: Partial<WorkflowBootstrapEvent> = {},
): WorkflowBootstrapEvent {
  return {
    channel: "workflow.bootstrap",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    event: "output",
    data: "Bootstrapping workspace",
    timestamp: "2026-04-06T00:00:12.000Z",
    ...overrides,
  };
}

function makeWorkflowGateEvent(overrides: Partial<WorkflowGateEvent> = {}): WorkflowGateEvent {
  return {
    channel: "workflow.gate",
    threadId: ThreadId.makeUnsafe("thread-workflow"),
    phaseRunId: PhaseRunId.makeUnsafe("phase-run-1"),
    gateType: "human-approval",
    status: "waiting-human",
    requestId: "interactive-request-1" as WorkflowGateEvent["requestId"],
    timestamp: "2026-04-06T00:00:13.000Z",
    ...overrides,
  };
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

  it("records workflow phase push events and caches emitted outputs by phase run", () => {
    const event = makeWorkflowPhaseEvent();

    const next = applyWorkflowPushEventState(initialWorkflowStoreState, event);
    const runtime = next.runtimeByThreadId[event.threadId];

    expect(runtime?.phaseEventsByPhaseRunId[event.phaseRunId]).toEqual(event);
    expect(runtime?.phaseOutputsByPhaseRunId[event.phaseRunId]).toEqual(event.outputs);
  });

  it("replaces prior quality-check state for the same check name", () => {
    const runningEvent = makeWorkflowQualityCheckEvent();
    const completedEvent = makeWorkflowQualityCheckEvent({
      status: "failed",
      output: "src/file.ts:4 error TS2322",
      timestamp: "2026-04-06T00:00:14.000Z",
    });

    const seeded = applyWorkflowPushEventState(initialWorkflowStoreState, runningEvent);
    const next = applyWorkflowPushEventState(seeded, completedEvent);

    expect(next.runtimeByThreadId[runningEvent.threadId]?.qualityChecksByPhaseRunId).toEqual({
      [runningEvent.phaseRunId]: [completedEvent],
    });
  });

  it("tracks latest bootstrap and gate events per workflow thread", () => {
    const bootstrapStartedEvent = makeWorkflowBootstrapEvent({
      event: "started",
      data: undefined,
      timestamp: "2026-04-06T00:00:12.000Z",
    });
    const bootstrapOutputEvent = makeWorkflowBootstrapEvent({
      event: "output",
      data: "Installing dependencies...\n",
      timestamp: "2026-04-06T00:00:13.000Z",
    });
    const gateEvent = makeWorkflowGateEvent();

    const withBootstrapStarted = applyWorkflowPushEventState(
      initialWorkflowStoreState,
      bootstrapStartedEvent,
    );
    const withBootstrapOutput = applyWorkflowPushEventState(
      withBootstrapStarted,
      bootstrapOutputEvent,
    );
    const next = applyWorkflowPushEventState(withBootstrapOutput, gateEvent);
    const runtime = next.runtimeByThreadId[bootstrapStartedEvent.threadId];

    expect(runtime?.bootstrapEvents).toEqual([bootstrapStartedEvent, bootstrapOutputEvent]);
    expect(runtime?.latestBootstrapEvent).toEqual(bootstrapOutputEvent);
    expect(runtime?.gateEventsByPhaseRunId[gateEvent.phaseRunId]).toEqual(gateEvent);
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

  it("applies workflow push events through the store action", () => {
    const event = makeWorkflowPhaseEvent({
      event: "started",
      outputs: undefined,
    });

    useWorkflowStore.getState().applyWorkflowPushEvent(event);

    expect(
      useWorkflowStore.getState().runtimeByThreadId[event.threadId]?.phaseEventsByPhaseRunId[
        event.phaseRunId
      ],
    ).toEqual(event);
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
