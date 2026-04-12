// Types and constants
export type {
  ProviderPickerKind,
  WorkLogEntry,
  DerivedWorkLogEntry,
  BackgroundTrayState,
  InlineDiffScope,
  InlineDiffAvailability,
  ToolInlineDiffSummary,
  TurnInlineDiffSummary,
  ExpandedInlineDiffState,
  PendingApproval,
  PendingUserInput,
  ActivePlanState,
  LatestProposedPlanState,
  TimelineEntry,
  LatestTurnTiming,
  SessionActivityState,
  WorkLogScope,
  DeriveWorkLogEntriesOptions,
  ToolEnrichments,
  ProviderBackgroundTaskSignal,
  BackgroundCommandCompletionSignal,
  CodexBackgroundCommandCandidate,
  SubagentGroup,
} from "./types";
export {
  PROVIDER_OPTIONS,
  BACKGROUND_TASK_RETENTION_MS,
  COMPLETED_SUBAGENT_FALLBACK_ENTRY_LIMIT,
} from "./types";

// Utils
export {
  formatDuration,
  formatElapsed,
  isLatestTurnSettled,
  deriveActiveWorkStartedAt,
  compareActivitiesByOrder,
  compareActivityLifecycleRank,
  shouldInsertBackgroundCompletionBefore,
  earliestIsoValue,
  latestIsoValue,
  derivePhase,
  filterTrayOwnedWorkEntries,
  inferCheckpointTurnCountByTurnId,
  normalizeCompactToolLabel,
} from "./utils";

// Approvals
export {
  requestKindFromRequestType,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveActivePlanState,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
} from "./approvals";

// Tool enrichment
export {
  extractToolEnrichments,
  toDerivedWorkLogEntry,
  extractToolCommand,
  normalizeCommandValue,
  normalizeCommandOutputValue,
  joinCommandOutputParts,
  extractToolTitle,
  extractToolCallId,
  extractCommandSource,
  extractCommandProcessId,
  stripTrailingExitCode,
  stripTrailingExitCodePreservingOutput,
  extractWorkLogItemType,
  normalizeWorkItemStatus,
  deriveActivityItemStatus,
  extractPersistedToolInlineDiffSummary,
  summarizeToolInlineDiffFiles,
} from "./toolEnrichment";

// Subagent grouping
export {
  isCodexControlCollabTool,
  extractCollabControlToolName,
  isVisibleCollabControlTool,
  isVisibleCollabControlWorkEntry,
  isUnattributedCollabAgentToolEnvelope,
  shouldFilterToolStartedActivity,
  isGenericSubagentLabel,
  groupSubagentEntries,
  synthesizeCodexSubagentLifecycleActivities,
  synthesizeClaudeTaskOutputLifecycleActivities,
  retainCompletedSubagentEntryTail,
  enrichSubagentGroupsWithControlMetadata,
  collectChildThreadMetadata,
  enrichVisibleCollabControlEntriesWithTargetMetadata,
  compactSubagentGroups,
} from "./subagentGrouping";

// Background signals
export {
  collectStreamedCommandOutputByToolCallId,
  collectStreamedCommandOutputPresenceByToolCallId,
  applyPreCollapseBackgroundCommandSignals,
  applyStreamedCommandOutput,
  applyBackgroundCommandSignals,
  appendBackgroundCommandCompletionEntries,
  backgroundCommandCompletionKey,
  deriveCodexBackgroundCommandSignals,
  deriveBackgroundCommandStatus,
  isWithinBackgroundTaskRetention,
  isBackgroundCommandVisibleInTray,
  deriveVisibleBackgroundCommandEntries,
  summarizeBackgroundRelevantActivity,
  summarizeBackgroundRelevantEntry,
  summarizeBackgroundCommandClassification,
  summarizeBackgroundTrayCommandDecision,
} from "./backgroundSignals";

// Work log pipeline
export { deriveWorkLogEntries } from "./workLogPipeline";

// Timeline
export {
  deriveTimelineEntries,
  deriveCompletionDividerBeforeEntryId,
  hasToolActivityForTurn,
  deriveBackgroundTrayState,
} from "./timeline";
