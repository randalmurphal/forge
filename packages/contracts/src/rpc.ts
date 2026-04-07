import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  ChannelId,
  InteractiveRequestId,
  IsoDateTime,
  NonNegativeInt,
  PhaseRunId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkflowId,
  WorkflowPhaseId,
} from "./baseSchemas";
import { Channel, ChannelMessage, DeliberationState } from "./channel";
import { OpenError, OpenInEditorInput } from "./editor";
import {
  GitActionProgressEvent,
  GitCheckoutInput,
  GitCommandError,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import { KeybindingsConfigError } from "./keybindings";
import {
  ChannelPushEvent,
  ChannelMessageEvent,
  ClientOrchestrationCommand,
  DispatchResult,
  ForgeEvent,
  OrchestrationGetSnapshotError,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
  RuntimeMode,
  SessionSummary,
  TranscriptEntry,
  WorkflowBootstrapEvent,
  WorkflowGateEvent,
  WorkflowPhaseEvent,
  WorkflowQualityCheckEvent,
  WorkflowSummary,
  WorkflowPushEvent,
} from "./orchestration";
import { InteractiveRequestResolution } from "./interactiveRequest";
import { ModelSelection, ProviderKind } from "./providerSchemas";
import { ProviderSandboxMode } from "./providerSchemas";
import {
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import { WorkflowDefinition } from "./workflow";
import { GateResult, PhaseRunStatus, PhaseType, QualityCheckResult } from "./workflow";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerLifecycleStreamEvent,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings";

export const FORGE_WS_METHODS = {
  // Thread operations
  threadCreate: "thread.create",
  threadCorrect: "thread.correct",
  threadPause: "thread.pause",
  threadResume: "thread.resume",
  threadCancel: "thread.cancel",
  threadArchive: "thread.archive",
  threadUnarchive: "thread.unarchive",
  threadSendTurn: "thread.sendTurn",
  threadGetTranscript: "thread.getTranscript",
  threadGetChildren: "thread.getChildren",
  sessionGetTranscript: "session.getTranscript",
  sessionGetChildren: "session.getChildren",

  // Gate operations
  gateApprove: "gate.approve",
  gateReject: "gate.reject",

  // Request operations
  requestResolve: "request.resolve",

  // Channel operations
  channelGetMessages: "channel.getMessages",
  channelGetChannel: "channel.getChannel",
  channelIntervene: "channel.intervene",

  // Phase run operations
  phaseRunList: "phaseRun.list",
  phaseRunGet: "phaseRun.get",

  // Phase output operations
  phaseOutputGet: "phaseOutput.get",
  phaseOutputUpdate: "phaseOutput.update",

  // Workflow operations
  workflowList: "workflow.list",
  workflowGet: "workflow.get",
  workflowCreate: "workflow.create",
  workflowUpdate: "workflow.update",

  // Push subscriptions
  subscribeWorkflowEvents: "subscribeWorkflowEvents",
  subscribeChannelMessages: "subscribeChannelMessages",
  subscribeWorkflowPhase: "workflow.phase",
  subscribeWorkflowQualityChecks: "workflow.quality-check",
  subscribeWorkflowBootstrap: "workflow.bootstrap",
  subscribeWorkflowGate: "workflow.gate",
  subscribeChannelMessage: "channel.message",
} as const;

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitPull: "git.pull",
  gitStatus: "git.status",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",

  // Streaming subscriptions
  subscribeOrchestrationDomainEvents: "subscribeOrchestrationDomainEvents",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",

  // Forge methods
  ...FORGE_WS_METHODS,
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({}),
  success: ServerProviderUpdatedPayload,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  error: OpenError,
});

export const WsGitStatusRpc = Rpc.make(WS_METHODS.gitStatus, {
  payload: GitStatusInput,
  success: GitStatusResult,
  error: GitManagerServiceError,
});

