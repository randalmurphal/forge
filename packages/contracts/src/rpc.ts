import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  ChannelId,
  InteractiveRequestId,
  NonNegativeInt,
  PhaseRunId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkflowId,
} from "./baseSchemas";
import { ChannelMessage } from "./channel";
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
  DispatchResult,
  ForgeClientSnapshot,
  OrchestrationMessage,
  ClientOrchestrationCommand,
  OrchestrationEvent,
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
  WorkflowPushEvent,
} from "./orchestration";
import { InteractiveRequestResolution } from "./interactiveRequest";
import { ModelSelection, ProviderKind } from "./providerSchemas";
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

  // Gate operations
  gateApprove: "gate.approve",
  gateReject: "gate.reject",

  // Request operations
  requestResolve: "request.resolve",

  // Channel operations
  channelGetMessages: "channel.getMessages",
  channelIntervene: "channel.intervene",

  // Phase output operations
  phaseOutputUpdate: "phaseOutput.update",

  // Workflow operations
  workflowList: "workflow.list",
  workflowGet: "workflow.get",

  // Push subscriptions
  subscribeWorkflowEvents: "subscribeWorkflowEvents",
  subscribeChannelMessages: "subscribeChannelMessages",
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
});

const ForgeThreadGetTranscriptResult = Schema.Struct({
  entries: Schema.Array(OrchestrationMessage),
  total: NonNegativeInt,
});

const ForgeThreadGetChildrenInput = Schema.Struct({
  threadId: ThreadId,
});

const ForgeThreadGetChildrenResult = Schema.Struct({
  children: ForgeClientSnapshot.fields.sessions,
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
});

const ForgeChannelGetMessagesResult = Schema.Struct({
  messages: Schema.Array(ChannelMessage),
  total: NonNegativeInt,
});

const ForgeChannelInterveneInput = Schema.Struct({
  channelId: ChannelId,
  content: Schema.String,
  fromRole: Schema.optional(TrimmedNonEmptyString),
});

const ForgePhaseOutputUpdateInput = Schema.Struct({
  threadId: ThreadId,
  phaseRunId: PhaseRunId,
  outputKey: TrimmedNonEmptyString,
  content: Schema.String,
});

const ForgeWorkflowListInput = Schema.Struct({});

const ForgeWorkflowListResult = Schema.Struct({
  workflows: ForgeClientSnapshot.fields.workflows,
});

const ForgeWorkflowGetInput = Schema.Struct({
  workflowId: WorkflowId,
});

const ForgeWorkflowGetResult = Schema.Struct({
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

export const WsForgeChannelInterveneRpc = Rpc.make(WS_METHODS.channelIntervene, {
  payload: ForgeChannelInterveneInput,
  success: DispatchResult,
  error: OrchestrationDispatchCommandError,
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

export const WsSubscribeOrchestrationDomainEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrchestrationDomainEvents,
  {
    payload: Schema.Struct({}),
    success: OrchestrationEvent,
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
  WsSubscribeTerminalEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
);
