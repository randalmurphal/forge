import type {
  WorkflowBootstrapEvent,
  WorkflowGateEvent,
  WorkflowPhaseEvent,
  WorkflowQualityCheckEvent,
  GateResult,
  PhaseRunId,
  PhaseRunStatus,
  PhaseType,
  QualityCheckResult,
  ThreadId,
  WorkflowDefinition,
  WorkflowPhase,
} from "@forgetools/contracts";
import type { Thread } from "../types";
import {
  deriveGateApprovalChangesSummary,
  deriveGateApprovalSummaryMarkdown,
  deriveGateApprovalUnresolvedItems,
  selectGateApprovalQualityChecks,
} from "./GateApproval.logic";

export interface WorkflowTimelinePhaseOutputRecord {
  outputKey: string;
  content: string;
  sourceType: string;
}

export interface WorkflowTimelineChannelMessage {
  speaker: string;
  content: string;
}

export interface WorkflowTimelineChildSession {
  threadId: Thread["id"];
  title: string;
  role: Thread["role"];
  provider: NonNullable<Thread["session"]>["provider"] | null;
  status: NonNullable<Thread["session"]>["status"] | null;
  updatedAt: string | undefined;
  messages: Thread["messages"];
}

export interface WorkflowTimelineRenderableSchemaOutput {
  kind: "schema";
  summaryMarkdown: string;
  structuredData: Record<string, unknown> | null;
  rawContent: string;
}

export interface WorkflowTimelineRenderableChannelOutput {
  kind: "channel";
  messages: WorkflowTimelineChannelMessage[];
  rawTranscript: string;
}

export interface WorkflowTimelineRenderableConversationOutput {
  kind: "conversation";
  markdown: string;
}

export interface WorkflowTimelineRenderableEmptyOutput {
  kind: "none";
}

export type WorkflowTimelineRenderableOutput =
  | WorkflowTimelineRenderableSchemaOutput
  | WorkflowTimelineRenderableChannelOutput
  | WorkflowTimelineRenderableConversationOutput
  | WorkflowTimelineRenderableEmptyOutput;

export interface WorkflowTimelinePhaseItem {
  phaseRunId: PhaseRunId;
  phaseId: WorkflowPhase["id"];
  phaseName: string;
  phaseType: PhaseType;
  iteration: number;
  status: PhaseRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  phase: WorkflowPhase | null;
  output: WorkflowTimelineRenderableOutput;
  qualityChecks: QualityCheckResult[];
  gateResult: GateResult | null;
  childSessions: WorkflowTimelineChildSession[];
  isActive: boolean;
}

export interface WorkflowTimelinePhasePresentation {
  gateQualityChecks: readonly QualityCheckResult[];
  gateSummaryMarkdown: string | null;
  gateUnresolvedItems: string[];
  gateChangesSummary: string[];
  phaseTransitionState: WorkflowTimelineTransitionState | null;
  shouldRenderGateApproval: boolean;
}

export interface WorkflowTimelineRuntimeState {
  phaseEventsByPhaseRunId: Partial<Record<PhaseRunId, WorkflowPhaseEvent>>;
  qualityChecksByPhaseRunId: Partial<Record<PhaseRunId, WorkflowQualityCheckEvent[]>>;
  gateEventsByPhaseRunId: Partial<Record<PhaseRunId, WorkflowGateEvent>>;
  bootstrapEvents: WorkflowBootstrapEvent[];
  latestBootstrapEvent: WorkflowBootstrapEvent | null;
}

interface WorkflowTimelineTransitionBase {
  anchorPhaseRunId: PhaseRunId | null;
  phaseName: string | null;
}

export interface WorkflowTimelineQualityChecksTransitionState extends WorkflowTimelineTransitionBase {
  kind: "quality-checks";
  checks: WorkflowQualityCheckEvent[];
}

export interface WorkflowTimelineWaitingHumanTransitionState extends WorkflowTimelineTransitionBase {
  kind: "waiting-human";
}

export interface WorkflowTimelinePhaseHandoffTransitionState extends WorkflowTimelineTransitionBase {
  kind: "phase-handoff";
  nextPhaseName: string;
}

