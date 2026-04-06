import type {
  GateResult,
  PhaseRunStatus,
  PhaseType,
  QualityCheckResult,
  WorkflowDefinition,
  WorkflowPhase,
} from "@forgetools/contracts";
import type { Thread } from "../types";

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
  phaseRunId: string;
  phaseId: string;
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

interface WorkflowTimelinePhaseRun {
  phaseRunId: string;
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
  thread: Pick<Thread, "workflowId" | "phaseRunId" | "parentThreadId"> | null | undefined,
): boolean {
  return thread?.workflowId != null && thread.phaseRunId == null && thread.parentThreadId == null;
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
