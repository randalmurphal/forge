import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ForgeEvent, ThreadId } from "@forgetools/contracts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId as ThreadIdSchema,
} from "@forgetools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { invokeSharedChatBridge } from "../../discussion/sharedChatBridge.ts";
import { DiscussionRegistry } from "../../discussion/Services/DiscussionRegistry.ts";
import { getPendingMcpServer } from "../../provider/pendingMcpServers.ts";
import { DiscussionReactor } from "../Services/DiscussionReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { DiscussionReactorLive } from "./DiscussionReactor.ts";

function asThreadId(value: string): ThreadId {
  return ThreadIdSchema.makeUnsafe(value);
}

function extractSharedChatBridgeToken(threadId: ThreadId): string {
  const pendingMcpServer = getPendingMcpServer(threadId);
  const serverName = `forge-shared-chat-${threadId}`;
  const config = pendingMcpServer?.config[serverName] as
    | {
        env?: Record<string, unknown>;
      }
    | undefined;
  const token = config?.env?.FORGE_SHARED_CHAT_BRIDGE_TOKEN;
  if (typeof token !== "string") {
    throw new Error(`Expected shared chat bridge token for ${threadId}.`);
  }
  return token;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for expectation.");
}

describe("DiscussionReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<any, any> | null = null;
  let scope: Scope.Closeable | null = null;
  let baseDir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    if (baseDir) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    baseDir = null;
  });

  async function createHarness() {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-discussion-reactor-"));
    const domainEvents = Effect.runSync(PubSub.unbounded<ForgeEvent>());
    const parentThreadId = asThreadId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const readModel: any = {
      projects: [
        {
          id: ProjectId.makeUnsafe("project-1"),
          workspaceRoot: "/tmp/project-1",
        },
      ],
      threads: [
        {
          id: parentThreadId,
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Parent thread",
          discussionId: "debate",
          childThreadIds: [],
          parentThreadId: null,
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          messages: [],
        },
      ],
    };
    const dispatch = vi.fn((command: unknown) =>
      Effect.sync(() => {
        if (
          typeof command === "object" &&
          command !== null &&
          "type" in command &&
          command.type === "thread.create"
        ) {
          const threadCreate = command as unknown as {
            readonly threadId: ThreadId;
            readonly parentThreadId: ThreadId | null;
            readonly projectId: ProjectId;
            readonly title: string;
            readonly discussionId?: string | null;
            readonly runtimeMode: "approval-required" | "full-access";
            readonly interactionMode: typeof DEFAULT_PROVIDER_INTERACTION_MODE;
            readonly branch: string | null;
            readonly worktreePath: string | null;
            readonly modelSelection: { provider: "codex" | "claudeAgent"; model: string };
          };
          readModel.threads.push({
            id: threadCreate.threadId,
            projectId: threadCreate.projectId,
            title: threadCreate.title,
            discussionId: threadCreate.discussionId ?? null,
            childThreadIds: [],
            parentThreadId: threadCreate.parentThreadId,
            runtimeMode: threadCreate.runtimeMode,
            interactionMode: threadCreate.interactionMode,
            branch: threadCreate.branch,
            worktreePath: threadCreate.worktreePath,
            messages: [],
            modelSelection: threadCreate.modelSelection,
          });
          if (threadCreate.parentThreadId !== null) {
            const parentThread = readModel.threads.find(
              (thread: any) => thread.id === threadCreate.parentThreadId,
            );
            parentThread?.childThreadIds.push(threadCreate.threadId);
          }
        }
        return { sequence: 1 };
      }),
    );

    const layer = DiscussionReactorLive.pipe(
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed(readModel as never),
          readEvents: () => Stream.empty,
          streamEventsFromSequence: () => Stream.empty,
          dispatch,
          streamDomainEvents: Stream.fromPubSub(domainEvents) as never,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(DiscussionRegistry, {
          queryAll: () => Effect.succeed([]),
          queryByName: () => Effect.succeed(Option.none()),
          queryManagedAll: () => Effect.succeed([]),
          queryManagedByName: () => Effect.succeed(Option.none()),
          create: () => Effect.die(new Error("create not used in test")),
          update: () => Effect.die(new Error("update not used in test")),
          delete: () => Effect.die(new Error("delete not used in test")),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const reactor = await runtime.runPromise(Effect.service(DiscussionReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    return {
      reactor,
      dispatch,
      parentThreadId,
      publishEvent: (event: ForgeEvent) => Effect.runPromise(PubSub.publish(domainEvents, event)),
    };
  }

  it("reuses the shared chat bridge token when the same child thread is registered twice", async () => {
    const { dispatch, parentThreadId, publishEvent } = await createHarness();
    const summaryThreadId = asThreadId("11111111-1111-1111-1111-111111111111");
    let uuidCallCount = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      (): `${string}-${string}-${string}-${string}-${string}` => {
        uuidCallCount += 1;
        if (uuidCallCount === 1 || uuidCallCount === 5) {
          return summaryThreadId as unknown as `${string}-${string}-${string}-${string}-${string}`;
        }
        return `00000000-0000-0000-0000-${String(uuidCallCount).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
      },
    );

    const summaryRequestedEvent = {
      type: "thread.summary-requested",
      payload: {
        threadId: parentThreadId,
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
      },
    } as ForgeEvent;

    await publishEvent(summaryRequestedEvent);
    await waitFor(() => dispatch.mock.calls.length >= 2);
    const firstToken = extractSharedChatBridgeToken(summaryThreadId);

    await publishEvent(summaryRequestedEvent);
    await waitFor(() => dispatch.mock.calls.length >= 4);
    const secondToken = extractSharedChatBridgeToken(summaryThreadId);

    expect(secondToken).toBe(firstToken);

    const result = await invokeSharedChatBridge({
      token: firstToken,
      message: "Summarized",
    });

    assert.deepStrictEqual(result, {
      content: "Message posted to the shared parent chat.",
      success: true,
    });
  });

  it("removes shared chat bridge registrations when the child thread completes", async () => {
    const { dispatch, parentThreadId, publishEvent } = await createHarness();
    const summaryThreadId = asThreadId("22222222-2222-2222-2222-222222222222");
    let uuidCallCount = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      (): `${string}-${string}-${string}-${string}-${string}` => {
        uuidCallCount += 1;
        if (uuidCallCount === 1) {
          return summaryThreadId as unknown as `${string}-${string}-${string}-${string}-${string}`;
        }
        return `00000000-0000-0000-0000-${String(uuidCallCount).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
      },
    );

    await publishEvent({
      type: "thread.summary-requested",
      payload: {
        threadId: parentThreadId,
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
      },
    } as ForgeEvent);
    await waitFor(() => dispatch.mock.calls.length >= 2);
    const token = extractSharedChatBridgeToken(summaryThreadId);

    await publishEvent({
      type: "thread.completed",
      payload: {
        threadId: summaryThreadId,
        completedAt: new Date().toISOString(),
      },
    } as ForgeEvent);

    await waitFor(async () => {
      const result = await invokeSharedChatBridge({
        token,
        message: "after-cleanup",
      });
      return result.success === false;
    });

    const result = await invokeSharedChatBridge({
      token,
      message: "after-cleanup",
    });
    assert.deepStrictEqual(result, {
      content: "Shared chat bridge token was not found.",
      success: false,
    });
  });

  it("removes shared chat bridge registrations when the parent thread completes", async () => {
    const { dispatch, parentThreadId, publishEvent } = await createHarness();
    const summaryThreadId = asThreadId("33333333-3333-3333-3333-333333333333");
    let uuidCallCount = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      (): `${string}-${string}-${string}-${string}-${string}` => {
        uuidCallCount += 1;
        if (uuidCallCount === 1) {
          return summaryThreadId as unknown as `${string}-${string}-${string}-${string}-${string}`;
        }
        return `00000000-0000-0000-0000-${String(uuidCallCount).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
      },
    );

    await publishEvent({
      type: "thread.summary-requested",
      payload: {
        threadId: parentThreadId,
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
      },
    } as ForgeEvent);
    await waitFor(() => dispatch.mock.calls.length >= 2);
    const token = extractSharedChatBridgeToken(summaryThreadId);

    await publishEvent({
      type: "thread.completed",
      payload: {
        threadId: parentThreadId,
        completedAt: new Date().toISOString(),
      },
    } as ForgeEvent);

    await waitFor(async () => {
      const result = await invokeSharedChatBridge({
        token,
        message: "after-parent-cleanup",
      });
      return result.success === false;
    });

    const result = await invokeSharedChatBridge({
      token,
      message: "after-parent-cleanup",
    });
    assert.deepStrictEqual(result, {
      content: "Shared chat bridge token was not found.",
      success: false,
    });
  });
});
