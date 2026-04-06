import { ThreadId } from "@forgetools/contracts";
import { Schema, ServiceMap, type Effect } from "effect";

export const NotificationTrigger = Schema.Literals([
  "session-needs-attention",
  "session-completed",
  "deliberation-concluded",
]);
export type NotificationTrigger = typeof NotificationTrigger.Type;

export const DaemonNotification = Schema.Struct({
  trigger: NotificationTrigger,
  title: Schema.String,
  body: Schema.String,
  sessionId: Schema.optional(ThreadId),
});
export type DaemonNotification = typeof DaemonNotification.Type;

export interface NotificationPreferences {
  readonly sessionNeedsAttention: boolean;
  readonly sessionCompleted: boolean;
  readonly deliberationConcluded: boolean;
}

export type NotificationBackend = "terminal-notifier" | "osascript" | "notify-send";

export type NotificationDispatchResult =
  | {
      readonly status: "dispatched";
      readonly backend: NotificationBackend;
    }
  | {
      readonly status: "skipped";
      readonly reason:
        | "disabled"
        | "backend-unavailable"
        | "unsupported-platform"
        | "delivery-failed";
      readonly backend?: NotificationBackend;
    };

export interface NotificationDispatchShape {
  readonly dispatch: (
    notification: DaemonNotification,
  ) => Effect.Effect<NotificationDispatchResult, never>;
  readonly getPreferences: Effect.Effect<NotificationPreferences, never>;
}

export class NotificationDispatch extends ServiceMap.Service<
  NotificationDispatch,
  NotificationDispatchShape
>()("forge/daemon/Services/NotificationDispatch") {}