export interface WorkflowTimelineBootstrapTransitionState extends WorkflowTimelineTransitionBase {
  kind: "bootstrap";
  nextPhaseName: string | null;
  status: "running" | "completed" | "failed" | "skipped";
  output: string;
  error: string | null;
}

export type WorkflowTimelineTransitionState =
  | WorkflowTimelineQualityChecksTransitionState
  | WorkflowTimelineWaitingHumanTransitionState
  | WorkflowTimelinePhaseHandoffTransitionState
  | WorkflowTimelineBootstrapTransitionState;

export interface WorkflowTimelineAutoNavigationThread {
  threadId: ThreadId;
  updatedAt: string | undefined;
}

export const workflowTimelineQueryKeys = {
  all: () => ["workflow-timeline"] as const,
  phaseRuns: (threadId: ThreadId) => ["workflow-timeline", "phase-runs", threadId] as const,
  phaseOutputPrefix: (phaseRunId: PhaseRunId) =>
    ["workflow-timeline", "phase-output", phaseRunId] as const,
  phaseOutput: (phaseRunId: PhaseRunId, outputKeys: readonly string[]) =>
    [...workflowTimelineQueryKeys.phaseOutputPrefix(phaseRunId), outputKeys.join("|")] as const,
};

interface WorkflowTimelinePhaseRun {
  phaseRunId: PhaseRunId;
  phaseId: WorkflowPhase["id"];
  phaseName: string;
  phaseType: PhaseType;
  iteration: number;
  status: PhaseRunStatus;
  gateResult: GateResult | null;
  qualityChecks: readonly QualityCheckResult[] | null;
  startedAt: string | null;
  completedAt: string | null;
}

function toSortableTimestamp(value: string | null | undefined): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function compareDescendingTimestamp(
  left: { timestamp: string },
  right: { timestamp: string },
): number {
  return toSortableTimestamp(right.timestamp) - toSortableTimestamp(left.timestamp);
}

function compareWorkflowTimelineRuns(
  left: WorkflowTimelinePhaseRun,
  right: WorkflowTimelinePhaseRun,
): number {
  const leftStartedAt = toSortableTimestamp(left.startedAt);
  const rightStartedAt = toSortableTimestamp(right.startedAt);
  if (leftStartedAt !== rightStartedAt) {
    return leftStartedAt - rightStartedAt;
  }

  const leftCompletedAt = toSortableTimestamp(left.completedAt);
  const rightCompletedAt = toSortableTimestamp(right.completedAt);
  if (leftCompletedAt !== rightCompletedAt) {
    return leftCompletedAt - rightCompletedAt;
  }

  if (left.iteration !== right.iteration) {
    return left.iteration - right.iteration;
  }

  return left.phaseRunId.localeCompare(right.phaseRunId);
}

function compareChildSessions(
  left: WorkflowTimelineChildSession,
  right: WorkflowTimelineChildSession,
): number {
  const leftRole = left.role ?? "";
  const rightRole = right.role ?? "";
  const roleComparison = leftRole.localeCompare(rightRole, undefined, { sensitivity: "base" });
  if (roleComparison !== 0) {
    return roleComparison;
  }

  const leftUpdatedAt = toSortableTimestamp(left.updatedAt);
  const rightUpdatedAt = toSortableTimestamp(right.updatedAt);
  if (leftUpdatedAt !== rightUpdatedAt) {
    return leftUpdatedAt - rightUpdatedAt;
  }

  return left.threadId.localeCompare(right.threadId);
}

function resolveWorkflowPhaseOutputMode(
  phase: WorkflowPhase | null,
  phaseType: PhaseType,
): "schema" | "channel" | "conversation" {
  if (phaseType === "multi-agent") {
    return "channel";
  }

  const configuredOutput = phase?.agent?.output?.type;
  if (configuredOutput === "schema" || configuredOutput === "channel") {
    return configuredOutput;
  }

  return "conversation";
}

function resolveLatestAssistantMessage(
  childSessions: readonly WorkflowTimelineChildSession[],
): string | null {
  const newestChildSessions = [...childSessions].toSorted((left, right) => {
    const byUpdatedAt = toSortableTimestamp(right.updatedAt) - toSortableTimestamp(left.updatedAt);
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }
    return right.threadId.localeCompare(left.threadId);
  });

  for (const childSession of newestChildSessions) {
    for (let index = childSession.messages.length - 1; index >= 0; index -= 1) {
      const message = childSession.messages[index];
      if (message?.role === "assistant" && message.text.trim().length > 0) {
        return message.text;
      }
    }
  }

  return null;
}

