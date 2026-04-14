/**
 * Claude adapter types, interfaces, and constants.
 *
 * All type-level definitions extracted from ClaudeAdapter.ts for reuse across
 * the claude/ module tree and the main adapter closure.
 *
 * @module claude/types
 */
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalRequestId,
  CanonicalItemType,
  CanonicalRequestType,
  EventId,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderUserInputAnswers,
  RuntimeContentStreamKind,
  ThreadId,
  ThreadTokenUsageSnapshot,
  UserInputQuestion,
} from "@forgetools/contracts";
import { TurnId } from "@forgetools/contracts";
import type { Deferred, Effect, Fiber, FileSystem, Queue } from "effect";

import type { ServerConfigShape } from "../../../config.ts";
import type { ServerSettingsShape } from "../../../serverSettings.ts";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type { PendingMcpServerConfig } from "../../pendingMcpServers.ts";

export const PROVIDER = "claudeAgent" as const;

export type ClaudeTextStreamKind = Extract<
  RuntimeContentStreamKind,
  "assistant_text" | "reasoning_text"
>;

export type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

export type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

export interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
}

export interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  readonly agentDiffPatchesByToolUseId: Map<string, string>;
  agentDiffCoverage: "complete" | "partial";
  lastEmittedUnifiedDiff: string | null;
  nextSyntheticAssistantBlockIndex: number;
}

export interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

export interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

export interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

/** Tracks an active Agent/Task tool call for child thread attribution. */
export interface ActiveSubagentTool {
  readonly toolUseId: string;
  readonly label: string | undefined;
  readonly agentType: string | undefined;
  readonly agentModel: string | undefined;
}

export interface TaskAttribution {
  readonly toolUseId?: string | undefined;
  readonly childThreadAttribution?: Record<string, unknown> | undefined;
  readonly sourceItemType?: CanonicalItemType | undefined;
  readonly sourceToolName?: string | undefined;
  readonly sourceDetail?: string | undefined;
  readonly sourceTimeoutMs?: number | undefined;
  readonly sourcePersistent?: boolean | undefined;
}

export interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  currentApiModelId: string | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  /** Active Agent/Task tool calls, keyed by tool_use_id. Used to inject childThreadAttribution on child messages. */
  readonly activeSubagentTools: Map<string, ActiveSubagentTool>;
  /** Maps runtime task_id → attribution from earlier task_started/task_progress events.
   *  Used by task_updated (which carries task_id but no tool_use_id) to resolve childThreadAttribution. */
  readonly taskAttributionByTaskId: Map<string, TaskAttribution>;
  /** Tracks tasks that have already reached a terminal state so late TaskOutput polls do not emit duplicates. */
  readonly terminalTaskIds: Set<string>;
  /** Tracks tasks that have already had a task.completed event emitted, preventing task_notification from emitting a duplicate that would shift timeline entries. */
  readonly completedTaskIds: Set<string>;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  stopped: boolean;
}

export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
}

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

// ---------------------------------------------------------------------------
// Adapter context — shared mutable state + event infrastructure
// ---------------------------------------------------------------------------

export type OAuthResolver = {
  readonly getToken: Effect.Effect<string | undefined>;
};

export type CreateQueryFn = (input: {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: ClaudeQueryOptions;
}) => ClaudeQueryRuntime;

export type RegisterMcpServerFn = (threadId: string, mcpConfig: PendingMcpServerConfig) => void;

/**
 * Core shared context passed explicitly to all extracted adapter functions.
 *
 * Contains the shared mutable state and event infrastructure that the
 * closure-based architecture previously captured implicitly.
 */
export interface ClaudeAdapterContext {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly sessions: Map<ThreadId, ClaudeSessionContext>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly nowIso: Effect.Effect<string>;
}

/**
 * Service dependencies needed by `startSession` and `sendTurn`.
 *
 * Kept separate from `ClaudeAdapterContext` because only session-bootstrap
 * and turn-send paths need these — most stream handlers only need the core
 * context.
 */
export interface StartSessionServices {
  readonly fileSystem: FileSystem.FileSystem;
  readonly oauthResolver: OAuthResolver;
  readonly serverConfig: ServerConfigShape;
  readonly serverSettingsService: ServerSettingsShape;
  readonly createQuery: CreateQueryFn;
  readonly registerMcpServer: RegisterMcpServerFn;
}
