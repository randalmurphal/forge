import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  CommandId,
  InteractiveRequestId,
  MessageId,
  type ProviderRuntimeEvent,
} from "@forgetools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { asEventId, asItemId, asThreadId, asTurnId } from "../../__test__/ids.ts";
import {
  makeTestLifecycle,
  waitForThread,
  activityPayload,
  activityInlineDiff,
  type ProviderRuntimeTestActivity,
  type ProviderRuntimeTestCheckpoint,
  type ProviderRuntimeTestProposedPlan,
} from "./runtimeIngestion/testHarness.ts";

describe("ProviderRuntimeIngestion diffs and advanced events", () => {
  const { createHarness, cleanup } = makeTestLifecycle();

  afterEach(cleanup);

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemId).toBe("item-p1-tool");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
  });

  it("persists normalized inline diffs on file-change tool activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-file-change-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change"),
      itemId: asItemId("item-file-change"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        detail: "Editing apps/web/src/session-logic.ts",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-file-change-updated",
      ),
    );

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-file-change-updated",
    );
    const payload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;

    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(payload?.itemId).toBe("item-file-change");
    expect(inlineDiff?.availability).toBe("exact_patch");
    expect(inlineDiff?.unifiedDiff).toContain(
      "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
    );
    expect(thread.agentDiffs).toEqual([
      expect.objectContaining({
        turnId: "turn-file-change",
        source: "derived_tool_results",
        coverage: "partial",
        files: [
          expect.objectContaining({
            path: "apps/web/src/session-logic.ts",
          }),
        ],
      }),
    ]);
  });

  it("attaches an exact inline diff to successful rm command rows", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/remove.ts"),
      "export const removed = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-rm-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-rm"),
      itemId: asItemId("item-command-rm"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run command",
        data: {
          item: {
            command: "/usr/bin/zsh -lc 'rm src/remove.ts'",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-rm-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-rm"),
      itemId: asItemId("item-command-rm"),
      payload: {
        itemType: "command_execution",
        title: "Run command",
        data: {
          item: {
            command: "/usr/bin/zsh -lc 'rm src/remove.ts'",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-rm-completed",
      );
      return activityInlineDiff(activity)?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-rm-completed",
    );
    const payload = activityPayload(activity);
    const inlineDiff = activityInlineDiff(activity);

    expect(payload?.itemType).toBe("command_execution");
    expect(inlineDiff).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "src/remove.ts", kind: "deleted", deletions: 1 }],
      deletions: 1,
    });
    expect(String(inlineDiff?.unifiedDiff)).toContain("deleted file mode 100644");
  });

  it("attaches an exact inline diff to successful mv command rows", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/old.ts"),
      "export const oldName = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-mv-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-mv"),
      itemId: asItemId("item-command-mv"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run command",
        data: {
          item: {
            command: "mv src/old.ts src/new.ts",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-mv-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-mv"),
      itemId: asItemId("item-command-mv"),
      payload: {
        itemType: "command_execution",
        title: "Run command",
        data: {
          item: {
            command: "mv src/old.ts src/new.ts",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-mv-completed",
      );
      return activityInlineDiff(activity)?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-mv-completed",
    );
    const inlineDiff = activityInlineDiff(activity);

    expect(inlineDiff).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "src/new.ts", kind: "renamed" }],
    });
    expect(String(inlineDiff?.unifiedDiff)).toContain("rename from src/old.ts");
    expect(String(inlineDiff?.unifiedDiff)).toContain("rename to src/new.ts");
  });

  it("attaches a multi-file exact inline diff to supported command chains", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/old.ts"),
      "export const oldName = true;\n",
    );
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/remove.ts"),
      "export const removeMe = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-chain-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-chain"),
      itemId: asItemId("item-command-chain"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run command chain",
        data: {
          item: {
            command: "/usr/bin/zsh -lc 'mv src/old.ts src/new.ts && rm src/remove.ts'",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-chain-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-chain"),
      itemId: asItemId("item-command-chain"),
      payload: {
        itemType: "command_execution",
        title: "Run command chain",
        data: {
          item: {
            command: "/usr/bin/zsh -lc 'mv src/old.ts src/new.ts && rm src/remove.ts'",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-chain-completed",
      );
      return activityInlineDiff(activity)?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-chain-completed",
    );
    const inlineDiff = activityInlineDiff(activity);

    expect(inlineDiff?.files).toEqual([
      { path: "src/new.ts", kind: "renamed" },
      { path: "src/remove.ts", kind: "deleted", deletions: 1 },
    ]);
    expect(String(inlineDiff?.unifiedDiff)).toContain("rename from src/old.ts");
    expect(String(inlineDiff?.unifiedDiff)).toContain("deleted file mode 100644");
  });

  it("supports array-form commands with quoted paths", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/old name.ts"),
      "export const oldName = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-array-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-array"),
      itemId: asItemId("item-command-array"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run array command",
        data: {
          item: {
            command: ["mv", "src/old name.ts", "src/new name.ts"],
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-array-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-array"),
      itemId: asItemId("item-command-array"),
      payload: {
        itemType: "command_execution",
        title: "Run array command",
        data: {
          item: {
            command: ["mv", "src/old name.ts", "src/new name.ts"],
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-array-completed",
      );
      return activityInlineDiff(activity)?.availability === "exact_patch";
    });

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-array-completed",
        ),
      ),
    ).toMatchObject({
      availability: "exact_patch",
      files: [{ path: "src/new name.ts", kind: "renamed" }],
    });
  });

  it("keeps dependent command chains as plain command rows without inline diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/old.ts"),
      "export const oldName = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dependent-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dependent"),
      itemId: asItemId("item-command-dependent"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run dependent command chain",
        data: {
          item: {
            command: "mv src/old.ts src/new.ts && rm src/new.ts",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dependent-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dependent"),
      itemId: asItemId("item-command-dependent"),
      payload: {
        itemType: "command_execution",
        title: "Run dependent command chain",
        data: {
          item: {
            command: "mv src/old.ts src/new.ts && rm src/new.ts",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-command-dependent-completed",
      ),
    );

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-dependent-completed",
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps unsupported or failed commands as plain command rows without inline diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src/remove.ts"),
      "export const removeMe = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-unsupported-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-unsupported"),
      itemId: asItemId("item-command-unsupported"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run unsupported command",
        data: {
          item: {
            command: "rm src/remove.ts | cat",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-unsupported-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-unsupported"),
      itemId: asItemId("item-command-unsupported"),
      payload: {
        itemType: "command_execution",
        title: "Run unsupported command",
        data: {
          item: {
            command: "rm src/remove.ts | cat",
            exitCode: 0,
          },
        },
      },
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-failed-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-failed"),
      itemId: asItemId("item-command-failed"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run failed command",
        data: {
          item: {
            command: "rm src/remove.ts",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-failed-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-failed"),
      itemId: asItemId("item-command-failed"),
      payload: {
        itemType: "command_execution",
        title: "Run failed command",
        data: {
          item: {
            command: "rm src/remove.ts",
            exitCode: 1,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-command-unsupported-completed" ||
          activity.id === "evt-command-failed-completed",
      ),
    );

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-unsupported-completed",
        ),
      ),
    ).toBeUndefined();
    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-failed-completed",
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps directory and overwrite mutations as plain command rows without inline diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src", "existing-dir"), { recursive: true });
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src", "old.ts"),
      "export const oldName = true;\n",
    );
    fs.writeFileSync(
      path.join(harness.workspaceRoot, "src", "existing.ts"),
      "export const existing = true;\n",
    );

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dir-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run directory command",
        data: {
          item: {
            command: "rm src/existing-dir",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dir-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir"),
      payload: {
        itemType: "command_execution",
        title: "Run directory command",
        data: {
          item: {
            command: "rm src/existing-dir",
            exitCode: 0,
          },
        },
      },
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-overwrite-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-overwrite"),
      itemId: asItemId("item-command-overwrite"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run overwrite command",
        data: {
          item: {
            command: "mv src/old.ts src/existing.ts",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-overwrite-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-overwrite"),
      itemId: asItemId("item-command-overwrite"),
      payload: {
        itemType: "command_execution",
        title: "Run overwrite command",
        data: {
          item: {
            command: "mv src/old.ts src/existing.ts",
            exitCode: 0,
          },
        },
      },
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dir-target-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir-target"),
      itemId: asItemId("item-command-dir-target"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run directory target command",
        data: {
          item: {
            command: "mv src/old.ts src/existing-dir/",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dir-target-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir-target"),
      itemId: asItemId("item-command-dir-target"),
      payload: {
        itemType: "command_execution",
        title: "Run directory target command",
        data: {
          item: {
            command: "mv src/old.ts src/existing-dir/",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-command-dir-completed" ||
          activity.id === "evt-command-overwrite-completed" ||
          activity.id === "evt-command-dir-target-completed",
      ),
    );

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-command-dir-completed",
        ),
      ),
    ).toBeUndefined();
    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-overwrite-completed",
        ),
      ),
    ).toBeUndefined();
    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-dir-target-completed",
        ),
      ),
    ).toBeUndefined();
  });

  it("keeps directory delete and rename commands as plain command rows without inline diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(harness.workspaceRoot, "src/remove-dir"), { recursive: true });
    fs.mkdirSync(path.join(harness.workspaceRoot, "src/old-dir"), { recursive: true });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dir-rm-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir-rm"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run directory delete",
        data: {
          item: {
            command: "rm -f src/remove-dir",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dir-rm-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir-rm"),
      payload: {
        itemType: "command_execution",
        title: "Run directory delete",
        data: {
          item: {
            command: "rm -f src/remove-dir",
            exitCode: 0,
          },
        },
      },
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-command-dir-mv-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir-mv"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run directory rename",
        data: {
          item: {
            command: "mv src/old-dir src/new-dir",
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-dir-mv-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-dir"),
      itemId: asItemId("item-command-dir-mv"),
      payload: {
        itemType: "command_execution",
        title: "Run directory rename",
        data: {
          item: {
            command: "mv src/old-dir src/new-dir",
            exitCode: 0,
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.id === "evt-command-dir-rm-completed" ||
          activity.id === "evt-command-dir-mv-completed",
      ),
    );

    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-dir-rm-completed",
        ),
      ),
    ).toBeUndefined();
    expect(
      activityInlineDiff(
        thread.activities.find(
          (candidate: ProviderRuntimeTestActivity) =>
            candidate.id === "evt-command-dir-mv-completed",
        ),
      ),
    ).toBeUndefined();
  });

  it("accumulates touched repo files across file-change events in the same turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-file-change-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-merge"),
      itemId: asItemId("item-file-change-a"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "Edit first file",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-file-change-b"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-merge"),
      itemId: asItemId("item-file-change-b"),
      payload: {
        itemType: "file_change",
        title: "Edit second file",
        data: {
          item: {
            changes: [
              {
                path: "apps/server/src/orchestration/projector.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-file-change-merge")?.files.length ===
        2,
    );

    const agentDiff = thread.agentDiffs?.find((entry) => entry.turnId === "turn-file-change-merge");
    expect(agentDiff?.source).toBe("derived_tool_results");
    expect(agentDiff?.coverage).toBe("partial");
    expect(agentDiff?.files.map((file) => file.path).toSorted()).toEqual([
      "apps/server/src/orchestration/projector.ts",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("uses the pre-turn baseline even when codex already reserved the current turn count", async () => {
    const harness = await createHarness();
    const baselineRef = checkpointRefForThreadTurn(asThreadId("thread-1"), 0);
    const seededAt = new Date().toISOString();

    execFileSync("git", ["init"], { cwd: harness.workspaceRoot });
    fs.writeFileSync(path.join(harness.workspaceRoot, "tracked.ts"), "export const value = 1;\n");
    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.workspaceRoot,
        checkpointRef: baselineRef,
      }),
    );
    fs.writeFileSync(path.join(harness.workspaceRoot, "tracked.ts"), "export const value = 2;\n");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-placeholder-turn-count"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-placeholder-baseline"),
        completedAt: seededAt,
        checkpointRef: checkpointRefForThreadTurn(asThreadId("thread-1"), 1),
        status: "missing",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant:turn-placeholder-baseline"),
        checkpointTurnCount: 1,
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-placeholder-baseline"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-placeholder-baseline"),
      itemId: asItemId("item-placeholder-baseline"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "Edit tracked file",
        data: {
          item: {
            changes: [
              {
                path: "tracked.ts",
                kind: "modified",
                diff: ["@@ -1 +1 @@", "-export const value = 1;", "+export const value = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-placeholder-baseline")?.coverage ===
        "complete",
    );

    const agentDiff = thread.agentDiffs?.find(
      (entry) => entry.turnId === "turn-placeholder-baseline",
    );
    expect(agentDiff?.files.map((file) => file.path)).toEqual(["tracked.ts"]);
  });

  it("keeps out-of-repo paths inline but excludes them from persisted turn agent diffs", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-file-change-outside"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-file-change-outside"),
      itemId: asItemId("item-file-change-outside"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "Mixed file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
              {
                path: "C:\\Users\\rmurphy\\Desktop\\notes.txt",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " hello", "+outside"].join("\n"),
              },
            ],
          },
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-file-change-outside",
        ) &&
        (entry.agentDiffs?.some((diff) => diff.turnId === "turn-file-change-outside") ?? false),
    );

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-file-change-outside",
    );
    const payload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;
    const inlineFiles = Array.isArray(inlineDiff?.files)
      ? (inlineDiff!.files as Array<{ path?: unknown }>)
      : [];

    expect(inlineFiles.map((file) => file.path)).toContain(
      "C:\\Users\\rmurphy\\Desktop\\notes.txt",
    );

    const agentDiff = thread.agentDiffs?.find(
      (entry) => entry.turnId === "turn-file-change-outside",
    );
    expect(agentDiff?.files.map((file) => file.path)).toEqual(["apps/web/src/session-logic.ts"]);
  });

  it("filters codex native turn diffs down to the existing tool-scoped files", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-file-change-before-native"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-native-overwrite"),
      itemId: asItemId("item-file-change-before-native"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: "modified",
                diff: ["@@ -1 +1,2 @@", " export const value = 1;", "+export const next = 2;"].join(
                  "\n",
                ),
              },
            ],
          },
        },
      },
    });

    await waitForThread(
      harness.engine,
      (entry) => entry.agentDiffs?.some((diff) => diff.turnId === "turn-native-overwrite") ?? false,
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-native-overwrite-attempt"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-native-overwrite"),
      itemId: asItemId("item-native-overwrite"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
          "",
          "diff --git a/apps/server/src/extra.ts b/apps/server/src/extra.ts",
          "--- a/apps/server/src/extra.ts",
          "+++ b/apps/server/src/extra.ts",
          "@@ -0,0 +1 @@",
          "+widened",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-native-overwrite")?.coverage ===
        "complete",
    );

    const agentDiff = thread.agentDiffs?.find((entry) => entry.turnId === "turn-native-overwrite");
    expect(agentDiff?.source).toBe("derived_tool_results");
    expect(agentDiff?.coverage).toBe("complete");
    expect(agentDiff?.files.map((file) => file.path)).toEqual(["apps/web/src/session-logic.ts"]);
    expect(agentDiff?.files).toHaveLength(1);
    expect(
      agentDiff?.files.find((file) => file.path === "apps/server/src/extra.ts"),
    ).toBeUndefined();
  });

  it("upgrades a summary-only codex tool activity when a later exact turn diff is unambiguous", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-summary-only-before-native"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-summary-upgrade"),
      itemId: asItemId("item-summary-only-before-native"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-summary-only-before-native",
      ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-summary-only-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-summary-upgrade"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-summary-only-before-native",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      return inlineDiff?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-summary-only-before-native",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;

    expect(inlineDiff?.availability).toBe("exact_patch");
    expect(inlineDiff?.unifiedDiff).toContain(
      "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
    );
  });

  it("does not overwrite an existing exact codex tool diff from a later turn diff update", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-existing-exact-before-native"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-existing-exact-before-native"),
      itemId: asItemId("item-existing-exact-before-native"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
                diff: [
                  "@@ -1 +1,2 @@",
                  " export const value = 1;",
                  "+export const exactToolPatch = 2;",
                ].join("\n"),
              },
            ],
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-existing-exact-before-native",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      return inlineDiff?.availability === "exact_patch";
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-existing-exact-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-existing-exact-before-native"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const nativeTurnPatch = 3;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-existing-exact-before-native",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      return typeof inlineDiff?.unifiedDiff === "string";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) =>
        candidate.id === "evt-existing-exact-before-native",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;

    expect(inlineDiff?.availability).toBe("exact_patch");
    expect(String(inlineDiff?.unifiedDiff)).toContain("exactToolPatch");
    expect(String(inlineDiff?.unifiedDiff)).not.toContain("nativeTurnPatch");
  });

  it("upgrades a summary-only codex tool activity when file metadata uses absolute paths", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const absoluteToolDiffArtifactsPath = path.join(
      harness.workspaceRoot,
      "apps/server/src/orchestration/toolDiffArtifacts.ts",
    );

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-summary-only-absolute-path"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-summary-absolute-path-upgrade"),
      itemId: asItemId("item-summary-only-absolute-path"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [
              {
                path: absoluteToolDiffArtifactsPath,
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-summary-only-absolute-path",
      ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-summary-only-absolute-path-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-summary-absolute-path-upgrade"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/server/src/orchestration/toolDiffArtifacts.ts b/apps/server/src/orchestration/toolDiffArtifacts.ts",
          "--- a/apps/server/src/orchestration/toolDiffArtifacts.ts",
          "+++ b/apps/server/src/orchestration/toolDiffArtifacts.ts",
          "@@ -1 +1,2 @@",
          ' import { ProviderKind } from "@forgetools/contracts";',
          "+const updated = true;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(harness.engine, (entry) => {
      const activity = entry.activities.find(
        (candidate: ProviderRuntimeTestActivity) =>
          candidate.id === "evt-summary-only-absolute-path",
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      return inlineDiff?.availability === "exact_patch";
    });

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.id === "evt-summary-only-absolute-path",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const inlineDiff =
      payload?.inlineDiff && typeof payload.inlineDiff === "object"
        ? (payload.inlineDiff as Record<string, unknown>)
        : undefined;

    expect(inlineDiff?.availability).toBe("exact_patch");
    expect(inlineDiff?.unifiedDiff).toContain(
      "diff --git a/apps/server/src/orchestration/toolDiffArtifacts.ts",
    );
    expect(inlineDiff?.files).toEqual([
      {
        path: "apps/server/src/orchestration/toolDiffArtifacts.ts",
        kind: "modified",
        additions: 1,
        deletions: 0,
      },
    ]);
  });

  it("keeps same-path codex file-change activities summary-only when item ids are missing", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-no-item-id-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-item-id-overlap"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "First file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-no-item-id-b"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-item-id-overlap"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "Second file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-no-item-id-b",
      ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-no-item-id-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-item-id-overlap"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.filter(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-no-item-id-a" || activity.id === "evt-no-item-id-b",
        ).length === 2,
    );

    for (const activityId of ["evt-no-item-id-a", "evt-no-item-id-b"]) {
      const activity = thread.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === activityId,
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;

      expect(inlineDiff?.availability).toBe("summary_only");
      expect(inlineDiff?.unifiedDiff).toBeUndefined();
    }
  });

  it("keeps overlapping codex file-change tool activities summary-only when exact ownership is ambiguous", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-overlap-a"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-overlap-summary-only"),
      itemId: asItemId("item-overlap-a"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "First file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-overlap-b"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-overlap-summary-only"),
      itemId: asItemId("item-overlap-b"),
      payload: {
        itemType: "file_change",
        title: "Second file change",
        data: {
          item: {
            changes: [
              {
                path: "apps/web/src/session-logic.ts",
                kind: { type: "update", move_path: null },
              },
            ],
          },
        },
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-overlap-a",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-overlap-b",
        ),
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-overlap-native-diff"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-overlap-summary-only"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-overlap-summary-only")?.coverage ===
        "complete",
    );

    for (const activityId of ["evt-overlap-a", "evt-overlap-b"]) {
      const activity = thread.activities.find(
        (candidate: ProviderRuntimeTestActivity) => candidate.id === activityId,
      );
      const payload =
        activity?.payload && typeof activity.payload === "object"
          ? (activity.payload as Record<string, unknown>)
          : undefined;
      const inlineDiff =
        payload?.inlineDiff && typeof payload.inlineDiff === "object"
          ? (payload.inlineDiff as Record<string, unknown>)
          : undefined;
      expect(inlineDiff?.availability).toBe("summary_only");
      expect(inlineDiff?.unifiedDiff).toBeUndefined();
    }
  });

  it("accepts later claude tool-derived turn diffs as refinements of the same turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-claude-file-change"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-refine"),
      itemId: asItemId("item-claude-file-change"),
      payload: {
        itemType: "file_change",
        status: "in_progress",
        title: "File change",
        data: {
          item: {
            changes: [{ path: "apps/web/src/session-logic.ts", kind: "modified" }],
          },
        },
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-claude-refine")?.coverage ===
        "partial",
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-claude-turn-diff"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-refine"),
      payload: {
        unifiedDiff: [
          "diff --git a/apps/web/src/session-logic.ts b/apps/web/src/session-logic.ts",
          "--- a/apps/web/src/session-logic.ts",
          "+++ b/apps/web/src/session-logic.ts",
          "@@ -1 +1,2 @@",
          " export const value = 1;",
          "+export const next = 2;",
        ].join("\n"),
        source: "derived_tool_results",
        coverage: "complete",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.agentDiffs?.find((diff) => diff.turnId === "turn-claude-refine")?.coverage ===
        "complete",
    );

    const agentDiff = thread.agentDiffs?.find((entry) => entry.turnId === "turn-claude-refine");
    expect(agentDiff?.source).toBe("derived_tool_results");
    expect(agentDiff?.files.map((file) => file.path)).toEqual(["apps/web/src/session-logic.ts"]);
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
        toolUseId: "tool-plan-1",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        toolUseId: "tool-plan-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        toolUseId: "tool-plan-1",
        status: "completed",
        outputFile: "/tmp/turn-task-1.out",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect((started?.payload as Record<string, unknown> | undefined)?.toolUseId).toBe(
      "tool-plan-1",
    );
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.toolUseId).toBe("tool-plan-1");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.toolUseId).toBe("tool-plan-1");
    expect(completedPayload?.outputFile).toBe("/tmp/turn-task-1.out");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("projects Monitor-owned task lifecycle chunks as separate dynamic tool activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-monitor-task-started"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-monitor-1"),
      payload: {
        taskId: "task-monitor-1",
        taskType: "local_bash",
        toolUseId: "tool-monitor-1",
        sourceItemType: "dynamic_tool_call",
        sourceToolName: "Monitor",
        sourceDetail: "Monitor: Watch the dev server",
        sourceTimeoutMs: 30000,
        sourcePersistent: false,
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-monitor-task-completed"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-monitor-1"),
      payload: {
        taskId: "task-monitor-1",
        toolUseId: "tool-monitor-1",
        status: "stopped",
        summary: "Monitor stopped after timeout",
        sourceItemType: "dynamic_tool_call",
        sourceToolName: "Monitor",
        sourceDetail: "Monitor: Watch the dev server",
        sourceTimeoutMs: 30000,
        sourcePersistent: false,
      },
    });

    harness.emit({
      type: "task.updated",
      eventId: asEventId("evt-monitor-task-updated"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-monitor-1"),
      payload: {
        taskId: "task-monitor-1",
        patch: {
          status: "killed",
          error: "Monitor timed out after 30000ms",
        },
        sourceItemType: "dynamic_tool_call",
        sourceToolName: "Monitor",
        sourceDetail: "Monitor: Watch the dev server",
        sourceTimeoutMs: 30000,
        sourcePersistent: false,
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-monitor-task-updated",
      ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-monitor-task-started",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-monitor-task-completed",
    );
    const updated = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-monitor-task-updated",
    );

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Monitor started");
    expect(activityPayload(started)).toMatchObject({
      taskId: "task-monitor-1",
      toolUseId: "tool-monitor-1",
      itemType: "dynamic_tool_call",
      toolName: "Monitor",
      sourceDetail: "Monitor: Watch the dev server",
      sourceTimeoutMs: 30000,
      sourcePersistent: false,
    });

    expect(completed?.kind).toBe("task.completed");
    expect(completed?.summary).toBe("Monitor stopped");
    expect(activityPayload(completed)).toMatchObject({
      taskId: "task-monitor-1",
      toolUseId: "tool-monitor-1",
      status: "stopped",
      itemType: "dynamic_tool_call",
      toolName: "Monitor",
      detail: "Monitor stopped after timeout",
      sourceDetail: "Monitor: Watch the dev server",
      sourceTimeoutMs: 30000,
      sourcePersistent: false,
    });

    expect(updated?.kind).toBe("task.updated");
    expect(updated?.summary).toBe("Monitor killed");
    expect(activityPayload(updated)).toMatchObject({
      taskId: "task-monitor-1",
      itemType: "dynamic_tool_call",
      toolName: "Monitor",
      sourceDetail: "Monitor: Watch the dev server",
      sourceTimeoutMs: 30000,
      sourcePersistent: false,
      patch: {
        status: "killed",
        error: "Monitor timed out after 30000ms",
      },
    });
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: InteractiveRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: InteractiveRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("synthesizes Codex subagent lifecycle activities server-side from collab tool state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-collab-spawn-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-collab"),
      itemId: asItemId("item-collab-spawn"),
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        title: "Subagent task",
        toolName: "spawnAgent",
        data: {
          item: {
            id: "task-collab-1",
            tool: "spawnAgent",
            prompt: "Investigate the provider mapping",
            model: "gpt-5.4-mini",
            receiverThreadIds: ["child-provider-1"],
            agentsStates: {
              "child-provider-1": {
                status: "completed",
              },
            },
          },
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) =>
          activity.kind === "task.started" || activity.kind === "task.completed",
      ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.started" &&
        activity.id === "evt-collab-spawn-completed:synthetic-subagent-start:child-provider-1",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) =>
        activity.kind === "task.completed" &&
        activity.id === "evt-collab-spawn-completed:synthetic-subagent-complete:child-provider-1",
    );

    expect(activityPayload(started)?.childThreadAttribution).toEqual({
      taskId: "task-collab-1",
      childProviderThreadId: "child-provider-1",
      label: "Investigate the provider mapping",
      agentModel: "gpt-5.4-mini",
    });
    expect(activityPayload(completed)).toMatchObject({
      taskId: "task-collab-1",
      status: "completed",
      childThreadAttribution: {
        taskId: "task-collab-1",
        childProviderThreadId: "child-provider-1",
        label: "Investigate the provider mapping",
        agentModel: "gpt-5.4-mini",
      },
    });
  });

  it("projects command output deltas into tool.output.delta thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-command-output-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output"),
      itemId: asItemId("item-command-output"),
      payload: {
        streamKind: "command_output",
        delta: "[watch] build started\n",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.output.delta",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-output-delta",
    );
    expect(activity?.kind).toBe("tool.output.delta");
    expect(activityPayload(activity)).toMatchObject({
      itemId: "item-command-output",
      streamKind: "command_output",
      delta: "[watch] build started\n",
    });
  });

  it("keeps child-thread attribution on projected command output deltas", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-command-output-child"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-output-child"),
      itemId: asItemId("item-command-output-child"),
      payload: {
        streamKind: "command_output",
        delta: "build complete\n",
        childThreadAttribution: {
          taskId: "task-child-1",
          childProviderThreadId: "provider-thread-1",
          label: "Background build",
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-output-child",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-output-child",
    );
    expect(activityPayload(activity)?.childThreadAttribution).toEqual({
      taskId: "task-child-1",
      childProviderThreadId: "provider-thread-1",
      label: "Background build",
    });
  });

  it("projects terminal interaction events into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "terminal.interaction",
      eventId: asEventId("evt-terminal-interaction"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-terminal"),
      itemId: asItemId("item-terminal"),
      payload: {
        processId: "proc-watch-1",
        stdin: "",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.terminal.interaction",
      ),
    );

    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-terminal-interaction",
    );
    expect(activity?.kind).toBe("tool.terminal.interaction");
    expect(activityPayload(activity)).toMatchObject({
      itemId: "item-terminal",
      processId: "proc-watch-1",
      stdin: "",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