function selectLatestEvent<TEvent extends { timestamp: string }>(
  events: readonly TEvent[],
): TEvent | null {
  return [...events].toSorted(compareDescendingTimestamp)[0] ?? null;
}

function compactEvents<TEvent>(events: ReadonlyArray<TEvent | undefined>): TEvent[] {
  return events.filter((event): event is TEvent => event !== undefined);
}

function resolvePhaseMetadata(input: {
  phaseRunId: PhaseRunId | null;
  timeline: readonly WorkflowTimelinePhaseItem[];
  runtime: WorkflowTimelineRuntimeState | null;
}): { phaseId: WorkflowPhase["id"] | null; phaseName: string | null } {
  if (input.phaseRunId === null) {
    return { phaseId: null, phaseName: null };
  }

  const timelineItem = input.timeline.find(
    (candidate) => candidate.phaseRunId === input.phaseRunId,
  );
  if (timelineItem) {
    return {
      phaseId: timelineItem.phaseId,
      phaseName: timelineItem.phaseName,
    };
  }

  const phaseEvent = input.runtime?.phaseEventsByPhaseRunId[input.phaseRunId];
  return {
    phaseId: phaseEvent?.phaseInfo.phaseId ?? null,
    phaseName: phaseEvent?.phaseInfo.phaseName ?? null,
  };
}

function resolveNextWorkflowPhase(
  workflow: WorkflowDefinition | null,
  phaseId: WorkflowPhase["id"] | null,
): WorkflowPhase | null {
  if (workflow === null || phaseId === null) {
    return null;
  }

  const phaseIndex = workflow.phases.findIndex((phase) => phase.id === phaseId);
  if (phaseIndex < 0) {
    return null;
  }

  return workflow.phases[phaseIndex + 1] ?? null;
}

function buildBootstrapOutput(events: readonly WorkflowBootstrapEvent[]): string {
  return events
    .map((event) => event.data ?? "")
    .filter((chunk) => chunk.length > 0)
    .join("");
}

function runtimeQualityChecksToResults(
  qualityChecks: readonly WorkflowQualityCheckEvent[],
): QualityCheckResult[] {
  return qualityChecks
    .filter((check) => check.status !== "running")
    .map((check): QualityCheckResult => {
      if (check.output) {
        return {
          check: check.checkName,
          passed: check.status === "passed",
          output: check.output,
        };
      }

      return {
        check: check.checkName,
        passed: check.status === "passed",
      };
    });
}

export function selectLatestWorkflowPhaseEvent(
  runtime: WorkflowTimelineRuntimeState | null | undefined,
): WorkflowPhaseEvent | null {
  return selectLatestEvent(compactEvents(Object.values(runtime?.phaseEventsByPhaseRunId ?? {})));
}

function selectLatestStartedWorkflowPhaseEvent(
  runtime: WorkflowTimelineRuntimeState | null | undefined,
): WorkflowPhaseEvent | null {
  return selectLatestEvent(
    compactEvents(Object.values(runtime?.phaseEventsByPhaseRunId ?? {})).filter(
      (event): event is WorkflowPhaseEvent => event.event === "started",
    ),
  );
}

function selectLatestWorkflowGateEvent(
  runtime: WorkflowTimelineRuntimeState | null | undefined,
): WorkflowGateEvent | null {
  return selectLatestEvent(compactEvents(Object.values(runtime?.gateEventsByPhaseRunId ?? {})));
}

function selectLatestWorkflowBootstrapEvent(
  runtime: WorkflowTimelineRuntimeState | null | undefined,
): WorkflowBootstrapEvent | null {
  return selectLatestEvent(runtime?.bootstrapEvents ?? []) ?? runtime?.latestBootstrapEvent ?? null;
}

function isSupersededByPhaseStart(
  eventTimestamp: string,
  latestPhaseEvent: WorkflowPhaseEvent | null,
): boolean {
  return (
    latestPhaseEvent?.event === "started" &&
    toSortableTimestamp(latestPhaseEvent.timestamp) > toSortableTimestamp(eventTimestamp)
  );
}

