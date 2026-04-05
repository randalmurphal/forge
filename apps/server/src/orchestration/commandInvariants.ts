import type {
  Channel as OrchestrationChannel,
  ForgeCommand,
  InteractiveRequest,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  PhaseRunId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function findChannelById(
  readModel: OrchestrationReadModel,
  channelId: OrchestrationChannel["id"],
): OrchestrationChannel | undefined {
  return readModel.channels.find((channel) => channel.id === channelId);
}

export function findChannelByThreadIdAndType(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
  type: OrchestrationChannel["type"],
): OrchestrationChannel | undefined {
  return readModel.channels.find(
    (channel) => channel.threadId === threadId && channel.type === type,
  );
}

export function findPendingRequestById(
  readModel: OrchestrationReadModel,
  requestId: InteractiveRequest["id"],
): InteractiveRequest | undefined {
  return readModel.pendingRequests.find((request) => request.id === requestId);
}

type PhaseRunOutputLike = {
  readonly key: string;
  readonly content: string;
};

type ProjectedPhaseRunLike = OrchestrationReadModel["phaseRuns"][number] & {
  readonly outputs?: ReadonlyArray<PhaseRunOutputLike>;
};

export function findPhaseRunById(
  readModel: OrchestrationReadModel,
  phaseRunId: PhaseRunId,
): ProjectedPhaseRunLike | undefined {
  return readModel.phaseRuns.find(
    (phaseRun): phaseRun is ProjectedPhaseRunLike => phaseRun.phaseRunId === phaseRunId,
  );
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireChannel(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly channelId: OrchestrationChannel["id"];
}): Effect.Effect<OrchestrationChannel, OrchestrationCommandInvariantError> {
  const channel = findChannelById(input.readModel, input.channelId);
  if (channel) {
    return Effect.succeed(channel);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Channel '${input.channelId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireChannelAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly channelId: OrchestrationChannel["id"];
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findChannelById(input.readModel, input.channelId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Channel '${input.channelId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireChannelOpen(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly channelId: OrchestrationChannel["id"];
}): Effect.Effect<OrchestrationChannel, OrchestrationCommandInvariantError> {
  return requireChannel(input).pipe(
    Effect.flatMap((channel) =>
      channel.status === "open"
        ? Effect.succeed(channel)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Channel '${input.channelId}' is not open for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requirePendingRequest(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly requestId: InteractiveRequest["id"];
}): Effect.Effect<InteractiveRequest, OrchestrationCommandInvariantError> {
  const request = findPendingRequestById(input.readModel, input.requestId);
  if (request) {
    return Effect.succeed(request);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Pending request '${input.requestId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requirePendingRequestAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly requestId: InteractiveRequest["id"];
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findPendingRequestById(input.readModel, input.requestId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Pending request '${input.requestId}' already exists and cannot be opened twice.`,
    ),
  );
}

export function requirePhaseRunForThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: ForgeCommand;
  readonly phaseRunId: PhaseRunId;
  readonly threadId: ThreadId;
}): Effect.Effect<ProjectedPhaseRunLike, OrchestrationCommandInvariantError> {
  const phaseRun = findPhaseRunById(input.readModel, input.phaseRunId);
  if (!phaseRun) {
    return Effect.fail(
      invariantError(
        input.command.type,
        `Phase run '${input.phaseRunId}' does not exist for command '${input.command.type}'.`,
      ),
    );
  }
  if (phaseRun.threadId !== input.threadId) {
    return Effect.fail(
      invariantError(
        input.command.type,
        `Phase run '${input.phaseRunId}' does not belong to thread '${input.threadId}'.`,
      ),
    );
  }
  return Effect.succeed(phaseRun);
}

export function requireNonNegativeInteger(input: {
  readonly commandType: ForgeCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}

export function requireDistinctThreadIds(input: {
  readonly command: ForgeCommand;
  readonly leftLabel: string;
  readonly leftThreadId: ThreadId;
  readonly rightLabel: string;
  readonly rightThreadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.leftThreadId !== input.rightThreadId) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `${input.leftLabel} and ${input.rightLabel} must reference different threads.`,
    ),
  );
}

export function requireThreadsInSameProject(input: {
  readonly command: ForgeCommand;
  readonly leftLabel: string;
  readonly leftThread: OrchestrationThread;
  readonly rightLabel: string;
  readonly rightThread: OrchestrationThread;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.leftThread.projectId === input.rightThread.projectId) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `${input.leftLabel} '${input.leftThread.id}' and ${input.rightLabel} '${input.rightThread.id}' must belong to the same project.`,
    ),
  );
}
