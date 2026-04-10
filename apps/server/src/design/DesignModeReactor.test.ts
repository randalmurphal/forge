import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ForgeEvent, ThreadId } from "@forgetools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { DesignModeReactor } from "../orchestration/Services/DesignModeReactor.ts";
import { ProjectionInteractiveRequestRepository } from "../persistence/Services/ProjectionInteractiveRequests.ts";
import { getPendingMcpServer } from "../provider/pendingMcpServers.ts";
import { DesignModeReactorLive } from "./DesignModeReactor.ts";
import { hasDesignBridge, invokeDesignBridge } from "./designBridge.ts";

function asThreadId(value: string): ThreadId {
  return value as ThreadId;
}

function extractDesignBridgeToken(threadId: ThreadId): string {
  const pendingMcpServer = getPendingMcpServer(threadId);
  const serverName = `forge-design-${threadId}`;
  const config = pendingMcpServer?.config[serverName] as
    | {
        env?: Record<string, unknown>;
      }
    | undefined;
  const token = config?.env?.FORGE_DESIGN_BRIDGE_TOKEN;
  if (typeof token !== "string") {
    throw new Error(`Expected bridge token for ${threadId}.`);
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

describe("DesignModeReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<any, any> | null = null;
  let scope: Scope.Closeable | null = null;
  let artifactsDir: string | null = null;
  let baseDir: string | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    if (artifactsDir) {
      fs.rmSync(artifactsDir, { recursive: true, force: true });
    }
    artifactsDir = null;
    if (baseDir) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    baseDir = null;
  });

  async function createHarness() {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-design-reactor-"));
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-design-artifacts-"));
    const domainEvents = Effect.runSync(PubSub.unbounded<ForgeEvent>());
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));

    const layer = DesignModeReactorLive.pipe(
      Layer.provideMerge(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed({ threads: [], projects: [] } as never),
          readEvents: () => Stream.empty,
          streamEventsFromSequence: () => Stream.empty,
          dispatch,
          streamDomainEvents: Stream.fromPubSub(domainEvents) as never,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectionInteractiveRequestRepository, {
          upsert: () => Effect.void,
          queryByThreadId: () => Effect.succeed([]),
          queryById: () => Effect.succeed(Option.none()),
          queryPending: () => Effect.succeed([]),
          updateStatus: () => Effect.void,
          markStale: () => Effect.void,
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const reactor = await runtime.runPromise(Effect.service(DesignModeReactor));
    await new Promise((resolve) => setTimeout(resolve, 0));

    return {
      reactor,
      dispatch,
      publishEvent: (event: ForgeEvent) => Effect.runPromise(PubSub.publish(domainEvents, event)),
    };
  }

  it("keeps the original bridge token valid across repeated setup for the same thread", async () => {
    const { reactor, dispatch } = await createHarness();
    const threadId = asThreadId(`thread-design-${crypto.randomUUID()}`);

    reactor.setupDesignMode({
      threadId,
      provider: "codex",
      artifactsBaseDir: artifactsDir!,
    });
    const firstToken = extractDesignBridgeToken(threadId);

    reactor.setupDesignMode({
      threadId,
      provider: "codex",
      artifactsBaseDir: artifactsDir!,
    });
    const secondToken = extractDesignBridgeToken(threadId);

    expect(secondToken).toBe(firstToken);

    const result = await invokeDesignBridge({
      token: firstToken,
      action: {
        action: "render_design",
        html: "<!DOCTYPE html><html><head><title>Preview</title></head><body>ok</body></html>",
        title: "Preview",
      },
    });

    const parsedResult = JSON.parse(result) as {
      artifactId?: unknown;
      status?: unknown;
    };
    assert.equal(typeof parsedResult.artifactId, "string");
    assert.equal(parsedResult.status, "rendered");
    expect(dispatch).toHaveBeenCalled();
  });

  it("tears down bridge registrations when the thread completes", async () => {
    const { reactor, publishEvent } = await createHarness();
    const threadId = asThreadId(`thread-design-complete-${crypto.randomUUID()}`);

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    reactor.setupDesignMode({
      threadId,
      provider: "codex",
      artifactsBaseDir: artifactsDir!,
    });
    const token = extractDesignBridgeToken(threadId);

    expect(hasDesignBridge(token)).toBe(true);

    await publishEvent({
      type: "thread.completed",
      payload: {
        threadId,
        completedAt: new Date().toISOString(),
      },
    } as ForgeEvent);
    await waitFor(() => !hasDesignBridge(token));
  });
});