export function resolveWorkflowTimelineTransitionState(input: {
  workflow: WorkflowDefinition | null;
  timeline: readonly WorkflowTimelinePhaseItem[];
  runtime: WorkflowTimelineRuntimeState | null;
}): WorkflowTimelineTransitionState | null {
  const latestPhaseEvent = selectLatestWorkflowPhaseEvent(input.runtime);
  const latestStartedPhaseEvent = selectLatestStartedWorkflowPhaseEvent(input.runtime);
  const latestGateEvent = selectLatestWorkflowGateEvent(input.runtime);
  const latestBootstrapEvent = selectLatestWorkflowBootstrapEvent(input.runtime);

  if (
    latestGateEvent?.status === "waiting-human" &&
    !isSupersededByPhaseStart(latestGateEvent.timestamp, latestStartedPhaseEvent)
  ) {
    const phaseMetadata = resolvePhaseMetadata({
      phaseRunId: latestGateEvent.phaseRunId,
      timeline: input.timeline,
      runtime: input.runtime,
    });

    return {
      kind: "waiting-human",
      anchorPhaseRunId: latestGateEvent.phaseRunId,
      phaseName: phaseMetadata.phaseName,
    };
  }

  if (
    latestGateEvent?.status === "evaluating" &&
    !isSupersededByPhaseStart(latestGateEvent.timestamp, latestStartedPhaseEvent)
  ) {
    const phaseMetadata = resolvePhaseMetadata({
      phaseRunId: latestGateEvent.phaseRunId,
      timeline: input.timeline,
      runtime: input.runtime,
    });

    return {
      kind: "quality-checks",
      anchorPhaseRunId: latestGateEvent.phaseRunId,
      phaseName: phaseMetadata.phaseName,
      checks: [...(input.runtime?.qualityChecksByPhaseRunId[latestGateEvent.phaseRunId] ?? [])],
    };
  }

  if (
    latestBootstrapEvent &&
    toSortableTimestamp(latestBootstrapEvent.timestamp) >=
      Math.max(
        toSortableTimestamp(latestPhaseEvent?.timestamp),
        toSortableTimestamp(latestGateEvent?.timestamp),
      )
  ) {
    const anchorPhaseRunId = latestGateEvent?.phaseRunId ?? latestPhaseEvent?.phaseRunId ?? null;
    const phaseMetadata = resolvePhaseMetadata({
      phaseRunId: anchorPhaseRunId,
      timeline: input.timeline,
      runtime: input.runtime,
    });
    const nextPhase = resolveNextWorkflowPhase(input.workflow, phaseMetadata.phaseId);

    return {
      kind: "bootstrap",
      anchorPhaseRunId,
      phaseName: phaseMetadata.phaseName,
      nextPhaseName: nextPhase?.name ?? null,
      status:
        latestBootstrapEvent.event === "failed"
          ? "failed"
          : latestBootstrapEvent.event === "completed"
            ? "completed"
            : latestBootstrapEvent.event === "skipped"
              ? "skipped"
              : "running",
      output: buildBootstrapOutput(input.runtime?.bootstrapEvents ?? []),
      error: latestBootstrapEvent.error ?? null,
    };
  }

  if (
    latestGateEvent?.status === "passed" &&
    !isSupersededByPhaseStart(latestGateEvent.timestamp, latestStartedPhaseEvent)
  ) {
    const phaseMetadata = resolvePhaseMetadata({
      phaseRunId: latestGateEvent.phaseRunId,
      timeline: input.timeline,
      runtime: input.runtime,
    });
    const nextPhase = resolveNextWorkflowPhase(input.workflow, phaseMetadata.phaseId);
    if (nextPhase) {
      return {
        kind: "phase-handoff",
        anchorPhaseRunId: latestGateEvent.phaseRunId,
        phaseName: phaseMetadata.phaseName,
        nextPhaseName: nextPhase.name,
      };
    }
  }

  if (
    latestPhaseEvent?.event === "completed" &&
    !isSupersededByPhaseStart(latestPhaseEvent.timestamp, latestStartedPhaseEvent)
  ) {
    const nextPhase = resolveNextWorkflowPhase(input.workflow, latestPhaseEvent.phaseInfo.phaseId);
    if (nextPhase) {
      return {
        kind: "phase-handoff",
        anchorPhaseRunId: latestPhaseEvent.phaseRunId,
        phaseName: latestPhaseEvent.phaseInfo.phaseName,
        nextPhaseName: nextPhase.name,
      };
    }
  }

  return null;
}

