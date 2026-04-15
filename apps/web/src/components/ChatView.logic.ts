import {
  MessageId,
  ProjectId,
  type ModelSelection,
  type ThreadId,
  type TurnId,
} from "@forgetools/contracts";
import {
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type ThreadSession,
  type ThreadSessionSlice,
  type TurnDiffSummary,
} from "../types";
import { randomUUID } from "~/lib/utils";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import { Schema } from "effect";
import { FORGE_WORKTREE_BRANCH_PREFIX, sanitizeBranchFragment } from "@forgetools/shared/git";
import { useStore } from "../store";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "forge:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function deriveAssistantMessageIdByTurnId(
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "turnId">>,
): Map<TurnId, MessageId> {
  const byTurnId = new Map<TurnId, MessageId>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.turnId) continue;
    byTurnId.set(message.turnId, message.id);
  }
  return byTurnId;
}

export function deriveSettledTurnDiffSummaryByAssistantMessageId(input: {
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  assistantMessageIdByTurnId: ReadonlyMap<TurnId, MessageId>;
}): Map<MessageId, TurnDiffSummary> {
  const byMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    const assistantMessageId =
      input.assistantMessageIdByTurnId.get(summary.turnId) ?? summary.assistantMessageId;
    if (!assistantMessageId) continue;
    byMessageId.set(assistantMessageId, summary);
  }
  return byMessageId;
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    forkedFromThreadId: null,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    workflowId: draftThread.workflowId,
    messages: [],
    createdAt: draftThread.createdAt,
    pinnedAt: null,
    archivedAt: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    activities: [],
  };
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<ThreadId>;
  openThreadIds: ReadonlyArray<ThreadId>;
  activeThreadId: ThreadId | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): ThreadId[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function buildTemporaryWorktreeBranchName(
  prefix: string = FORGE_WORKTREE_BRANCH_PREFIX,
): string {
  // Keep the 8-hex suffix shape for backend temporary-branch detection.
  const token = randomUUID().slice(0, 8).toLowerCase();
  return `${prefix}/${token}`;
}

export interface WorktreePrepInput {
  /** Project root directory. */
  cwd: string;
  /** Branch to fork the worktree from. */
  baseBranch: string;
  /** User-typed branch name (raw, pre-sanitization). Null means auto-generate. */
  userBranchName: string | null;
  /** Prefix for auto-generated temporary branch names (e.g. "forge"). */
  branchPrefix: string;
  /** Delegate that actually creates the git worktree. */
  createWorktree: (input: {
    cwd: string;
    branch: string;
    newBranch: string;
  }) => Promise<{ worktree: { branch: string; path: string } }>;
}

export interface WorktreePrepResult {
  branch: string;
  worktreePath: string;
}

/**
 * Create a git worktree, resolving the branch name from user input or
 * generating a temporary one. Returns the resulting branch and path.
 *
 * Thread metadata updates and setup-script execution are intentionally
 * left to callers — their lifecycle differs per send path.
 */
export async function prepareWorktree(input: WorktreePrepInput): Promise<WorktreePrepResult> {
  const raw = input.userBranchName?.trim() || null;
  const userBranch = raw ? sanitizeBranchFragment(raw) : null;
  const newBranch = userBranch ?? buildTemporaryWorktreeBranchName(input.branchPrefix);
  const result = await input.createWorktree({
    cwd: input.cwd,
    branch: input.baseBranch,
    newBranch,
  });
  return { branch: result.worktree.branch, worktreePath: result.worktree.path };
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 || options.imageCount > 0 || sendableTerminalContexts.length > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(
  thread: Thread | null | undefined,
  sessionSlice?: ThreadSessionSlice | null,
): boolean {
  return Boolean(
    thread &&
    ((sessionSlice?.latestTurn ?? null) !== null ||
      thread.messages.length > 0 ||
      (sessionSlice?.session ?? null) !== null),
  );
}

export async function waitForServerThreadMatch(
  threadId: ThreadId,
  matches: (thread: Thread, sessionSlice?: ThreadSessionSlice) => boolean,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getState = () => useStore.getState();
  const check = (state: ReturnType<typeof getState>) => {
    const thread = state.threads.find((t) => t.id === threadId);
    if (!thread) return false;
    return matches(thread, state.threadSessionById[threadId]);
  };

  if (check(getState())) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (check(state)) {
        finish(true);
      }
    });

    if (check(getState())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export async function waitForStartedServerThread(
  threadId: ThreadId,
  timeoutMs = 1_000,
): Promise<boolean> {
  return await waitForServerThreadMatch(threadId, threadHasStarted, timeoutMs);
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  sessionSlice?: ThreadSessionSlice | null,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = sessionSlice?.latestTurn ?? null;
  const session = sessionSlice?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: ThreadSessionSlice["latestTurn"] | null;
  session: ThreadSessionSlice["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (
    input.phase === "running" ||
    input.hasPendingApproval ||
    input.hasPendingUserInput ||
    Boolean(input.threadError)
  ) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;

  return (
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null) ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
