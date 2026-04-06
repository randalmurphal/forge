import type { PhaseRunId, QualityCheckResult, ThreadId } from "@forgetools/contracts";
import type { WorkflowTimelineRenderableOutput } from "./WorkflowTimeline.logic";

export interface GateApprovalRpcClient {
  readonly thread: {
    readonly correct: (input: { threadId: ThreadId; content: string }) => Promise<unknown>;
  };
  readonly gate: {
    readonly approve: (input: { threadId: ThreadId; phaseRunId: PhaseRunId }) => Promise<unknown>;
    readonly reject: (input: {
      threadId: ThreadId;
      phaseRunId: PhaseRunId;
      correction?: string;
    }) => Promise<unknown>;
  };
}

function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function collectStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => collectStringList(entry));
}

function extractStructuredList(
  structuredData: Record<string, unknown> | null,
  candidateKeys: readonly string[],
): string[] {
  if (!structuredData) {
    return [];
  }

  for (const key of candidateKeys) {
    const value = structuredData[key];
    const items = collectStringList(value);
    if (items.length > 0) {
      return items;
    }
  }

  return [];
}

export function deriveGateApprovalSummaryMarkdown(
  output: WorkflowTimelineRenderableOutput,
): string | null {
  switch (output.kind) {
    case "schema":
      return normalizeText(output.summaryMarkdown);
    case "conversation":
      return normalizeText(output.markdown);
    case "channel":
      return normalizeText(output.rawTranscript);
    case "none":
      return null;
  }
}

export function deriveGateApprovalUnresolvedItems(
  output: WorkflowTimelineRenderableOutput,
): string[] {
  return output.kind === "schema"
    ? extractStructuredList(output.structuredData, [
        "unresolvedItems",
        "unresolved",
        "issues",
        "openQuestions",
      ])
    : [];
}

export function deriveGateApprovalChangesSummary(
  output: WorkflowTimelineRenderableOutput,
): string[] {
  return output.kind === "schema"
    ? extractStructuredList(output.structuredData, ["changesSummary", "changes", "filesChanged"])
    : [];
}

export function resolveGateApprovalShortcut(input: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  targetTagName?: string | null;
  isContentEditable?: boolean;
}): "approve" | "correct" | "reject" | null {
  if (input.altKey || input.ctrlKey || input.metaKey || input.shiftKey) {
    return null;
  }

  if (input.isContentEditable) {
    return null;
  }

  const targetTagName = input.targetTagName?.toLowerCase();
  if (targetTagName === "input" || targetTagName === "textarea" || targetTagName === "select") {
    return null;
  }

  switch (input.key.toLowerCase()) {
    case "a":
      return "approve";
    case "c":
      return "correct";
    case "r":
      return "reject";
    default:
      return null;
  }
}

export async function approveGate(input: {
  client: GateApprovalRpcClient;
  threadId: ThreadId;
  phaseRunId: PhaseRunId;
}) {
  return input.client.gate.approve({
    threadId: input.threadId,
    phaseRunId: input.phaseRunId,
  });
}

export async function rejectGate(input: {
  client: GateApprovalRpcClient;
  threadId: ThreadId;
  phaseRunId: PhaseRunId;
  reason: string;
}) {
  const reason = normalizeText(input.reason);
  if (!reason) {
    throw new Error("A rejection reason is required.");
  }

  return input.client.gate.reject({
    threadId: input.threadId,
    phaseRunId: input.phaseRunId,
    correction: reason,
  });
}

export async function correctGate(input: {
  client: GateApprovalRpcClient;
  threadId: ThreadId;
  phaseRunId: PhaseRunId;
  correction: string;
}) {
  const correction = normalizeText(input.correction);
  if (!correction) {
    throw new Error("A correction is required.");
  }

  await input.client.thread.correct({
    threadId: input.threadId,
    content: correction,
  });

  return input.client.gate.reject({
    threadId: input.threadId,
    phaseRunId: input.phaseRunId,
  });
}

export function selectGateApprovalQualityChecks(input: {
  gateQualityCheckResults: readonly QualityCheckResult[] | undefined;
  phaseQualityChecks: readonly QualityCheckResult[];
}): readonly QualityCheckResult[] {
  return input.gateQualityCheckResults && input.gateQualityCheckResults.length > 0
    ? input.gateQualityCheckResults
    : input.phaseQualityChecks;
}