export function resolveWorkflowAutoNavigationTarget(input: {
  transitionState: WorkflowTimelineTransitionState | null;
  latestPhaseEvent: WorkflowPhaseEvent | null;
  previousChildThreadIds: readonly ThreadId[];
  childThreads: readonly WorkflowTimelineAutoNavigationThread[];
}): ThreadId | null {
  const shouldAutoNavigate =
    input.transitionState?.kind === "bootstrap" ||
    input.transitionState?.kind === "phase-handoff" ||
    input.latestPhaseEvent?.event === "started";

  if (!shouldAutoNavigate) {
    return null;
  }

  const previousIds = new Set(input.previousChildThreadIds);
  const newChildThreads = input.childThreads.filter(
    (childThread) => !previousIds.has(childThread.threadId),
  );
  const newestChildThread = [...newChildThreads].toSorted((left, right) => {
    const timestampComparison =
      toSortableTimestamp(right.updatedAt) - toSortableTimestamp(left.updatedAt);
    if (timestampComparison !== 0) {
      return timestampComparison;
    }
    return right.threadId.localeCompare(left.threadId);
  })[0];

  return newestChildThread?.threadId ?? null;
}

export function buildWorkflowTimelinePhasePresentation(input: {
  phaseItem: WorkflowTimelinePhaseItem;
  runtime: WorkflowTimelineRuntimeState | null;
  transitionState: WorkflowTimelineTransitionState | null;
}): WorkflowTimelinePhasePresentation {
  const runtimeGateEvent =
    input.runtime?.gateEventsByPhaseRunId[input.phaseItem.phaseRunId] ?? null;
  const gateStatus = runtimeGateEvent?.status ?? input.phaseItem.gateResult?.status ?? null;
  const runtimeQualityChecks =
    input.runtime?.qualityChecksByPhaseRunId[input.phaseItem.phaseRunId] ?? [];
  const gateQualityChecks = selectGateApprovalQualityChecks({
    gateQualityCheckResults: input.phaseItem.gateResult?.qualityCheckResults,
    phaseQualityChecks:
      input.phaseItem.qualityChecks.length > 0
        ? input.phaseItem.qualityChecks
        : runtimeQualityChecksToResults(runtimeQualityChecks),
  });
  const phaseTransitionState =
    input.transitionState !== null &&
    input.transitionState.kind !== "waiting-human" &&
    input.transitionState.anchorPhaseRunId === input.phaseItem.phaseRunId
      ? input.transitionState
      : null;
  const shouldRenderGateApproval =
    gateStatus === "waiting-human" ||
    (input.transitionState?.kind === "waiting-human" &&
      input.transitionState.anchorPhaseRunId === input.phaseItem.phaseRunId);

  return {
    gateQualityChecks,
    gateSummaryMarkdown: deriveGateApprovalSummaryMarkdown(input.phaseItem.output),
    gateUnresolvedItems: deriveGateApprovalUnresolvedItems(input.phaseItem.output),
    gateChangesSummary: deriveGateApprovalChangesSummary(input.phaseItem.output),
    phaseTransitionState,
    shouldRenderGateApproval,
  };
}

export function parseWorkflowChannelTranscript(
  transcript: string,
): WorkflowTimelineChannelMessage[] {
  const trimmedTranscript = transcript.trim();
  if (trimmedTranscript.length === 0) {
    return [];
  }

  return trimmedTranscript
    .split(/\n{2,}(?=\[[^\]\n]+\]\n)/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const match = block.match(/^\[([^\]\n]+)\]\n([\s\S]*)$/);
      if (!match) {
        return {
          speaker: "Transcript",
          content: block,
        };
      }

      return {
        speaker: match[1] ?? "Transcript",
        content: match[2]?.trim() ?? "",
      };
    });
}

