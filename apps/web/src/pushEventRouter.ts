import {
  ChannelPushEvent as ChannelPushEventSchema,
  WorkflowPushEvent as WorkflowPushEventSchema,
  type ChannelPushEvent,
} from "@forgetools/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { workflowTimelineQueryKeys } from "./components/WorkflowTimeline.logic";
import { type ChannelStoreState, useChannelStore } from "./stores/channelStore";
import { type WorkflowStoreState, useWorkflowStore } from "./stores/workflowStore";

const decodeWorkflowPushEvent = Schema.decodeUnknownSync(WorkflowPushEventSchema);
const decodeChannelPushEvent = Schema.decodeUnknownSync(ChannelPushEventSchema);

type WorkflowStoreRouter = Pick<WorkflowStoreState, "applyWorkflowPushEvent">;
type ChannelStoreRouter = Pick<ChannelStoreState, "applyChannelPushEvent">;

export interface PushEventDecodeFailure {
  kind: "workflow" | "channel";
  error: unknown;
  payload: unknown;
}

export interface PushEventRouterOptions {
  queryClient: Pick<QueryClient, "invalidateQueries">;
  workflowStore?: WorkflowStoreRouter;
  channelStore?: ChannelStoreRouter;
  onDecodeFailure?: (failure: PushEventDecodeFailure) => void;
}

function getWorkflowStoreRouter(options: PushEventRouterOptions): WorkflowStoreRouter {
  return options.workflowStore ?? useWorkflowStore.getState();
}

function getChannelStoreRouter(options: PushEventRouterOptions): ChannelStoreRouter {
  return options.channelStore ?? useChannelStore.getState();
}

function invalidateWorkflowQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  event: ReturnType<typeof decodeWorkflowPushEvent>,
) {
  switch (event.channel) {
    case "workflow.phase":
      void queryClient.invalidateQueries({
        queryKey: workflowTimelineQueryKeys.phaseRuns(event.threadId),
      });
      if (event.outputs !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: workflowTimelineQueryKeys.phaseOutputPrefix(event.phaseRunId),
        });
      }
      return;
    case "workflow.gate":
      void queryClient.invalidateQueries({
        queryKey: workflowTimelineQueryKeys.phaseRuns(event.threadId),
      });
      return;
    case "workflow.quality-check":
      if (event.status !== "running") {
        void queryClient.invalidateQueries({
          queryKey: workflowTimelineQueryKeys.phaseRuns(event.threadId),
        });
      }
      return;
    case "workflow.bootstrap":
      return;
  }
}

function reportDecodeFailure(
  options: PushEventRouterOptions,
  failure: PushEventDecodeFailure,
): false {
  options.onDecodeFailure?.(failure);
  return false;
}

export function routeWorkflowPushEvent(
  payload: unknown,
  options: PushEventRouterOptions,
): payload is ReturnType<typeof decodeWorkflowPushEvent> {
  try {
    const event = decodeWorkflowPushEvent(payload);
    getWorkflowStoreRouter(options).applyWorkflowPushEvent(event);
    invalidateWorkflowQueries(options.queryClient, event);
    return true;
  } catch (error) {
    return reportDecodeFailure(options, {
      kind: "workflow",
      error,
      payload,
    });
  }
}

export function routeChannelPushEvent(
  payload: unknown,
  options: PushEventRouterOptions,
): payload is ChannelPushEvent {
  try {
    const event = decodeChannelPushEvent(payload);
    getChannelStoreRouter(options).applyChannelPushEvent(event);
    return true;
  } catch (error) {
    return reportDecodeFailure(options, {
      kind: "channel",
      error,
      payload,
    });
  }
}
