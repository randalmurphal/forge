/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Thin wiring layer that yields services, builds the shared adapter context,
 * and delegates all logic to `claude/streamHandlers.ts` and
 * `claude/sessionLifecycle.ts`.
 *
 * @module ClaudeAdapterLive
 */
import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { EventId, type ProviderRuntimeEvent, ThreadId } from "@forgetools/contracts";
import { DateTime, Effect, FileSystem, Layer, Queue, Random, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { type PendingMcpServerConfig, registerPendingMcpServer } from "../pendingMcpServers.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { makeClaudeOAuthTokenResolver } from "../claudeOAuthCredential.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

// --- Extracted claude/ modules ---
import {
  PROVIDER,
  type ClaudeAdapterContext,
  type ClaudeAdapterLiveOptions,
  type ClaudeQueryRuntime,
  type ClaudeSessionContext,
  type StartSessionServices,
} from "./claude/types.ts";
import {
  startSession,
  sendTurn,
  interruptTurn,
  readThread,
  rollbackThread,
  respondToRequest,
  respondToUserInput,
  forkThread,
  stopSession,
  listSessions,
  hasSession,
  stopAll,
  stopSessionInternal,
} from "./claude/sessionLifecycle.ts";

// Re-export for external consumers
export type { ClaudeAdapterLiveOptions } from "./claude/types.ts";

const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  options?: ClaudeAdapterLiveOptions,
) {
  // --- Yield services ---
  const fileSystem = yield* FileSystem.FileSystem;
  const oauthResolver = yield* makeClaudeOAuthTokenResolver;
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;

  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

  const registerMcpServer = (threadId: string, mcpConfig: PendingMcpServerConfig) => {
    registerPendingMcpServer(threadId, mcpConfig);
  };

  // --- Build shared mutable state ---
  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  // --- Build adapter context ---
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const ctx: ClaudeAdapterContext = {
    nativeEventLogger,
    sessions,
    offerRuntimeEvent,
    makeEventStamp,
    nowIso,
  };

  // --- Build service bundle for session start/turn send ---
  const services: StartSessionServices = {
    fileSystem,
    oauthResolver,
    serverConfig,
    serverSettingsService,
    createQuery,
    registerMcpServer,
  };

  // --- Finalizer ---
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(ctx, context, {
          emitExitEvent: false,
        }),
      { discard: true },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  // --- Return adapter shape ---
  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession: startSession(ctx, services),
    sendTurn: sendTurn(ctx, { fileSystem, serverConfig }),
    interruptTurn: interruptTurn(ctx),
    readThread: readThread(ctx),
    rollbackThread: rollbackThread(ctx),
    forkThread: forkThread(ctx),
    respondToRequest: respondToRequest(ctx),
    respondToUserInput: respondToUserInput(ctx),
    stopSession: stopSession(ctx),
    listSessions: listSessions(ctx),
    hasSession: hasSession(ctx),
    stopAll: stopAll(ctx),
    registerMcpServer,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies ClaudeAdapterShape;
});

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