export const WsGitPullRpc = Rpc.make(WS_METHODS.gitPull, {
  payload: GitPullInput,
  success: GitPullResult,
  error: GitCommandError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

export const WsGitListBranchesRpc = Rpc.make(WS_METHODS.gitListBranches, {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  error: GitCommandError,
});

export const WsGitCreateWorktreeRpc = Rpc.make(WS_METHODS.gitCreateWorktree, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  error: GitCommandError,
});

export const WsGitRemoveWorktreeRpc = Rpc.make(WS_METHODS.gitRemoveWorktree, {
  payload: GitRemoveWorktreeInput,
  error: GitCommandError,
});

export const WsGitCreateBranchRpc = Rpc.make(WS_METHODS.gitCreateBranch, {
  payload: GitCreateBranchInput,
  error: GitCommandError,
});

export const WsGitCheckoutRpc = Rpc.make(WS_METHODS.gitCheckout, {
  payload: GitCheckoutInput,
  error: GitCommandError,
});

export const WsGitInitRpc = Rpc.make(WS_METHODS.gitInit, {
  payload: GitInitInput,
  error: GitCommandError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

export const WsOrchestrationGetSnapshotRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getSnapshot, {
  payload: OrchestrationGetSnapshotInput,
  success: OrchestrationRpcSchemas.getSnapshot.output,
  error: OrchestrationGetSnapshotError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

const ForgeThreadCreateInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  parentThreadId: Schema.optional(ThreadId),
  phaseRunId: Schema.optional(PhaseRunId),
  workflowId: Schema.optional(WorkflowId),
  patternId: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  runtimeMode: Schema.optional(RuntimeMode),
  model: Schema.optional(ModelSelection),
  provider: Schema.optional(ProviderKind),
  role: Schema.optional(TrimmedNonEmptyString),
  branchOverride: Schema.optional(TrimmedNonEmptyString),
  requiresWorktree: Schema.optional(Schema.Boolean),
});

const ForgeThreadCorrectInput = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
});

const ForgeThreadPauseInput = Schema.Struct({
  threadId: ThreadId,
});

const ForgeThreadResumeInput = Schema.Struct({
  threadId: ThreadId,
});

const ForgeThreadCancelInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(Schema.String),
});

const ForgeThreadArchiveInput = Schema.Struct({
  threadId: ThreadId,
});

const ForgeThreadUnarchiveInput = Schema.Struct({
  threadId: ThreadId,
});

const ForgeThreadSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  content: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});

const ForgeThreadGetTranscriptInput = Schema.Struct({
  threadId: ThreadId,
  limit: Schema.optional(NonNegativeInt),
  offset: Schema.optional(NonNegativeInt),
});

const ForgeThreadGetTranscriptResult = Schema.Struct({
  entries: Schema.Array(TranscriptEntry),
  total: NonNegativeInt,
});

const ForgeThreadGetChildrenInput = Schema.Struct({
  threadId: ThreadId,
});

const ForgeThreadGetChildrenResult = Schema.Struct({
  children: Schema.Array(SessionSummary),
});

const ForgeSessionGetTranscriptInput = Schema.Struct({
  sessionId: ThreadId,
  limit: Schema.optional(NonNegativeInt),
  offset: Schema.optional(NonNegativeInt),
});

const ForgeSessionGetChildrenInput = Schema.Struct({
  sessionId: ThreadId,
});

const ForgeGateApproveInput = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
});

const ForgeGateRejectInput = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  correction: Schema.optional(Schema.String),
});

const ForgeRequestResolveInput = Schema.Struct({
  requestId: InteractiveRequestId,
  resolvedWith: InteractiveRequestResolution,
});

const ForgeChannelGetMessagesInput = Schema.Struct({
  channelId: ChannelId,
  afterSequence: Schema.optional(NonNegativeInt),
  limit: Schema.optional(NonNegativeInt),
});

const ForgeChannelGetMessagesResult = Schema.Struct({
  messages: Schema.Array(ChannelMessage),
  total: NonNegativeInt,
});

const ForgeChannelGetChannelInput = Schema.Struct({
  channelId: ChannelId,
});

const ForgeChannelGetChannelResult = Schema.Struct({
  channel: Channel,
});

const ForgeChannelInterveneInput = Schema.Struct({
  channelId: ChannelId,
  content: Schema.String,
  fromRole: Schema.optional(TrimmedNonEmptyString),
});

const ForgePhaseRun = Schema.Struct({
  phaseRunId: PhaseRunId,
  threadId: ThreadId,
  workflowId: WorkflowId,
  phaseId: WorkflowPhaseId,
  phaseName: TrimmedNonEmptyString,
  phaseType: PhaseType,
  sandboxMode: Schema.NullOr(ProviderSandboxMode),
  iteration: PositiveInt,
  status: PhaseRunStatus,
  gateResult: Schema.NullOr(GateResult),
  qualityChecks: Schema.NullOr(Schema.Array(QualityCheckResult)),
  deliberationState: Schema.NullOr(DeliberationState),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});

const ForgePhaseRunListInput = Schema.Struct({
  threadId: ThreadId,
});

