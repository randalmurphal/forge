import {
  type ForgeEvent,
  type InteractiveRequest,
  type OrchestrationAgentDiffSummary,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProviderKind,
} from "@forgetools/contracts";
import { resolveModelSlugForProvider } from "@forgetools/shared/model";
import { resolveThreadSpawnWorkspace } from "@forgetools/shared/threadWorkspace";
import type { ChatMessage, DesignPendingOptions, Project, Thread } from "./types";

// ── URL helpers ──────────────────────────────────────────────────────

export function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

export function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

export function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return `${resolveWsHttpOrigin()}${rawUrl}`;
  }
  return rawUrl;
}

// ── Legacy status mapping ────────────────────────────────────────────

export function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

export function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "claudeAgent") {
    return providerName;
  }
  return "codex";
}

export function toOrchestrationSessionStatusFromForgeStatus(
  status: Extract<ForgeEvent, { type: "thread.status-changed" }>["payload"]["status"],
): OrchestrationSessionStatus {
  switch (status) {
    case "created":
      return "starting";
    case "running":
      return "running";
    case "needs-attention":
    case "paused":
      return "interrupted";
    case "completed":
      return "idle";
    case "failed":
      return "error";
    case "cancelled":
      return "stopped";
  }

  return "starting";
}

// ── Model / project helpers ──────────────────────────────────────────

export function normalizeModelSelection<
  T extends { provider: "codex" | "claudeAgent"; model: string },
>(selection: T): T {
  return {
    ...selection,
    model: resolveModelSlugForProvider(selection.provider, selection.model),
  };
}

export function mapProjectScripts(
  scripts: ReadonlyArray<Project["scripts"][number]>,
): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

// ── Session / message / turn mappers ─────────────────────────────────

export function mapSession(session: OrchestrationSession): Thread["session"] {
  return {
    provider: toLegacyProvider(session.providerName),
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

export function mapMessageAttachments(
  attachments: OrchestrationMessage["attachments"] | undefined,
): ChatMessage["attachments"] | undefined {
  return attachments?.map((attachment) => ({
    type: "image" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
  }));
}

export function mapMessage(message: OrchestrationMessage): ChatMessage {
  const attachments = mapMessageAttachments(message.attachments);

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    streaming: message.streaming,
    ...(message.attribution !== undefined ? { attribution: message.attribution } : {}),
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function mapProposedPlan(
  proposedPlan: OrchestrationProposedPlan,
): Thread["proposedPlans"][number] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

export function mapTurnDiffSummary(
  checkpoint: OrchestrationCheckpointSummary,
): Thread["turnDiffSummaries"][number] {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    provenance: "workspace",
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    files: checkpoint.files.map((file) => ({ ...file })),
  };
}

export function mapAgentDiffSummary(
  agentDiff: OrchestrationAgentDiffSummary,
): NonNullable<Thread["agentDiffSummaries"]>[number] {
  return {
    turnId: agentDiff.turnId,
    completedAt: agentDiff.completedAt,
    provenance: "agent",
    coverage: agentDiff.coverage,
    source: agentDiff.source,
    assistantMessageId: agentDiff.assistantMessageId ?? undefined,
    files: agentDiff.files.map((file) => ({ ...file })),
  };
}

// ── Design option mappers ────────────────────────────────────────────

export function toDesignPendingOptions(input: {
  requestId: string;
  payload: unknown;
}): DesignPendingOptions | null {
  const payload =
    input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>)
      : null;
  if (payload?.type !== "design-option" || typeof payload.prompt !== "string") {
    return null;
  }

  const options = Array.isArray(payload.options)
    ? payload.options
        .map<DesignPendingOptions["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") {
            return null;
          }
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.id !== "string" ||
            typeof optionRecord.title !== "string" ||
            typeof optionRecord.description !== "string" ||
            typeof optionRecord.artifactId !== "string" ||
            typeof optionRecord.artifactPath !== "string"
          ) {
            return null;
          }
          return {
            id: optionRecord.id,
            title: optionRecord.title,
            description: optionRecord.description,
            artifactId: optionRecord.artifactId,
            artifactPath: optionRecord.artifactPath,
          };
        })
        .filter((option): option is DesignPendingOptions["options"][number] => option !== null)
    : [];

  if (options.length === 0) {
    return null;
  }

  return {
    requestId: input.requestId,
    prompt: payload.prompt,
    options,
    chosenOptionId: null,
  };
}

export function resolvePendingDesignOptions(
  threadId: Thread["id"],
  pendingRequests: ReadonlyArray<InteractiveRequest>,
): DesignPendingOptions | null {
  let latestPendingRequest: InteractiveRequest | null = null;

  for (const request of pendingRequests) {
    if (
      request.threadId !== threadId ||
      request.type !== "design-option" ||
      request.status !== "pending"
    ) {
      continue;
    }
    if (latestPendingRequest === null || request.createdAt > latestPendingRequest.createdAt) {
      latestPendingRequest = request;
    }
  }

  if (latestPendingRequest === null) {
    return null;
  }

  return toDesignPendingOptions({
    requestId: latestPendingRequest.id,
    payload: latestPendingRequest.payload,
  });
}

export function hasPendingDesignChoice(thread: Pick<Thread, "designPendingOptions">): boolean {
  return (
    thread.designPendingOptions !== null && thread.designPendingOptions.chosenOptionId === null
  );
}

// ── Thread / project read-model mappers ──────────────────────────────

export function mapThread(
  thread: OrchestrationThread,
  pendingRequests: ReadonlyArray<InteractiveRequest>,
): Thread {
  const spawnWorkspace = resolveThreadSpawnWorkspace(thread);
  return {
    id: thread.id,
    codexThreadId: null,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId ?? null,
    forkedFromThreadId: thread.forkedFromThreadId ?? null,
    phaseRunId: thread.phaseRunId ?? null,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    workflowId: thread.workflowId ?? null,
    currentPhaseId: thread.currentPhaseId ?? null,
    discussionId: thread.discussionId ?? null,
    role: thread.role ?? null,
    childThreadIds: [...(thread.childThreadIds ?? [])],
    session: thread.session ? mapSession(thread.session) : null,
    messages: thread.messages.map(mapMessage),
    proposedPlans: thread.proposedPlans.map(mapProposedPlan),
    error: thread.session?.lastError ?? null,
    createdAt: thread.createdAt,
    pinnedAt: thread.pinnedAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    spawnBranch: spawnWorkspace.branch,
    spawnWorktreePath: spawnWorkspace.worktreePath,
    designArtifacts: [],
    designPendingOptions: resolvePendingDesignOptions(thread.id, pendingRequests),
    agentDiffSummaries: (thread.agentDiffs ?? []).map(mapAgentDiffSummary),
    turnDiffSummaries: thread.checkpoints.map(mapTurnDiffSummary),
    activities: thread.activities.map((activity) => ({ ...activity })),
    pendingRequests: pendingRequests
      .filter((request) => request.threadId === thread.id && request.status === "pending")
      .map((request) => Object.assign({}, request)),
    ...(thread.spawnMode !== undefined ? { spawnMode: thread.spawnMode } : {}),
  };
}

export function mapProject(project: OrchestrationReadModel["projects"][number]): Project {
  return {
    id: project.id,
    name: project.title,
    cwd: project.workspaceRoot,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    scripts: mapProjectScripts(project.scripts),
  };
}
