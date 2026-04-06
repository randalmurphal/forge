import { DEFAULT_SERVER_SETTINGS } from "@forgetools/contracts";
import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import * as Util from "node:util";

import { Effect, Layer, Schema } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  type DaemonNotification,
  NotificationDispatch,
  type NotificationBackend,
  type NotificationDispatchResult,
  type NotificationDispatchShape,
  type NotificationPreferences,
  type NotificationTrigger,
} from "../Services/NotificationDispatch.ts";

const execFileAsync = Util.promisify(ChildProcess.execFile);
const NOTIFICATION_LOG_SCOPE = "daemon-notification";
const FORGE_MACOS_APP_ID = "com.forgetools.forge";
const MACOS_OSASCRIPT_PATH = "/usr/bin/osascript";

export interface NotificationDispatchLiveOptions {
  readonly platform?: NodeJS.Platform;
  readonly commandExists?: (command: string) => Effect.Effect<boolean, never>;
  readonly execFile?: (
    file: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, NotificationExecError>;
}

interface ResolvedBackend {
  readonly backend: NotificationBackend;
  readonly command: string;
}

export class NotificationExecError extends Schema.TaggedErrorClass<NotificationExecError>()(
  "NotificationExecError",
  {
    command: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function toExecError(command: string, cause: unknown): NotificationExecError {
  return new NotificationExecError({
    command,
    cause: toError(cause),
  });
}

function notificationUrl(notification: DaemonNotification): string | undefined {
  return notification.sessionId === undefined
    ? undefined
    : `forge://session/${notification.sessionId}`;
}

function isTriggerEnabled(
  trigger: NotificationTrigger,
  preferences: NotificationPreferences,
): boolean {
  switch (trigger) {
    case "session-needs-attention":
      return preferences.sessionNeedsAttention;
    case "session-completed":
      return preferences.sessionCompleted;
    case "deliberation-concluded":
      return preferences.deliberationConcluded;
  }
}

function notificationPreferencesFromSettings(settings: {
  readonly notifications: NotificationPreferences;
}): NotificationPreferences {
  return settings.notifications;
}

function buildTerminalNotifierArgs(notification: DaemonNotification): ReadonlyArray<string> {
  const url = notificationUrl(notification);
  return [
    "-title",
    notification.title,
    "-message",
    notification.body,
    "-activate",
    FORGE_MACOS_APP_ID,
    ...(url === undefined ? [] : ["-open", url]),
  ];
}

function buildOsaScriptArgs(notification: DaemonNotification): ReadonlyArray<string> {
  const script =
    "on run argv\n" +
    "set notificationTitle to item 1 of argv\n" +
    "set notificationBody to item 2 of argv\n" +
    "display notification notificationBody with title notificationTitle\n" +
    "end run";
  return ["-e", script, "--", notification.title, notification.body];
}

function buildNotifySendArgs(notification: DaemonNotification): ReadonlyArray<string> {
  const url = notificationUrl(notification);
  return [
    "--app-name=Forge",
    "--icon=forge",
    ...(url === undefined ? [] : ["-h", `string:x-forge-url:${url}`]),
    notification.title,
    notification.body,
  ];
}

function resolveExecPlan(
  backend: ResolvedBackend,
  notification: DaemonNotification,
): {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
} {
  switch (backend.backend) {
    case "terminal-notifier":
      return {
        file: backend.command,
        args: buildTerminalNotifierArgs(notification),
      };
    case "osascript":
      return {
        file: backend.command,
        args: buildOsaScriptArgs(notification),
      };
    case "notify-send":
      return {
        file: backend.command,
        args: buildNotifySendArgs(notification),
      };
  }
}

const defaultExecFile = (
  file: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, NotificationExecError> =>
  Effect.tryPromise({
    try: async () => {
      await execFileAsync(file, [...args]);
    },
    catch: (cause) => toExecError(file, cause),
  });

const pathExists = (candidate: string): Effect.Effect<boolean, never> =>
  Effect.tryPromise({
    try: async () => {
      await FSP.access(candidate, FS.constants.X_OK);
      return true;
    },
    catch: () => false,
  }).pipe(Effect.catch(() => Effect.succeed(false)));

const defaultCommandExists = (command: string): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    if (Path.isAbsolute(command)) {
      return yield* pathExists(command);
    }

    const rawPath = process.env.PATH ?? "";
    if (rawPath.length === 0) {
      return false;
    }

    const entries = rawPath
      .split(Path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    for (const entry of entries) {
      const candidate = Path.join(entry, command);
      if (yield* pathExists(candidate)) {
        return true;
      }
    }

    return false;
  });

function resolveBackend(
  platform: NodeJS.Platform,
  commandExists: (command: string) => Effect.Effect<boolean, never>,
): Effect.Effect<ResolvedBackend | undefined, never> {
  switch (platform) {
    case "darwin":
      return Effect.gen(function* () {
        if (yield* commandExists("terminal-notifier")) {
          return { backend: "terminal-notifier", command: "terminal-notifier" } as const;
        }
        if (yield* commandExists("osascript")) {
          return { backend: "osascript", command: "osascript" } as const;
        }
        if (yield* commandExists(MACOS_OSASCRIPT_PATH)) {
          return { backend: "osascript", command: MACOS_OSASCRIPT_PATH } as const;
        }
        return undefined;
      });
    case "linux":
      return Effect.gen(function* () {
        if (yield* commandExists("notify-send")) {
          return { backend: "notify-send", command: "notify-send" } as const;
        }
        return undefined;
      });
    default:
      return Effect.void.pipe(Effect.as(undefined));
  }
}

const makeNotificationDispatch = (options?: NotificationDispatchLiveOptions) =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const platform = options?.platform ?? process.platform;
    const commandExists = options?.commandExists ?? defaultCommandExists;
    const execFile = options?.execFile ?? defaultExecFile;

    const getPreferences: NotificationDispatchShape["getPreferences"] =
      serverSettings.getSettings.pipe(
        Effect.map(notificationPreferencesFromSettings),
        Effect.catch((cause) =>
          Effect.logWarning("failed to read notification settings; using defaults", {
            cause,
          }).pipe(
            Effect.annotateLogs({ scope: NOTIFICATION_LOG_SCOPE }),
            Effect.as(DEFAULT_SERVER_SETTINGS.notifications),
          ),
        ),
      );

    const dispatch: NotificationDispatchShape["dispatch"] = (notification) =>
      Effect.gen(function* () {
        const preferences = yield* getPreferences;
        if (!isTriggerEnabled(notification.trigger, preferences)) {
          return {
            status: "skipped",
            reason: "disabled",
          } satisfies NotificationDispatchResult;
        }

        const backend = yield* resolveBackend(platform, commandExists);
        if (backend === undefined) {
          yield* Effect.logWarning(
            "OS notification backend unavailable; falling back to in-app only",
            {
              platform,
              trigger: notification.trigger,
            },
          ).pipe(Effect.annotateLogs({ scope: NOTIFICATION_LOG_SCOPE }));

          return {
            status: "skipped",
            reason:
              platform === "darwin" || platform === "linux"
                ? "backend-unavailable"
                : "unsupported-platform",
          } satisfies NotificationDispatchResult;
        }

        const plan = resolveExecPlan(backend, notification);
        return yield* execFile(plan.file, plan.args).pipe(
          Effect.as({
            status: "dispatched",
            backend: backend.backend,
          } satisfies NotificationDispatchResult),
          Effect.catch((cause) =>
            Effect.logWarning("OS notification dispatch failed; falling back to in-app only", {
              backend: backend.backend,
              command: plan.file,
              trigger: notification.trigger,
              cause,
            }).pipe(
              Effect.annotateLogs({ scope: NOTIFICATION_LOG_SCOPE }),
              Effect.as({
                status: "skipped",
                reason: "delivery-failed",
                backend: backend.backend,
              } satisfies NotificationDispatchResult),
            ),
          ),
        );
      });

    return {
      dispatch,
      getPreferences,
    } satisfies NotificationDispatchShape;
  });

export const NotificationDispatchLive = Layer.effect(
  NotificationDispatch,
  makeNotificationDispatch(),
);

export const makeNotificationDispatchLive = (options?: NotificationDispatchLiveOptions) =>
  Layer.effect(NotificationDispatch, makeNotificationDispatch(options));