const ForgePhaseRunListResult = Schema.Struct({
  phaseRuns: Schema.Array(ForgePhaseRun),
});

const ForgePhaseRunGetInput = Schema.Struct({
  phaseRunId: PhaseRunId,
});

const ForgePhaseRunGetResult = Schema.Struct({
  phaseRun: ForgePhaseRun,
});

const ForgePhaseOutput = Schema.Struct({
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
  content: Schema.String,
  sourceType: TrimmedNonEmptyString,
  sourceId: Schema.NullOr(TrimmedNonEmptyString),
  metadata: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const ForgePhaseOutputGetInput = Schema.Struct({
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
});

const ForgePhaseOutputGetResult = Schema.Struct({
  output: ForgePhaseOutput,
});

const ForgePhaseOutputUpdateInput = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
  content: Schema.String,
});

const ForgeWorkflowListInput = Schema.Struct({});

const ForgeWorkflowListResult = Schema.Struct({
  workflows: Schema.Array(WorkflowSummary),
});

const ForgeWorkflowGetInput = Schema.Struct({
  workflowId: WorkflowId,
});

const ForgeWorkflowGetResult = Schema.Struct({
  workflow: WorkflowDefinition,
});

const ForgeWorkflowMutationInput = Schema.Struct({
  workflow: WorkflowDefinition,
});

const ForgeWorkflowMutationResult = Schema.Struct({
  workflow: WorkflowDefinition,
});