function parseWorkflowSchemaOutput(content: string): WorkflowTimelineRenderableOutput {
  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    return { kind: "none" };
  }

  try {
    const parsed = JSON.parse(trimmedContent);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const summary =
        typeof parsed.summary === "string" && parsed.summary.trim().length > 0
          ? parsed.summary
          : trimmedContent;
      return {
        kind: "schema",
        summaryMarkdown: summary,
        structuredData: parsed as Record<string, unknown>,
        rawContent: content,
      };
    }
  } catch {
    // Fall back to a markdown summary when the output is not JSON.
  }

  return {
    kind: "schema",
    summaryMarkdown: content,
    structuredData: null,
    rawContent: content,
  };
}

export function resolveWorkflowTimelineOutput(input: {
  phase: WorkflowPhase | null;
  phaseType: PhaseType;
  phaseOutput: WorkflowTimelinePhaseOutputRecord | null;
  childSessions: readonly WorkflowTimelineChildSession[];
}): WorkflowTimelineRenderableOutput {
  const outputMode = resolveWorkflowPhaseOutputMode(input.phase, input.phaseType);

  switch (outputMode) {
    case "schema":
      if (input.phaseOutput) {
        return parseWorkflowSchemaOutput(input.phaseOutput.content);
      }
      break;
    case "channel":
      if (input.phaseOutput) {
        return {
          kind: "channel",
          messages: parseWorkflowChannelTranscript(input.phaseOutput.content),
          rawTranscript: input.phaseOutput.content,
        };
      }
      break;
    case "conversation": {
      const markdown =
        input.phaseOutput?.content ?? resolveLatestAssistantMessage(input.childSessions);
      if (markdown && markdown.trim().length > 0) {
        return {
          kind: "conversation",
          markdown,
        };
      }
      break;
    }
  }

  return { kind: "none" };
}

export function isWorkflowContainerThread(
  thread:
    | Pick<Thread, "workflowId" | "phaseRunId" | "parentThreadId" | "patternId">
    | null
    | undefined,
): boolean {
  return (
    thread?.workflowId != null &&
    thread.phaseRunId == null &&
    thread.parentThreadId == null &&
    thread.patternId == null
  );
}

export function buildWorkflowTimeline(input: {
  workflow: WorkflowDefinition | null;
  phaseRuns: readonly WorkflowTimelinePhaseRun[];
  phaseOutputsByPhaseRunId: Readonly<Record<string, WorkflowTimelinePhaseOutputRecord | null>>;
  childSessionsByPhaseRunId: Readonly<Record<string, readonly WorkflowTimelineChildSession[]>>;
}): WorkflowTimelinePhaseItem[] {
  const sortedPhaseRuns = [...input.phaseRuns].toSorted(compareWorkflowTimelineRuns);
  const activePhaseRunId =
    sortedPhaseRuns.findLast((phaseRun) => phaseRun.status === "running")?.phaseRunId ?? null;
  const phasesById = new Map(
    (input.workflow?.phases ?? []).map((phase) => [phase.id, phase] as const),
  );

  return sortedPhaseRuns.map((phaseRun) => {
    const phase = phasesById.get(phaseRun.phaseId) ?? null;
    const childSessions = [
      ...(input.childSessionsByPhaseRunId[phaseRun.phaseRunId] ?? []),
    ].toSorted(compareChildSessions);

    return {
      phaseRunId: phaseRun.phaseRunId,
      phaseId: phaseRun.phaseId,
      phaseName: phaseRun.phaseName,
      phaseType: phaseRun.phaseType,
      iteration: phaseRun.iteration,
      status: phaseRun.status,
      startedAt: phaseRun.startedAt,
      completedAt: phaseRun.completedAt,
      phase,
      output: resolveWorkflowTimelineOutput({
        phase,
        phaseType: phaseRun.phaseType,
        phaseOutput: input.phaseOutputsByPhaseRunId[phaseRun.phaseRunId] ?? null,
        childSessions,
      }),
      qualityChecks: [...(phaseRun.qualityChecks ?? [])],
      gateResult: phaseRun.gateResult,
      childSessions,
      isActive: phaseRun.phaseRunId === activePhaseRunId,
    };
  });
}
