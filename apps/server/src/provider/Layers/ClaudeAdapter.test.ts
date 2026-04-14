import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { InteractiveRequestId, ProviderItemId, ProviderRuntimeEvent } from "@forgetools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Random, Stream } from "effect";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapterLive } from "./ClaudeAdapter.ts";
import {
  FakeClaudeQuery,
  makeHarness,
  makeDeterministicRandomService,
  readFirstPromptText,
  readFirstPromptMessage,
  THREAD_ID,
} from "./claude/testHarness.ts";

describe("ClaudeAdapterLive", () => {
  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({ threadId: THREAD_ID, provider: "codex", runtimeMode: "full-access" })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("loads Claude filesystem settings sources for SDK sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, undefined);
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses bypass permissions for full-access claude sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to default effort when unsupported max is requested for Sonnet 4.6", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores adaptive effort for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: {
            effort: "high",
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle into SDK settings for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          options: {
            thinking: false,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        alwaysThinkingEnabled: false,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking toggle for non-Haiku models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            thinking: false,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards claude fast mode into SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for non-opus models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats ultrathink as a prompt keyword instead of a session effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "ultrathink",
          },
        },
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "ultrathink",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(promptText, "Ultrathink:\nInvestigate the edge cases");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "text",
          text: "What's in this image?",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: "src/example.ts:1:foo",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "search");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("includes exact file-change diff data on Claude write tool results", () => {
    const cwd = "/tmp/claude-adapter-write-diff";
    const harness = makeHarness({ cwd });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "update the file",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-write-tool",
        uuid: "stream-write-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-write-1",
            name: "Write",
            input: {
              file_path: path.join(cwd, "apps/server/src/example.ts"),
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-write-tool",
        uuid: "user-write-result",
        parent_tool_use_id: null,
        tool_use_result: {
          type: "update",
          filePath: path.join(cwd, "apps/server/src/example.ts"),
          content: ["export const value = 1;", "export const next = 2;"].join("\n"),
          originalFile: "export const value = 1;\n",
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 2,
              lines: [" export const value = 1;", "+export const next = 2;"],
            },
          ],
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-write-1",
              content: "Updated apps/server/src/example.ts",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-write-tool",
        uuid: "result-write-tool",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "item.started",
          "item.updated",
          "turn.diff.updated",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { unifiedDiff?: unknown } | undefined)?.unifiedDiff !== undefined,
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        const payloadData = toolResultUpdated.payload.data as {
          toolUseResult?: { filePath?: string };
          unifiedDiff?: string;
        };
        assert.equal(
          payloadData.toolUseResult?.filePath,
          path.join(cwd, "apps/server/src/example.ts"),
        );
        assert.equal(
          (payloadData.unifiedDiff?.includes("diff --git a/") ?? false) &&
            (payloadData.unifiedDiff?.includes("example.ts") ?? false),
          true,
        );
      }

      const turnDiffUpdated = runtimeEvents.find((event) => event.type === "turn.diff.updated");
      assert.equal(turnDiffUpdated?.type, "turn.diff.updated");
      if (turnDiffUpdated?.type === "turn.diff.updated") {
        assert.equal(String(turnDiffUpdated.turnId), String(turn.turnId));
        assert.equal(turnDiffUpdated.payload.coverage, "complete");
        assert.equal(turnDiffUpdated.payload.unifiedDiff.includes("example.ts"), true);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);

      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = makeClaudeAdapterLive({
      createQuery: (input) => {
        // Simulate the SDK consuming the prompt iterable
        (async () => {
          try {
            for await (const _message of input.prompt) {
              /* SDK processes user messages */
            }
          } catch (error) {
            promptConsumerError = error;
          }
        })();
        return query;
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);

      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, () => Effect.void),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves Claude background bash task metadata on command results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "run a background bash command",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-bg-bash",
        uuid: "stream-bg-bash-tool",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-bash-bg-1",
            name: "Bash",
            input: {
              command: "sleep 20",
              run_in_background: true,
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-bg-bash",
        uuid: "user-bg-bash-result",
        parent_tool_use_id: null,
        tool_use_result: {
          stdout: "",
          stderr: "",
          interrupted: false,
          backgroundTaskId: "task-bash-bg-1",
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-bash-bg-1",
              content: "",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-bg-bash",
        uuid: "result-bg-bash",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();
      const completedEvent = runtimeEvents.find((event) => event.type === "item.completed");
      assert.equal(completedEvent?.type, "item.completed");
      if (completedEvent?.type === "item.completed") {
        const payloadData = completedEvent.payload.data as Record<string, unknown> | undefined;
        const toolUseResult = payloadData?.toolUseResult as Record<string, unknown> | undefined;
        assert.equal(completedEvent.payload.itemType, "command_execution");
        assert.equal(toolUseResult?.backgroundTaskId, "task-bash-bg-1");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves Claude task toolUseId on parent-thread task lifecycle events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-bash-bg-2",
        tool_use_id: "tool-bash-bg-2",
        description: "Background bash is running",
        session_id: "sdk-session-task-started",
        uuid: "task-started-bg-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-bash-bg-2",
        tool_use_id: "tool-bash-bg-2",
        description: "Background bash is still running",
        usage: {
          total_tokens: 42,
          tool_uses: 1,
          duration_ms: 500,
        },
        session_id: "sdk-session-task-progress",
        uuid: "task-progress-bg-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-bash-bg-2",
        tool_use_id: "tool-bash-bg-2",
        status: "completed",
        output_file: "/tmp/task-bash-bg-2.txt",
        summary: "Background bash completed",
        session_id: "sdk-session-task-completed",
        uuid: "task-completed-bg-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();
      const startedEvent = runtimeEvents.find((event) => event.type === "task.started");
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      const completedEvent = runtimeEvents.find((event) => event.type === "task.completed");

      assert.equal(startedEvent?.type, "task.started");
      if (startedEvent?.type === "task.started") {
        assert.equal(startedEvent.payload.toolUseId, "tool-bash-bg-2");
      }

      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(progressEvent.payload.toolUseId, "tool-bash-bg-2");
      }

      assert.equal(completedEvent?.type, "task.completed");
      if (completedEvent?.type === "task.completed") {
        assert.equal(completedEvent.payload.toolUseId, "tool-bash-bg-2");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "keeps Claude background agent attribution alive until task notification completes",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "launch a background agent",
          attachments: [],
        });

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-bg-agent",
          uuid: "stream-bg-agent-tool",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-agent-bg-1",
              name: "Agent",
              input: {
                description: "Sleep 20 seconds subagent",
                prompt: "Run sleep 20 and report completion.",
                model: "sonnet",
                run_in_background: true,
              },
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "user",
          session_id: "sdk-session-bg-agent",
          uuid: "user-bg-agent-result",
          parent_tool_use_id: null,
          tool_use_result: {
            status: "async_launched",
            agentId: "agent-bg-1",
            description: "Sleep 20 seconds subagent",
            prompt: "Run sleep 20 and report completion.",
            outputFile: "/tmp/agent-bg-1.log",
          },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-agent-bg-1",
                content: "",
              },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-agent-bg-1",
          tool_use_id: "tool-agent-bg-1",
          description: "Sleep 20 seconds subagent",
          task_type: "agent",
          session_id: "sdk-session-bg-agent",
          uuid: "task-started-agent-1",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-agent-bg-1",
          tool_use_id: "tool-agent-bg-1",
          description: "Sleep 20 seconds subagent",
          summary: "The spawned agent is still sleeping.",
          usage: {
            total_tokens: 12,
            tool_uses: 1,
            duration_ms: 1000,
          },
          session_id: "sdk-session-bg-agent",
          uuid: "task-progress-agent-1",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-agent-bg-1",
          tool_use_id: "tool-agent-bg-1",
          status: "completed",
          output_file: "/tmp/agent-bg-1.log",
          summary: "Sleep 20 seconds subagent completed",
          session_id: "sdk-session-bg-agent",
          uuid: "task-completed-agent-1",
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        runtimeEventsFiber.interruptUnsafe();

        const expectedAttribution = {
          taskId: "tool-agent-bg-1",
          childProviderThreadId: "tool-agent-bg-1",
          label: "Sleep 20 seconds subagent",
          agentModel: "sonnet",
        };

        const startedEvent = runtimeEvents.find((event) => event.type === "task.started");
        const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
        const completedEvent = runtimeEvents.find((event) => event.type === "task.completed");

        assert.equal(startedEvent?.type, "task.started");
        if (startedEvent?.type === "task.started") {
          assert.deepEqual(
            (startedEvent.payload as Record<string, unknown>).childThreadAttribution,
            expectedAttribution,
          );
        }

        assert.equal(progressEvent?.type, "task.progress");
        if (progressEvent?.type === "task.progress") {
          assert.deepEqual(
            (progressEvent.payload as Record<string, unknown>).childThreadAttribution,
            expectedAttribution,
          );
        }

        assert.equal(completedEvent?.type, "task.completed");
        if (completedEvent?.type === "task.completed") {
          assert.deepEqual(
            (completedEvent.payload as Record<string, unknown>).childThreadAttribution,
            expectedAttribution,
          );
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "registers agent metadata from full assistant messages (non-streamed) for childThreadAttribution",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "launch a background agent",
          attachments: [],
        });

        // Real SDK sends Agent tool_use as a full assistant message, NOT as stream_event
        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-full-msg",
          uuid: "assistant-full-agent",
          parent_tool_use_id: null,
          message: {
            model: "claude-opus-4-6",
            id: "msg-full-agent",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-agent-full-1",
                name: "Agent",
                input: {
                  description: "2-second sleep test",
                  subagent_type: "Builder",
                  model: "opus",
                  prompt: "Run sleep 2 && echo done",
                },
              },
            ],
          },
        } as unknown as SDKMessage);

        // task_started arrives referencing the same tool_use_id
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-full-1",
          tool_use_id: "tool-agent-full-1",
          description: "2-second sleep test",
          task_type: "agent",
          session_id: "sdk-session-full-msg",
          uuid: "task-started-full-1",
        } as unknown as SDKMessage);

        // task_completed
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-full-1",
          tool_use_id: "tool-agent-full-1",
          status: "completed",
          output_file: "",
          summary: "2-second sleep test completed",
          session_id: "sdk-session-full-msg",
          uuid: "task-completed-full-1",
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        runtimeEventsFiber.interruptUnsafe();

        const expectedAttribution = {
          taskId: "tool-agent-full-1",
          childProviderThreadId: "tool-agent-full-1",
          label: "2-second sleep test",
          agentType: "Builder",
          agentModel: "opus",
        };

        const startedEvent = runtimeEvents.find((event) => event.type === "task.started");
        assert.ok(startedEvent, "expected a task.started event");
        assert.deepEqual(
          (startedEvent!.payload as Record<string, unknown>).childThreadAttribution,
          expectedAttribution,
          "task.started should carry full childThreadAttribution including agentType and agentModel",
        );

        const completedEvent = runtimeEvents.find((event) => event.type === "task.completed");
        assert.ok(completedEvent, "expected a task.completed event");
        assert.deepEqual(
          (completedEvent!.payload as Record<string, unknown>).childThreadAttribution,
          expectedAttribution,
          "task.completed should carry full childThreadAttribution including agentType and agentModel",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "maps Claude local_command_output into assistant text instead of runtime warnings",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "show a local command output message",
          attachments: [],
        });

        harness.query.emit({
          type: "system",
          subtype: "local_command_output",
          content: "Slash command output",
          session_id: "sdk-session-local-command-output",
          uuid: "local-command-output-1",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-local-command-output",
          uuid: "result-local-command-output-1",
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        runtimeEventsFiber.interruptUnsafe();

        const warningEvent = runtimeEvents.find((event) => event.type === "runtime.warning");
        const deltaEvent = runtimeEvents.find(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        );

        assert.isUndefined(warningEvent);
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Slash command output");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "emits task.completed from task_notification when task_updated marked terminal but no task.completed was emitted",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        // task_updated with terminal status arrives first
        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: "task-bash-bg-3",
          patch: {
            status: "completed",
            end_time: 1_775_969_368_152,
          },
          session_id: "sdk-session-task-updated",
          uuid: "task-updated-bg-1",
        } as unknown as SDKMessage);

        // task_notification arrives later for the same task
        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-bash-bg-3",
          tool_use_id: "tool-bash-bg-3",
          status: "completed",
          output_file: "/tmp/task-bash-bg-3.txt",
          summary: "Background bash completed",
          session_id: "sdk-session-task-notification",
          uuid: "task-notification-bg-1",
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        runtimeEventsFiber.interruptUnsafe();

        const warningEvents = runtimeEvents.filter((event) => event.type === "runtime.warning");
        const updatedEvents = runtimeEvents.filter((event) => event.type === "task.updated");
        const completedEvents = runtimeEvents.filter((event) => event.type === "task.completed");

        assert.deepEqual(warningEvents, []);
        // task_updated emits task.updated and marks the task terminal (in
        // terminalTaskIds). task_notification checks completedTaskIds —
        // since no task.completed was emitted yet, it emits task.completed.
        assert.equal(updatedEvents.length, 1);
        assert.equal(completedEvents.length, 1);
        assert.equal(completedEvents[0]?.type, "task.completed");
        if (completedEvents[0]?.type === "task.completed") {
          assert.equal(completedEvents[0].payload.taskId, "task-bash-bg-3");
          assert.equal(completedEvents[0].payload.status, "completed");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "preserves childThreadAttribution when task_notification completes a task after terminal task.updated",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "launch a background agent",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-task-updated-agent",
          uuid: "assistant-task-updated-agent",
          parent_tool_use_id: null,
          message: {
            model: "claude-opus-4-6",
            id: "msg-task-updated-agent",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-agent-task-updated",
                name: "Agent",
                input: {
                  description: "Background verifier",
                  subagent_type: "Reviewer",
                  model: "opus",
                  prompt: "Check the generated output.",
                },
              },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-agent-task-updated",
          tool_use_id: "tool-agent-task-updated",
          description: "Background verifier",
          task_type: "agent",
          session_id: "sdk-session-task-updated-agent",
          uuid: "task-started-task-updated-agent",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: "task-agent-task-updated",
          patch: {
            status: "completed",
            end_time: 1_775_969_368_152,
          },
          session_id: "sdk-session-task-updated-agent",
          uuid: "task-updated-task-updated-agent",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-agent-task-updated",
          tool_use_id: "tool-agent-task-updated",
          status: "completed",
          output_file: "/tmp/task-agent-task-updated.output",
          summary: "Background verifier completed",
          session_id: "sdk-session-task-updated-agent",
          uuid: "task-notification-task-updated-agent",
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        runtimeEventsFiber.interruptUnsafe();

        const completedEvent = runtimeEvents.find((event) => event.type === "task.completed");
        assert.equal(completedEvent?.type, "task.completed");
        if (completedEvent?.type === "task.completed") {
          assert.deepEqual(
            (completedEvent.payload as Record<string, unknown>).childThreadAttribution,
            {
              taskId: "tool-agent-task-updated",
              childProviderThreadId: "tool-agent-task-updated",
              label: "Background verifier",
              agentType: "Reviewer",
              agentModel: "opus",
            },
          );
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("marks task terminal from task_updated but does not emit task.completed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-bash-bg-no-notification",
        patch: {
          status: "completed",
          end_time: 1_775_969_368_152,
        },
        session_id: "sdk-session-task-updated-only",
        uuid: "task-updated-only-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const warningEvents = runtimeEvents.filter((event) => event.type === "runtime.warning");
      const completedEvents = runtimeEvents.filter((event) => event.type === "task.completed");
      const updatedEvents = runtimeEvents.filter((event) => event.type === "task.updated");

      assert.deepEqual(warningEvents, []);
      // task_updated emits task.updated only — task.completed comes from
      // TaskOutput (authoritative) or task_notification (fallback).
      assert.equal(updatedEvents.length, 1);
      assert.equal(completedEvents.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "emits task.completed from a terminal TaskOutput result using stored task attribution",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "wait for the background bash task",
          attachments: [],
        });

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-taskoutput-terminal",
          uuid: "stream-taskoutput-start",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "tool-taskoutput-1",
              name: "TaskOutput",
              input: {
                task_id: "task-bash-bg-terminal",
                block: true,
                timeout: 60_000,
              },
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-taskoutput-terminal",
          uuid: "stream-taskoutput-stop",
          parent_tool_use_id: null,
          event: {
            type: "content_block_stop",
            index: 1,
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-bash-bg-terminal",
          tool_use_id: "tool-bash-launch-terminal",
          description: "Background bash is running",
          task_type: "local_bash",
          session_id: "sdk-session-taskoutput-terminal",
          uuid: "task-started-terminal",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "user",
          session_id: "sdk-session-taskoutput-terminal",
          uuid: "user-taskoutput-terminal",
          parent_tool_use_id: null,
          tool_use_result: {
            retrieval_status: "success",
            task: {
              task_id: "task-bash-bg-terminal",
              task_type: "local_bash",
              status: "completed",
              description: "Background bash is running",
              output_file: "/tmp/task-bash-bg-terminal.output",
            },
          },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-taskoutput-1",
                content: "",
              },
            ],
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        runtimeEventsFiber.interruptUnsafe();

        const completedEvents = runtimeEvents.filter((event) => event.type === "task.completed");
        assert.equal(completedEvents.length, 1);
        const completedEvent = completedEvents[0];
        assert.equal(completedEvent?.type, "task.completed");
        if (completedEvent?.type === "task.completed") {
          assert.equal(completedEvent.payload.taskId, "task-bash-bg-terminal");
          assert.equal(completedEvent.payload.toolUseId, "tool-bash-launch-terminal");
          assert.equal(completedEvent.payload.status, "completed");
          assert.equal(completedEvent.payload.outputFile, "/tmp/task-bash-bg-terminal.output");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "does not emit a duplicate terminal task.completed from TaskOutput after terminal task.updated",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "wait for the background agent task",
          attachments: [],
        });

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-taskoutput-dedupe",
          uuid: "stream-taskoutput-dedupe-start",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "tool-taskoutput-2",
              name: "TaskOutput",
              input: {
                task_id: "task-agent-terminal",
                block: true,
                timeout: 60_000,
              },
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-taskoutput-dedupe",
          uuid: "stream-taskoutput-dedupe-stop",
          parent_tool_use_id: null,
          event: {
            type: "content_block_stop",
            index: 1,
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-agent-terminal",
          tool_use_id: "tool-agent-launch-terminal",
          description: "Background agent is running",
          task_type: "local_agent",
          session_id: "sdk-session-taskoutput-dedupe",
          uuid: "task-started-dedupe",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: "task-agent-terminal",
          patch: {
            status: "completed",
            end_time: 1_775_969_368_152,
          },
          session_id: "sdk-session-taskoutput-dedupe",
          uuid: "task-updated-dedupe",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "user",
          session_id: "sdk-session-taskoutput-dedupe",
          uuid: "user-taskoutput-dedupe",
          parent_tool_use_id: null,
          tool_use_result: {
            retrieval_status: "success",
            task: {
              task_id: "task-agent-terminal",
              task_type: "local_agent",
              status: "completed",
              description: "Background agent is running",
            },
          },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-taskoutput-2",
                content: "",
              },
            ],
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        runtimeEventsFiber.interruptUnsafe();

        const completedEvents = runtimeEvents.filter((event) => event.type === "task.completed");
        const updatedEvents = runtimeEvents.filter((event) => event.type === "task.updated");

        // TaskOutput is the authoritative completion signal — it always emits
        // task.completed even if task_updated already marked the task terminal.
        // This fixture only seeds task_started metadata, so we can recover the
        // original toolUseId but not full childThreadAttribution.
        assert.equal(completedEvents.length, 1);
        assert.equal(completedEvents[0]?.type, "task.completed");
        if (completedEvents[0]?.type === "task.completed") {
          assert.equal(completedEvents[0].payload.taskId, "task-agent-terminal");
          assert.equal(completedEvents[0].payload.toolUseId, "tool-agent-launch-terminal");
          assert.equal(completedEvents[0].payload.status, "completed");
          assert.equal(
            (completedEvents[0].payload as Record<string, unknown>).childThreadAttribution,
            undefined,
          );
        }
        assert.equal(updatedEvents.length, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "suppresses duplicate task_notification after TaskOutput already emitted task.completed",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "wait for the background bash task",
          attachments: [],
        });

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-taskoutput-duplicate-notification",
          uuid: "stream-taskoutput-duplicate-notification-start",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 1,
            content_block: {
              type: "tool_use",
              id: "tool-taskoutput-duplicate-notification",
              name: "TaskOutput",
              input: {
                task_id: "task-bash-duplicate-notification",
                block: true,
                timeout: 60_000,
              },
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-taskoutput-duplicate-notification",
          uuid: "stream-taskoutput-duplicate-notification-stop",
          parent_tool_use_id: null,
          event: {
            type: "content_block_stop",
            index: 1,
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-bash-duplicate-notification",
          tool_use_id: "tool-bash-duplicate-notification",
          description: "Background bash duplicate notification",
          task_type: "local_bash",
          session_id: "sdk-session-taskoutput-duplicate-notification",
          uuid: "task-started-duplicate-notification",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "user",
          session_id: "sdk-session-taskoutput-duplicate-notification",
          uuid: "user-taskoutput-duplicate-notification",
          parent_tool_use_id: null,
          tool_use_result: {
            retrieval_status: "success",
            task: {
              task_id: "task-bash-duplicate-notification",
              task_type: "local_bash",
              status: "completed",
              description: "Background bash duplicate notification",
              output_file: "/tmp/task-bash-duplicate-notification.output",
            },
          },
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-taskoutput-duplicate-notification",
                content: "",
              },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-bash-duplicate-notification",
          tool_use_id: "tool-bash-duplicate-notification",
          status: "completed",
          output_file: "/tmp/task-bash-duplicate-notification.output",
          summary: "Background bash duplicate notification completed",
          session_id: "sdk-session-taskoutput-duplicate-notification",
          uuid: "task-notification-duplicate-notification",
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        runtimeEventsFiber.interruptUnsafe();

        const completedEvents = runtimeEvents.filter((event) => event.type === "task.completed");
        const updatedEvents = runtimeEvents.filter((event) => event.type === "task.updated");

        assert.equal(completedEvents.length, 1);
        assert.equal(updatedEvents.length, 0);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "emits task.updated with terminal status patch and childThreadAttribution from task_started",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const services = yield* Effect.services();
        const runFork = Effect.runForkWith(services);
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "launch a background agent for task_updated test",
          attachments: [],
        });

        // Register Agent tool_use so it appears in activeSubagentTools
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-task-updated-terminal",
          uuid: "stream-agent-tool-updated",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-agent-updated-1",
              name: "Agent",
              input: {
                description: "Auth check subagent",
                prompt: "Check auth module",
                model: "sonnet",
              },
            },
          },
        } as unknown as SDKMessage);

        // task_started registers attribution by task_id
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-updated-1",
          tool_use_id: "tool-agent-updated-1",
          description: "Auth check subagent",
          task_type: "agent",
          session_id: "sdk-session-task-updated-terminal",
          uuid: "task-started-updated-1",
        } as unknown as SDKMessage);

        // task_updated with terminal patch
        harness.query.emit({
          type: "system",
          subtype: "task_updated",
          task_id: "task-updated-1",
          patch: {
            status: "completed",
            end_time: 123456,
          },
          session_id: "sdk-session-task-updated-terminal",
          uuid: "task-updated-terminal-1",
        } as unknown as SDKMessage);
        harness.query.finish();

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
        runtimeEventsFiber.interruptUnsafe();

        const updatedEvent = runtimeEvents.find((event) => event.type === "task.updated");
        assert.equal(updatedEvent?.type, "task.updated");
        if (updatedEvent?.type === "task.updated") {
          assert.equal(updatedEvent.payload.taskId, "task-updated-1");
          const patch = updatedEvent.payload.patch as Record<string, unknown>;
          assert.equal(patch.status, "completed");
          assert.equal(patch.endTime, 123456);
          // childThreadAttribution should be resolved from task_started attribution
          const attribution = (updatedEvent.payload as Record<string, unknown>)
            .childThreadAttribution as Record<string, unknown> | undefined;
          assert.ok(attribution, "task.updated should carry childThreadAttribution");
          assert.equal(attribution!.taskId, "tool-agent-updated-1");
          assert.equal(attribution!.label, "Auth check subagent");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("emits task.updated with non-terminal status without clearing attribution", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      // task_started (without Agent tool_use — no attribution)
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-running-1",
        tool_use_id: "tool-running-1",
        description: "Background task running",
        session_id: "sdk-session-running",
        uuid: "task-started-running-1",
      } as unknown as SDKMessage);

      // task_updated with non-terminal status
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-running-1",
        patch: {
          status: "running",
          description: "Still working",
        },
        session_id: "sdk-session-running",
        uuid: "task-updated-running-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const updatedEvent = runtimeEvents.find((event) => event.type === "task.updated");
      assert.equal(updatedEvent?.type, "task.updated");
      if (updatedEvent?.type === "task.updated") {
        assert.equal(updatedEvent.payload.taskId, "task-running-1");
        const patch = updatedEvent.payload.patch as Record<string, unknown>;
        assert.equal(patch.status, "running");
        assert.equal(patch.description, "Still working");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps session_state_changed states correctly", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      // Emit three session_state_changed messages with different states
      harness.query.emit({
        type: "system",
        subtype: "session_state_changed",
        state: "idle",
        session_id: "sdk-session-state-1",
        uuid: "state-idle-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "session_state_changed",
        state: "running",
        session_id: "sdk-session-state-2",
        uuid: "state-running-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "session_state_changed",
        state: "requires_action",
        session_id: "sdk-session-state-3",
        uuid: "state-requires-action-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const stateEvents = runtimeEvents.filter(
        (event) =>
          event.type === "session.state.changed" &&
          // Exclude the startup "ready" state emitted during startSession
          (event.payload as { state: string }).state !== "ready",
      );

      assert.equal(stateEvents.length, 3);

      const payloads = stateEvents.map((event) => (event.payload as { state: string }).state);
      assert.deepEqual(payloads, ["idle", "running", "waiting"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits session.state.changed with retry detail from api_retry", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 3000,
        error_status: 429,
        error: "rate_limit",
        session_id: "sdk-session-api-retry",
        uuid: "api-retry-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const retryEvent = runtimeEvents.find(
        (event) =>
          event.type === "session.state.changed" &&
          (event.payload as Record<string, unknown>).reason === "api_retry",
      );
      assert.ok(retryEvent, "api_retry should emit session.state.changed");
      if (retryEvent?.type === "session.state.changed") {
        const payload = retryEvent.payload as Record<string, unknown>;
        assert.equal(payload.state, "waiting");
        assert.equal(payload.reason, "api_retry");
        const detail = payload.detail as Record<string, unknown>;
        assert.equal(detail.attempt, 2);
        assert.equal(detail.maxRetries, 5);
        assert.equal(detail.retryDelayMs, 3000);
        assert.equal(detail.errorStatus, 429);
        assert.equal(detail.error, "rate_limit");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("silently acknowledges prompt_suggestion without runtime warning", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "prompt_suggestion",
        suggestion: "Try running the tests",
        uuid: "prompt-suggestion-1",
        session_id: "sdk-session-prompt-suggestion",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const warningEvents = runtimeEvents.filter((event) => event.type === "runtime.warning");
      assert.deepEqual(warningEvents, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("silently acknowledges elicitation_complete without runtime warning", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "elicitation_complete",
        mcp_server_name: "test",
        elicitation_id: "elic-1",
        uuid: "elicitation-complete-1",
        session_id: "sdk-session-elicitation",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const warningEvents = runtimeEvents.filter((event) => event.type === "runtime.warning");
      assert.deepEqual(warningEvents, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards prompt and workflowName from task_started", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-prompt-wf-1",
        tool_use_id: "tool-prompt-wf-1",
        description: "Background spec task",
        prompt: "Check auth module",
        workflow_name: "spec",
        session_id: "sdk-session-task-prompt",
        uuid: "task-started-prompt-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const startedEvent = runtimeEvents.find((event) => event.type === "task.started");
      assert.equal(startedEvent?.type, "task.started");
      if (startedEvent?.type === "task.started") {
        const payload = startedEvent.payload as Record<string, unknown>;
        assert.equal(payload.prompt, "Check auth module");
        assert.equal(payload.workflowName, "spec");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves originating Monitor tool metadata on task lifecycle events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "watch the dev server",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-monitor",
        uuid: "stream-monitor-tool",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-monitor-1",
            name: "Monitor",
            input: {
              command: "bun run dev",
              description: "Watch the dev server",
              timeout_ms: 30000,
              persistent: false,
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-monitor-1",
        tool_use_id: "tool-monitor-1",
        description: "Watch the dev server",
        task_type: "local_bash",
        session_id: "sdk-session-monitor",
        uuid: "task-started-monitor-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-monitor",
        uuid: "user-monitor-result",
        parent_tool_use_id: null,
        tool_use_result: {
          message: "Monitor started (task task-monitor-1, timeout 30000ms)",
        },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-monitor-1",
              content: "Monitor started (task task-monitor-1, timeout 30000ms)",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-monitor-1",
        tool_use_id: "tool-monitor-1",
        status: "stopped",
        summary: "Monitor stopped after timeout",
        session_id: "sdk-session-monitor",
        uuid: "task-notification-monitor-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-monitor-1",
        patch: {
          status: "killed",
          error: "Monitor timed out after 30000ms",
        },
        session_id: "sdk-session-monitor",
        uuid: "task-updated-monitor-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const startedEvent = runtimeEvents.find((event) => event.type === "task.started");
      const completedEvent = runtimeEvents.find((event) => event.type === "task.completed");
      const updatedEvent = runtimeEvents.find((event) => event.type === "task.updated");

      assert.equal(startedEvent?.type, "task.started");
      if (startedEvent?.type === "task.started") {
        const payload = startedEvent.payload as Record<string, unknown>;
        assert.equal(payload.sourceItemType, "dynamic_tool_call");
        assert.equal(payload.sourceToolName, "Monitor");
        assert.equal(payload.sourceDetail, "Monitor: Watch the dev server");
        assert.equal(payload.sourceTimeoutMs, 30000);
        assert.equal(payload.sourcePersistent, false);
      }

      assert.equal(completedEvent?.type, "task.completed");
      if (completedEvent?.type === "task.completed") {
        const payload = completedEvent.payload as Record<string, unknown>;
        assert.equal(payload.sourceItemType, "dynamic_tool_call");
        assert.equal(payload.sourceToolName, "Monitor");
        assert.equal(payload.sourceDetail, "Monitor: Watch the dev server");
        assert.equal(payload.sourceTimeoutMs, 30000);
        assert.equal(payload.sourcePersistent, false);
        assert.equal(payload.status, "stopped");
      }

      assert.equal(updatedEvent?.type, "task.updated");
      if (updatedEvent?.type === "task.updated") {
        const payload = updatedEvent.payload as Record<string, unknown>;
        assert.equal(payload.sourceItemType, "dynamic_tool_call");
        assert.equal(payload.sourceToolName, "Monitor");
        assert.equal(payload.sourceDetail, "Monitor: Watch the dev server");
        assert.equal(payload.sourceTimeoutMs, 30000);
        assert.equal(payload.sourcePersistent, false);
        assert.deepEqual(payload.patch, {
          status: "killed",
          error: "Monitor timed out after 30000ms",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards outputFile from task_notification", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-output-1",
        tool_use_id: "tool-output-1",
        status: "completed",
        output_file: "/tmp/tasks/output.txt",
        summary: "Task finished",
        session_id: "sdk-session-output-file",
        uuid: "task-notification-output-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const completedEvent = runtimeEvents.find((event) => event.type === "task.completed");
      assert.equal(completedEvent?.type, "task.completed");
      if (completedEvent?.type === "task.completed") {
        const payload = completedEvent.payload as Record<string, unknown>;
        assert.equal(payload.outputFile, "/tmp/tasks/output.txt");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards error and isBackgrounded fields from task_updated", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-error-1",
        patch: {
          status: "failed",
          error: "Out of memory",
          is_backgrounded: true,
        },
        session_id: "sdk-session-error",
        uuid: "task-updated-error-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      runtimeEventsFiber.interruptUnsafe();

      const updatedEvent = runtimeEvents.find((event) => event.type === "task.updated");
      assert.equal(updatedEvent?.type, "task.updated");
      if (updatedEvent?.type === "task.updated") {
        const patch = updatedEvent.payload.patch as Record<string, unknown>;
        assert.equal(patch.status, "failed");
        assert.equal(patch.error, "Out of memory");
        assert.equal(patch.isBackgrounded, true);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits thread token usage updates from Claude task progress", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 321,
            lastUsedTokens: 321,
            toolUses: 2,
            durationMs: 654,
          },
        });
      }
      assert.equal(progressEvent?.type, "task.progress");
      if (usageEvent && progressEvent) {
        assert.notStrictEqual(usageEvent.eventId, progressEvent.eventId);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            outputTokens: 679,
            maxTokens: 200000,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bridges approval request/response lifecycle through canUseTool", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-approval-1",
        uuid: "stream-approval-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-approval-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
          ],
          toolUseID: "tool-use-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") {
        return;
      }
      assert.equal(requested.value.type, "request.opened");
      if (requested.value.type !== "request.opened") {
        return;
      }
      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToInteractiveRequest({
        threadId: session.threadId,
        requestId: InteractiveRequestId.makeUnsafe(runtimeRequestId),
        resolution: { decision: "accept" },
      });

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "accept");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some" || agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToInteractiveRequest({
        threadId: session.threadId,
        requestId: InteractiveRequestId.makeUnsafe(String(agentRequested.value.requestId)),
        resolution: { decision: "accept" },
      });
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some" || grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToInteractiveRequest({
        threadId: session.threadId,
        requestId: InteractiveRequestId.makeUnsafe(String(grepRequested.value.requestId)),
        resolution: { decision: "accept" },
      });
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});
