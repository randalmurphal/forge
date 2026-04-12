import {
  ApprovalRequestId,
  ChannelId,
  ChannelMessageId,
  CheckpointRef,
  CommandId,
  DesignArtifactId,
  EventId,
  InteractiveRequestId,
  MessageId,
  PhaseRunId,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
  WorkflowId,
  WorkflowPhaseId,
} from "@forgetools/contracts";

export const asThreadId = (value: string) => ThreadId.makeUnsafe(value);
export const asTurnId = (value: string) => TurnId.makeUnsafe(value);
export const asEventId = (value: string) => EventId.makeUnsafe(value);
export const asProjectId = (value: string) => ProjectId.makeUnsafe(value);
export const asMessageId = (value: string) => MessageId.makeUnsafe(value);
export const asItemId = (value: string) => ProviderItemId.makeUnsafe(value);
export const asApprovalRequestId = (value: string) => ApprovalRequestId.makeUnsafe(value);
export const asCheckpointRef = (value: string) => CheckpointRef.makeUnsafe(value);
export const asCommandId = (value: string) => CommandId.makeUnsafe(value);
export const asChannelId = (value: string) => ChannelId.makeUnsafe(value);
export const asChannelMessageId = (value: string) => ChannelMessageId.makeUnsafe(value);
export const asPhaseRunId = (value: string) => PhaseRunId.makeUnsafe(value);
export const asWorkflowId = (value: string) => WorkflowId.makeUnsafe(value);
export const asWorkflowPhaseId = (value: string) => WorkflowPhaseId.makeUnsafe(value);
export const asInteractiveRequestId = (value: string) => InteractiveRequestId.makeUnsafe(value);
export const asDesignArtifactId = (value: string) => DesignArtifactId.makeUnsafe(value);
