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
  ProviderApprovalDecision,
  ProviderSession,
  ProviderUserInputAnswers,
  RuntimeContentStreamKind,
  ThreadTokenUsageSnapshot,
  UserInputQuestion,
} from "@forgetools/contracts";
import { ThreadId, TurnId } from "@forgetools/contracts";
import type { Deferred, Fiber, Queue } from "effect";

import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";

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
