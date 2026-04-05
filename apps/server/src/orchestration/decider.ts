import {
  ChannelId,
  ChannelMessageId,
  EventId,
  LinkId,
  PhaseRunId,
  type ForgeCommand,
  type ForgeEvent,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  findChannelByThreadIdAndType,
  requireChannel,
  requireChannelAbsent,
  requireChannelOpen,
  requireDistinctThreadIds,
  requirePendingRequest,
  requirePendingRequestAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
  requireThreadsInSameProject,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
type WorkflowThreadCommand = Extract<
  ForgeCommand,
  {
    type:
      | "thread.correct"
      | "thread.start-phase"
      | "thread.complete-phase"
      | "thread.fail-phase"
      | "thread.skip-phase"
      | "thread.quality-check-start"
      | "thread.quality-check-complete"
      | "thread.bootstrap-started"
      | "thread.bootstrap-completed"
      | "thread.bootstrap-failed"
      | "thread.bootstrap-skipped"
      | "thread.add-link"
      | "thread.remove-link"
      | "thread.promote"
      | "thread.add-dependency"
      | "thread.remove-dependency";
  }
>;
type ChannelCommand = Extract<
  ForgeCommand,
  {
    type:
      | "channel.create"
      | "channel.post-message"
      | "channel.read-messages"
      | "channel.conclude"
      | "channel.close";
  }
>;
type InteractiveRequestCommand = Extract<
  ForgeCommand,
  {
    type: "request.open" | "request.resolve" | "request.mark-stale";
  }
>;

export type DecidableOrchestrationCommand =
  | OrchestrationCommand
  | WorkflowThreadCommand
  | ChannelCommand
  | InteractiveRequestCommand;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DecidedOrchestrationEvent = DistributiveOmit<ForgeEvent, "sequence">;

type SharedEventMetadata = Pick<
  ForgeEvent,
  "eventId" | "occurredAt" | "commandId" | "causationEventId" | "correlationId" | "metadata"
>;

const defaultMetadata: Pick<SharedEventMetadata, "causationEventId" | "metadata"> = {
  causationEventId: null,
  metadata: {},
};

function withEventBase<
  TAggregateKind extends ForgeEvent["aggregateKind"],
  TAggregateId extends ForgeEvent["aggregateId"],
>(
  input: Pick<DecidableOrchestrationCommand, "commandId"> & {
    readonly aggregateKind: TAggregateKind;
    readonly aggregateId: TAggregateId;
    readonly occurredAt: string;
    readonly metadata?: ForgeEvent["metadata"];
  },
): {
  readonly aggregateKind: TAggregateKind;
  readonly aggregateId: TAggregateId;
} & SharedEventMetadata {
  return {
    ...defaultMetadata,
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? defaultMetadata.metadata,
  };
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: DecidableOrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecidedOrchestrationEvent | ReadonlyArray<DecidedOrchestrationEvent>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: DecidedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: DecidedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as ForgeEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    case "thread.correct": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const guidanceChannelId =
        findChannelByThreadIdAndType(readModel, command.threadId, "guidance")?.id ??
        ChannelId.makeUnsafe(crypto.randomUUID());
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.correction-queued",
        payload: {
          threadId: command.threadId,
          content: command.content,
          channelId: guidanceChannelId,
          messageId: ChannelMessageId.makeUnsafe(crypto.randomUUID()),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.start-phase": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.phase-started",
        payload: {
          threadId: command.threadId,
          phaseRunId: PhaseRunId.makeUnsafe(crypto.randomUUID()),
          phaseId: command.phaseId,
          phaseName: command.phaseName,
          phaseType: command.phaseType,
          iteration: command.iteration,
          startedAt: command.createdAt,
        },
      };
    }

    case "thread.complete-phase": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.phase-completed",
        payload: {
          threadId: command.threadId,
          phaseRunId: command.phaseRunId,
          outputs: command.outputs ?? [],
          ...(command.gateResult !== undefined ? { gateResult: command.gateResult } : {}),
          completedAt: command.createdAt,
        },
      };
    }

    case "thread.fail-phase": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.phase-failed",
        payload: {
          threadId: command.threadId,
          phaseRunId: command.phaseRunId,
          error: command.error,
          failedAt: command.createdAt,
        },
      };
    }

    case "thread.skip-phase": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.phase-skipped",
        payload: {
          threadId: command.threadId,
          phaseRunId: command.phaseRunId,
          skippedAt: command.createdAt,
        },
      };
    }

    case "thread.quality-check-start": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.quality-check-started",
        payload: {
          threadId: command.threadId,
          phaseRunId: command.phaseRunId,
          checks: command.checks,
          startedAt: command.createdAt,
        },
      };
    }

    case "thread.quality-check-complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.quality-check-completed",
        payload: {
          threadId: command.threadId,
          phaseRunId: command.phaseRunId,
          results: command.results,
          completedAt: command.createdAt,
        },
      };
    }

    case "thread.bootstrap-started": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.bootstrap-started",
        payload: {
          threadId: command.threadId,
          startedAt: command.createdAt,
        },
      };
    }

    case "thread.bootstrap-completed": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.bootstrap-completed",
        payload: {
          threadId: command.threadId,
          completedAt: command.createdAt,
        },
      };
    }

    case "thread.bootstrap-failed": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.bootstrap-failed",
        payload: {
          threadId: command.threadId,
          error: command.error,
          stdout: command.stdout,
          command: command.command,
          failedAt: command.createdAt,
        },
      };
    }

    case "thread.bootstrap-skipped": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.bootstrap-skipped",
        payload: {
          threadId: command.threadId,
          skippedAt: command.createdAt,
        },
      };
    }

    case "thread.add-link": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.linkedThreadId !== undefined) {
        yield* requireDistinctThreadIds({
          command,
          leftLabel: "threadId",
          leftThreadId: command.threadId,
          rightLabel: "linkedThreadId",
          rightThreadId: command.linkedThreadId,
        });
        const linkedThread = yield* requireThread({
          readModel,
          command,
          threadId: command.linkedThreadId,
        });
        yield* requireThreadsInSameProject({
          command,
          leftLabel: "threadId",
          leftThread: thread,
          rightLabel: "linkedThreadId",
          rightThread: linkedThread,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.link-added",
        payload: {
          threadId: command.threadId,
          linkId: command.linkId,
          linkType: command.linkType,
          linkedThreadId: command.linkedThreadId ?? null,
          externalId: command.externalId ?? null,
          externalUrl: command.externalUrl ?? null,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.remove-link": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.link-removed",
        payload: {
          threadId: command.threadId,
          linkId: command.linkId,
          removedAt: command.createdAt,
        },
      };
    }

    case "thread.promote": {
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.targetThreadId,
      });
      yield* requireDistinctThreadIds({
        command,
        leftLabel: "sourceThreadId",
        leftThreadId: command.sourceThreadId,
        rightLabel: "targetThreadId",
        rightThreadId: command.targetThreadId,
      });
      return [
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.sourceThreadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.promoted",
          payload: {
            sourceThreadId: command.sourceThreadId,
            targetThreadId: command.targetThreadId,
            promotedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.sourceThreadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.link-added",
          payload: {
            threadId: command.sourceThreadId,
            linkId: LinkId.makeUnsafe(crypto.randomUUID()),
            linkType: "promoted-to",
            linkedThreadId: command.targetThreadId,
            externalId: null,
            externalUrl: null,
            createdAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.targetThreadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.link-added",
          payload: {
            threadId: command.targetThreadId,
            linkId: LinkId.makeUnsafe(crypto.randomUUID()),
            linkType: "promoted-from",
            linkedThreadId: sourceThread.id,
            externalId: null,
            externalUrl: null,
            createdAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.add-dependency": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireDistinctThreadIds({
        command,
        leftLabel: "threadId",
        leftThreadId: command.threadId,
        rightLabel: "dependsOnThreadId",
        rightThreadId: command.dependsOnThreadId,
      });
      const dependsOnThread = yield* requireThread({
        readModel,
        command,
        threadId: command.dependsOnThreadId,
      });
      yield* requireThreadsInSameProject({
        command,
        leftLabel: "threadId",
        leftThread: thread,
        rightLabel: "dependsOnThreadId",
        rightThread: dependsOnThread,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.dependency-added",
        payload: {
          threadId: command.threadId,
          dependsOnThreadId: command.dependsOnThreadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.remove-dependency": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireDistinctThreadIds({
        command,
        leftLabel: "threadId",
        leftThreadId: command.threadId,
        rightLabel: "dependsOnThreadId",
        rightThreadId: command.dependsOnThreadId,
      });
      const dependsOnThread = yield* requireThread({
        readModel,
        command,
        threadId: command.dependsOnThreadId,
      });
      yield* requireThreadsInSameProject({
        command,
        leftLabel: "threadId",
        leftThread: thread,
        rightLabel: "dependsOnThreadId",
        rightThread: dependsOnThread,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.dependency-removed",
        payload: {
          threadId: command.threadId,
          dependsOnThreadId: command.dependsOnThreadId,
          removedAt: command.createdAt,
        },
      };
    }

    case "channel.create": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireChannelAbsent({
        readModel,
        command,
        channelId: command.channelId,
      });
      return {
        ...withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "channel.created",
        payload: {
          channelId: command.channelId,
          threadId: command.threadId,
          channelType: command.channelType,
          phaseRunId: command.phaseRunId ?? null,
          createdAt: command.createdAt,
        },
      };
    }

    case "channel.post-message": {
      yield* requireChannelOpen({
        readModel,
        command,
        channelId: command.channelId,
      });
      return {
        ...withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "channel.message-posted",
        payload: {
          channelId: command.channelId,
          messageId: command.messageId,
          // Global event sequencing provides a deterministic monotonic cursor per channel.
          sequence: readModel.snapshotSequence + 1,
          fromType: command.fromType,
          fromId: command.fromId,
          fromRole: command.fromRole ?? null,
          content: command.content,
          createdAt: command.createdAt,
        },
      };
    }

    case "channel.read-messages": {
      const channel = yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      const parentThread = yield* requireThread({
        readModel,
        command,
        threadId: channel.threadId,
      });
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireThreadsInSameProject({
        command,
        leftLabel: "channel.threadId",
        leftThread: parentThread,
        rightLabel: "threadId",
        rightThread: thread,
      });
      return {
        ...withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "channel.messages-read",
        payload: {
          channelId: command.channelId,
          threadId: command.threadId,
          upToSequence: command.upToSequence,
          readAt: command.createdAt,
        },
      };
    }

    case "channel.conclude": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireChannelOpen({
        readModel,
        command,
        channelId: command.channelId,
      });
      return {
        ...withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "channel.conclusion-proposed",
        payload: {
          channelId: command.channelId,
          threadId: command.threadId,
          summary: command.summary,
          proposedAt: command.createdAt,
        },
      };
    }

    case "channel.close": {
      yield* requireChannel({
        readModel,
        command,
        channelId: command.channelId,
      });
      return {
        ...withEventBase({
          aggregateKind: "channel",
          aggregateId: command.channelId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "channel.closed",
        payload: {
          channelId: command.channelId,
          closedAt: command.createdAt,
        },
      };
    }

    case "request.open": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.childThreadId !== undefined) {
        yield* requireDistinctThreadIds({
          command,
          leftLabel: "threadId",
          leftThreadId: command.threadId,
          rightLabel: "childThreadId",
          rightThreadId: command.childThreadId,
        });
        const childThread = yield* requireThreadNotArchived({
          readModel,
          command,
          threadId: command.childThreadId,
        });
        yield* requireThreadsInSameProject({
          command,
          leftLabel: "threadId",
          leftThread: thread,
          rightLabel: "childThreadId",
          rightThread: childThread,
        });
      }
      yield* requirePendingRequestAbsent({
        readModel,
        command,
        requestId: command.requestId,
      });
      return {
        ...withEventBase({
          aggregateKind: "request",
          aggregateId: command.requestId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "request.opened",
        payload: {
          requestId: command.requestId,
          threadId: command.threadId,
          childThreadId: command.childThreadId ?? null,
          phaseRunId: command.phaseRunId ?? null,
          requestType: command.requestType,
          payload: command.payload,
          createdAt: command.createdAt,
        },
      };
    }

    case "request.resolve": {
      yield* requirePendingRequest({
        readModel,
        command,
        requestId: command.requestId,
      });
      return {
        ...withEventBase({
          aggregateKind: "request",
          aggregateId: command.requestId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "request.resolved",
        payload: {
          requestId: command.requestId,
          resolvedWith: command.resolvedWith,
          resolvedAt: command.createdAt,
        },
      };
    }

    case "request.mark-stale": {
      yield* requirePendingRequest({
        readModel,
        command,
        requestId: command.requestId,
      });
      return {
        ...withEventBase({
          aggregateKind: "request",
          aggregateId: command.requestId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "request.stale",
        payload: {
          requestId: command.requestId,
          reason: command.reason,
          staleAt: command.createdAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
