import { ThreadId } from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { NotificationDispatch } from "../Services/NotificationDispatch.ts";
import { makeNotificationDispatchLive, NotificationExecError } from "./NotificationDispatch.ts";

interface ExecCall {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

const makeLayer = (options: {
  readonly platform: NodeJS.Platform;
  readonly availableCommands: ReadonlySet<string>;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  readonly execCalls: Array<ExecCall>;
  readonly failExec?: boolean;
}) =>
  makeNotificationDispatchLive({
    platform: options.platform,
    commandExists: (command) => Effect.succeed(options.availableCommands.has(command)),
    execFile: (file, args) =>
      options.failExec
        ? Effect.fail(
            new NotificationExecError({
              command: file,
              cause: new Error(`failed to exec ${file}`),
            }),
          )
        : Effect.sync(() => {
            options.execCalls.push({
              file,
              args: [...args],
            });
          }),
  }).pipe(Layer.provide(ServerSettingsService.layerTest(options.settings)));

it.effect("dispatches macOS notifications with terminal-notifier argv arrays", () => {
  const execCalls: Array<ExecCall> = [];
  return Effect.gen(function* () {
    const notifications = yield* NotificationDispatch;

    const result = yield* notifications.dispatch({
      trigger: "session-needs-attention",
      title: "Build requires approval",
      body: "Review the gate result before continuing.",
      sessionId: ThreadId.makeUnsafe("thread-approval"),
    });

    assert.deepStrictEqual(result, {
      status: "dispatched",
      backend: "terminal-notifier",
    });
    assert.deepStrictEqual(execCalls, [
      {
        file: "terminal-notifier",
        args: [
          "-title",
          "Build requires approval",
          "-message",
          "Review the gate result before continuing.",
          "-activate",
          "com.forgetools.forge",
          "-open",
          "forge://session/thread-approval",
        ],
      },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer({
        platform: "darwin",
        availableCommands: new Set(["terminal-notifier"]),
        execCalls,
      }),
    ),
  );
});

it.effect("falls back to osascript on macOS when terminal-notifier is unavailable", () => {
  const execCalls: Array<ExecCall> = [];
  return Effect.gen(function* () {
    const notifications = yield* NotificationDispatch;

    const result = yield* notifications.dispatch({
      trigger: "session-completed",
      title: "Implement phase complete",
      body: "Forge finished the active session.",
    });

    assert.deepStrictEqual(result, {
      status: "dispatched",
      backend: "osascript",
    });
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0]?.file, "osascript");
    assert.deepStrictEqual(execCalls[0]?.args.slice(0, 3), [
      "-e",
      "on run argv\nset notificationTitle to item 1 of argv\nset notificationBody to item 2 of argv\ndisplay notification notificationBody with title notificationTitle\nend run",
      "--",
    ]);
    assert.deepStrictEqual(execCalls[0]?.args.slice(3), [
      "Implement phase complete",
      "Forge finished the active session.",
    ]);
  }).pipe(
    Effect.provide(
      makeLayer({
        platform: "darwin",
        availableCommands: new Set(["osascript"]),
        execCalls,
      }),
    ),
  );
});

it.effect("dispatches Linux notifications with notify-send argv arrays", () => {
  const execCalls: Array<ExecCall> = [];
  return Effect.gen(function* () {
    const notifications = yield* NotificationDispatch;

    const result = yield* notifications.dispatch({
      trigger: "deliberation-concluded",
      title: "Review debate finished",
      body: "Open the session to inspect the conclusion.",
      sessionId: ThreadId.makeUnsafe("thread-review"),
    });

    assert.deepStrictEqual(result, {
      status: "dispatched",
      backend: "notify-send",
    });
    assert.deepStrictEqual(execCalls, [
      {
        file: "notify-send",
        args: [
          "--app-name=Forge",
          "--icon=forge",
          "-h",
          "string:x-forge-url:forge://session/thread-review",
          "Review debate finished",
          "Open the session to inspect the conclusion.",
        ],
      },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer({
        platform: "linux",
        availableCommands: new Set(["notify-send"]),
        execCalls,
      }),
    ),
  );
});

it.effect("skips OS delivery when no notifier backend exists", () => {
  const execCalls: Array<ExecCall> = [];
  return Effect.gen(function* () {
    const notifications = yield* NotificationDispatch;

    const result = yield* notifications.dispatch({
      trigger: "session-needs-attention",
      title: "Approval needed",
      body: "No desktop notifier is installed.",
    });

    assert.deepStrictEqual(result, {
      status: "skipped",
      reason: "backend-unavailable",
    });
    assert.deepStrictEqual(execCalls, []);
  }).pipe(
    Effect.provide(
      makeLayer({
        platform: "linux",
        availableCommands: new Set(),
        execCalls,
      }),
    ),
  );
});

it.effect("respects notification trigger preferences from server settings", () => {
  const execCalls: Array<ExecCall> = [];
  return Effect.gen(function* () {
    const notifications = yield* NotificationDispatch;

    const result = yield* notifications.dispatch({
      trigger: "session-completed",
      title: "Should stay silent",
      body: "This notification is disabled in settings.",
    });

    assert.deepStrictEqual(result, {
      status: "skipped",
      reason: "disabled",
    });
    assert.deepStrictEqual(execCalls, []);
  }).pipe(
    Effect.provide(
      makeLayer({
        platform: "darwin",
        availableCommands: new Set(["terminal-notifier"]),
        execCalls,
        settings: {
          notifications: {
            sessionCompleted: false,
          },
        },
      }),
    ),
  );
});

it.effect("passes special characters through argv without shell interpolation", () => {
  const execCalls: Array<ExecCall> = [];
  return Effect.gen(function* () {
    const notifications = yield* NotificationDispatch;
    const title = 'Gate "review" `$HOME`';
    const body = "Line 1\nLine 2 with 'quotes' and $(subshell)";

    const result = yield* notifications.dispatch({
      trigger: "session-needs-attention",
      title,
      body,
      sessionId: ThreadId.makeUnsafe("thread-special"),
    });

    assert.deepStrictEqual(result, {
      status: "dispatched",
      backend: "terminal-notifier",
    });
    assert.deepStrictEqual(execCalls, [
      {
        file: "terminal-notifier",
        args: [
          "-title",
          title,
          "-message",
          body,
          "-activate",
          "com.forgetools.forge",
          "-open",
          "forge://session/thread-special",
        ],
      },
    ]);
  }).pipe(
    Effect.provide(
      makeLayer({
        platform: "darwin",
        availableCommands: new Set(["terminal-notifier"]),
        execCalls,
      }),
    ),
  );
});

it.effect("treats exec failures as non-fatal fallback to in-app notifications", () => {
  const execCalls: Array<ExecCall> = [];
  return Effect.gen(function* () {
    const notifications = yield* NotificationDispatch;

    const result = yield* notifications.dispatch({
      trigger: "session-needs-attention",
      title: "Dispatch fails",
      body: "The daemon should keep running.",
    });

    assert.deepStrictEqual(result, {
      status: "skipped",
      reason: "delivery-failed",
      backend: "notify-send",
    });
    assert.deepStrictEqual(execCalls, []);
  }).pipe(
    Effect.provide(
      makeLayer({
        platform: "linux",
        availableCommands: new Set(["notify-send"]),
        execCalls,
        failExec: true,
      }),
    ),
  );
});