export const WsForgeThreadCreateRpc = Rpc.make(WS_METHODS.threadCreate, {
  payload: ForgeThreadCreateInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeThreadCorrectRpc = Rpc.make(WS_METHODS.threadCorrect, {
  payload: ForgeThreadCorrectInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeThreadPauseRpc = Rpc.make(WS_METHODS.threadPause, {
  payload: ForgeThreadPauseInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeThreadResumeRpc = Rpc.make(WS_METHODS.threadResume, {
  payload: ForgeThreadResumeInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeThreadCancelRpc = Rpc.make(WS_METHODS.threadCancel, {
  payload: ForgeThreadCancelInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeThreadArchiveRpc = Rpc.make(WS_METHODS.threadArchive, {
  payload: ForgeThreadArchiveInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeThreadUnarchiveRpc = Rpc.make(WS_METHODS.threadUnarchive, {
  payload: ForgeThreadUnarchiveInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeThreadSendTurnRpc = Rpc.make(WS_METHODS.threadSendTurn, {
  payload: ForgeThreadSendTurnInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeThreadGetTranscriptRpc = Rpc.make(WS_METHODS.threadGetTranscript, {
  payload: ForgeThreadGetTranscriptInput,
  success: ForgeThreadGetTranscriptResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgeThreadGetChildrenRpc = Rpc.make(WS_METHODS.threadGetChildren, {
  payload: ForgeThreadGetChildrenInput,
  success: ForgeThreadGetChildrenResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgeSessionGetTranscriptRpc = Rpc.make(WS_METHODS.sessionGetTranscript, {
  payload: ForgeSessionGetTranscriptInput,
  success: ForgeThreadGetTranscriptResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgeSessionGetChildrenRpc = Rpc.make(WS_METHODS.sessionGetChildren, {
  payload: ForgeSessionGetChildrenInput,
  success: ForgeThreadGetChildrenResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgeGateApproveRpc = Rpc.make(WS_METHODS.gateApprove, {
  payload: ForgeGateApproveInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeGateRejectRpc = Rpc.make(WS_METHODS.gateReject, {
  payload: ForgeGateRejectInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeRequestResolveRpc = Rpc.make(WS_METHODS.requestResolve, {
  payload: ForgeRequestResolveInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeChannelGetMessagesRpc = Rpc.make(WS_METHODS.channelGetMessages, {
  payload: ForgeChannelGetMessagesInput,
  success: ForgeChannelGetMessagesResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgeChannelGetChannelRpc = Rpc.make(WS_METHODS.channelGetChannel, {
  payload: ForgeChannelGetChannelInput,
  success: ForgeChannelGetChannelResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgeChannelInterveneRpc = Rpc.make(WS_METHODS.channelIntervene, {
  payload: ForgeChannelInterveneInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgePhaseRunListRpc = Rpc.make(WS_METHODS.phaseRunList, {
  payload: ForgePhaseRunListInput,
  success: ForgePhaseRunListResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgePhaseRunGetRpc = Rpc.make(WS_METHODS.phaseRunGet, {
  payload: ForgePhaseRunGetInput,
  success: ForgePhaseRunGetResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgePhaseOutputGetRpc = Rpc.make(WS_METHODS.phaseOutputGet, {
  payload: ForgePhaseOutputGetInput,
  success: ForgePhaseOutputGetResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgePhaseOutputUpdateRpc = Rpc.make(WS_METHODS.phaseOutputUpdate, {
  payload: ForgePhaseOutputUpdateInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
});

export const WsForgeWorkflowListRpc = Rpc.make(WS_METHODS.workflowList, {
  payload: ForgeWorkflowListInput,
  success: ForgeWorkflowListResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgeWorkflowGetRpc = Rpc.make(WS_METHODS.workflowGet, {
  payload: ForgeWorkflowGetInput,
  success: ForgeWorkflowGetResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgeWorkflowCreateRpc = Rpc.make(WS_METHODS.workflowCreate, {
  payload: ForgeWorkflowMutationInput,
  success: ForgeWorkflowMutationResult,
  error: OrchestrationGetSnapshotError,
});

export const WsForgeWorkflowUpdateRpc = Rpc.make(WS_METHODS.workflowUpdate, {
  payload: ForgeWorkflowMutationInput,
  success: ForgeWorkflowMutationResult,
  error: OrchestrationGetSnapshotError,
});

export const WsSubscribeOrchestrationDomainEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrchestrationDomainEvents,
  {
    payload: Schema.Struct({
      fromSequenceExclusive: Schema.optional(NonNegativeInt),
    }),
    success: ForgeEvent,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsSubscribeWorkflowEventsRpc = Rpc.make(WS_METHODS.subscribeWorkflowEvents, {
  payload: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: WorkflowPushEvent,
  stream: true,
});

export const WsSubscribeChannelMessagesRpc = Rpc.make(WS_METHODS.subscribeChannelMessages, {
  payload: Schema.Struct({ channelId: Schema.optional(ChannelId) }),
  success: ChannelPushEvent,
  stream: true,
});

export const WsSubscribeWorkflowPhaseRpc = Rpc.make(WS_METHODS.subscribeWorkflowPhase, {
  payload: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: WorkflowPhaseEvent,
  stream: true,
});

export const WsSubscribeWorkflowQualityChecksRpc = Rpc.make(
  WS_METHODS.subscribeWorkflowQualityChecks,
  {
    payload: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
    success: WorkflowQualityCheckEvent,
    stream: true,
  },
);

export const WsSubscribeWorkflowBootstrapRpc = Rpc.make(WS_METHODS.subscribeWorkflowBootstrap, {
  payload: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: WorkflowBootstrapEvent,
  stream: true,
});

export const WsSubscribeWorkflowGateRpc = Rpc.make(WS_METHODS.subscribeWorkflowGate, {
  payload: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: WorkflowGateEvent,
  stream: true,
});

export const WsSubscribeChannelMessageRpc = Rpc.make(WS_METHODS.subscribeChannelMessage, {
  payload: Schema.Struct({ channelId: Schema.optional(ChannelId) }),
  success: ChannelMessageEvent,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpsertKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsGitStatusRpc,
  WsGitPullRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitListBranchesRpc,
  WsGitCreateWorktreeRpc,
  WsGitRemoveWorktreeRpc,
  WsGitCreateBranchRpc,
  WsGitCheckoutRpc,
  WsGitInitRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeOrchestrationDomainEventsRpc,
  WsSubscribeWorkflowEventsRpc,
  WsSubscribeChannelMessagesRpc,
  WsSubscribeWorkflowPhaseRpc,
  WsSubscribeWorkflowQualityChecksRpc,
  WsSubscribeWorkflowBootstrapRpc,
  WsSubscribeWorkflowGateRpc,
  WsSubscribeChannelMessageRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsForgeThreadGetTranscriptRpc,
  WsForgeThreadGetChildrenRpc,
  WsForgeSessionGetTranscriptRpc,
  WsForgeSessionGetChildrenRpc,
  WsForgeChannelGetMessagesRpc,
  WsForgeChannelGetChannelRpc,
  WsForgePhaseRunListRpc,
  WsForgePhaseRunGetRpc,
  WsForgePhaseOutputGetRpc,
  WsForgeWorkflowListRpc,
  WsForgeWorkflowGetRpc,
  WsForgeWorkflowCreateRpc,
  WsForgeWorkflowUpdateRpc,
);
