import {
  ChatAttachment,
  CommandId,
  type DiscussionDefinition,
  type ForgeEvent,
  MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@forgetools/contracts";
import { makeDrainableWorker } from "@forgetools/shared/DrainableWorker";
import { resolveThreadSpawnWorkspace } from "@forgetools/shared/threadWorkspace";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { registerPendingMcpServer } from "../../provider/pendingMcpServers.ts";
import { registerPendingSystemPrompt } from "../../provider/pendingSystemPrompt.ts";
import {
  removeSharedChatBridge,
  registerSharedChatBridge,
  SHARED_CHAT_BRIDGE_ROUTE,
} from "../../discussion/sharedChatBridge.ts";
import {
  makeSharedChatCodexMcpServerConfig,
  makeSharedChatMcpServer,
} from "../../discussion/sharedChatMcpServer.ts";
import { DiscussionRegistry } from "../../discussion/Services/DiscussionRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { DiscussionReactor, type DiscussionReactorShape } from "../Services/DiscussionReactor.ts";

type DiscussionReactorEvent = Extract<
  ForgeEvent,
  { type: "thread.turn-start-requested" | "thread.summary-requested" | "thread.completed" }
>;

type SharedChatParticipant = {
  readonly threadId: ThreadId;
  readonly role: string;
  readonly modelLabel: string;
  readonly systemPrompt: string;
  readonly modelSelection: ModelSelection;
};

function nowIso(): string {
  return new Date().toISOString();
}

function resolveLocalServerBaseUrl(input: {
  readonly host: string | undefined;
  readonly port: number;
}): string {
  const host =
    input.host === undefined || input.host === "0.0.0.0"
      ? "127.0.0.1"
      : input.host === "::"
        ? "[::1]"
        : input.host.includes(":") && !input.host.startsWith("[")
          ? `[${input.host}]`
          : input.host;
  return `http://${host}:${input.port}`;
}

function discussionCommandId(tag: string): CommandId {
  return CommandId.makeUnsafe(`discussion:${tag}:${crypto.randomUUID()}`);
}

function formatRoleLabel(role: string): string {
  return role
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function buildSystemPrompt(input: {
  readonly role: string;
  readonly rawSystemText: string;
}): string {
  return [
    `You are the ${formatRoleLabel(input.role)} participant in a shared parent chat.`,
    input.rawSystemText.trim(),
    [
      "Messages sent to this thread are copies of messages from the shared parent chat.",
      "Other participants may respond independently while you continue your work.",
      "When you are ready to contribute to the shared parent chat, call `post_to_chat` with only the message you want shown there.",
    ].join("\n"),
  ].join("\n\n");
}

function buildRelayedChildPrompt(input: {
  readonly speakerLabel: string;
  readonly messageText: string;
}): string {
  return [
    "New message from the shared parent chat.",
    `Speaker: ${input.speakerLabel}`,
    `Message:\n${input.messageText}`,
    "Continue your role-specific work. When you are ready to reply in the shared parent chat, use `post_to_chat`.",
  ].join("\n\n");
}

export const makeDiscussionReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const discussionRegistry = yield* DiscussionRegistry;
  const serverConfig = yield* ServerConfig;
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);
  const serverBaseUrl = resolveLocalServerBaseUrl(serverConfig);
  const bridgeTokensByChildThread = new Map<ThreadId, string>();

  const resolveThread = Effect.fn("DiscussionReactor.resolveThread")(function* (
    threadId: ThreadId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const resolveDiscussion = Effect.fn("DiscussionReactor.resolveDiscussion")(function* (
    discussionId: string,
    workspaceRoot: string | undefined,
  ) {
    return yield* discussionRegistry.queryByName(
      workspaceRoot ? { name: discussionId, workspaceRoot } : { name: discussionId },
    );
  });

  const appendSystemMessage = Effect.fn("DiscussionReactor.appendSystemMessage")(function* (
    threadId: ThreadId,
    text: string,
  ) {
    yield* orchestrationEngine.dispatch({
      type: "thread.message.append",
      commandId: discussionCommandId(`system:${threadId}`),
      threadId,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "system",
        text,
      },
      createdAt: nowIso(),
    });
  });

  const sendMessageToChild = Effect.fn("DiscussionReactor.sendMessageToChild")(function* (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: discussionCommandId(`turn:${input.threadId}`),
      threadId: input.threadId,
      message: {
        messageId: MessageId.makeUnsafe(crypto.randomUUID()),
        role: "user",
        text: input.text,
        attachments: input.attachments ? [...input.attachments] : [],
      },
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: nowIso(),
    });
  });

  const deliverParentMessageToChildren = Effect.fn(
    "DiscussionReactor.deliverParentMessageToChildren",
  )(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly speakerLabel: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const parentThread = yield* resolveThread(input.parentThreadId);
    if (!parentThread) {
      return;
    }

    for (const childThreadId of parentThread.childThreadIds) {
      yield* sendMessageToChild({
        threadId: childThreadId,
        text: buildRelayedChildPrompt({
          speakerLabel: input.speakerLabel,
          messageText: input.messageText,
        }),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        runtimeMode: parentThread.runtimeMode,
        interactionMode: parentThread.interactionMode,
      });
    }
  });

  const relayChildMessageToPeers = Effect.fn("DiscussionReactor.relayChildMessageToPeers")(
    function* (input: {
      readonly parentThreadId: ThreadId;
      readonly senderThreadId: ThreadId;
      readonly speakerLabel: string;
      readonly messageText: string;
    }) {
      const parentThread = yield* resolveThread(input.parentThreadId);
      if (!parentThread) {
        return;
      }

      for (const childThreadId of parentThread.childThreadIds) {
        if (childThreadId === input.senderThreadId) {
          continue;
        }
        yield* sendMessageToChild({
          threadId: childThreadId,
          text: buildRelayedChildPrompt({
            speakerLabel: input.speakerLabel,
            messageText: input.messageText,
          }),
          runtimeMode: parentThread.runtimeMode,
          interactionMode: parentThread.interactionMode,
        });
      }
    },
  );

  const postChildMessageToParent = Effect.fn("DiscussionReactor.postChildMessageToParent")(
    function* (input: {
      readonly parentThreadId: ThreadId;
      readonly senderThreadId: ThreadId;
      readonly role: string;
      readonly modelLabel: string;
      readonly messageText: string;
    }) {
      const trimmedMessage = input.messageText.trim();
      if (trimmedMessage.length === 0) {
        return {
          content: "Shared chat messages must not be empty.",
          success: false,
        } as const;
      }

      const parentThread = yield* resolveThread(input.parentThreadId);
      if (!parentThread) {
        return {
          content: "Parent thread was not found.",
          success: false,
        } as const;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.message.append",
        commandId: discussionCommandId(`parent-message:${input.parentThreadId}`),
        threadId: parentThread.id,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "assistant",
          text: trimmedMessage,
          attribution: {
            sourceThreadId: input.senderThreadId,
            role: input.role,
            model: input.modelLabel,
          },
        },
        createdAt: nowIso(),
      });

      if (input.role !== "summary") {
        yield* relayChildMessageToPeers({
          parentThreadId: parentThread.id,
          senderThreadId: input.senderThreadId,
          speakerLabel: formatRoleLabel(input.role),
          messageText: trimmedMessage,
        });
      }

      if (input.role === "summary") {
        yield* orchestrationEngine.dispatch({
          type: "thread.archive",
          commandId: discussionCommandId(`archive-summary:${input.senderThreadId}`),
          threadId: input.senderThreadId,
        });
      }

      return {
        content: "Message posted to the shared parent chat.",
        success: true,
      } as const;
    },
  );

  const registerSharedChatTool = (input: {
    readonly childThreadId: ThreadId;
    readonly provider: "codex" | "claudeAgent";
    readonly parentThreadId: ThreadId;
    readonly role: string;
    readonly modelLabel: string;
  }) => {
    const postMessage = async ({ message }: { readonly message: string }) =>
      await runPromise(
        postChildMessageToParent({
          parentThreadId: input.parentThreadId,
          senderThreadId: input.childThreadId,
          role: input.role,
          modelLabel: input.modelLabel,
          messageText: message,
        }),
      );

    const mcpServerName = `forge-shared-chat-${input.childThreadId}`;
    let bridgeToken = bridgeTokensByChildThread.get(input.childThreadId);
    if (bridgeToken === undefined) {
      bridgeToken = registerSharedChatBridge(postMessage);
      bridgeTokensByChildThread.set(input.childThreadId, bridgeToken);
    }
    registerPendingMcpServer(input.childThreadId, {
      config:
        input.provider === "claudeAgent"
          ? {
              [mcpServerName]: makeSharedChatMcpServer({
                serverName: mcpServerName,
                onPostMessage: postMessage,
              }),
            }
          : {
              [mcpServerName]: makeSharedChatCodexMcpServerConfig({
                serverName: mcpServerName,
                bridgeToken,
                bridgeUrl: `${serverBaseUrl}${SHARED_CHAT_BRIDGE_ROUTE}`,
                ...(serverConfig.authToken === undefined
                  ? {}
                  : { bridgeAuthToken: serverConfig.authToken }),
              }),
            },
    });
  };

  const teardownSharedChatTool = (threadId: ThreadId) => {
    const bridgeToken = bridgeTokensByChildThread.get(threadId);
    if (bridgeToken === undefined) {
      return;
    }
    removeSharedChatBridge(bridgeToken);
    bridgeTokensByChildThread.delete(threadId);
  };

  const resolveWorkspaceRoot = Effect.fn("DiscussionReactor.resolveWorkspaceRoot")(function* (
    projectId: string,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const project = readModel.projects.find((p) => p.id === projectId);
    return project?.workspaceRoot;
  });

  const createChildrenForParentThread = Effect.fn(
    "DiscussionReactor.createChildrenForParentThread",
  )(function* (input: {
    readonly parentThreadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const parentThread = yield* resolveThread(input.parentThreadId);
    if (!parentThread || parentThread.discussionId === null) {
      return;
    }

    const workspaceRoot = yield* resolveWorkspaceRoot(parentThread.projectId);

    const discussionOption = yield* resolveDiscussion(parentThread.discussionId, workspaceRoot);
    if (Option.isNone(discussionOption)) {
      yield* appendSystemMessage(
        input.parentThreadId,
        `Discussion '${parentThread.discussionId}' was not found. Create it as a YAML file in ~/.forge/discussions/ or .forge/discussions/ in your project.`,
      );
      return;
    }

    const discussion: DiscussionDefinition = discussionOption.value;
    const parentSpawnWorkspace = resolveThreadSpawnWorkspace(parentThread);
    const roleOverrides = parentThread.discussionRoleModels ?? null;
    const participants: SharedChatParticipant[] = [];

    for (const participant of discussion.participants) {
      const overriddenModel = roleOverrides?.[participant.role] ?? participant.model;
      if (overriddenModel === undefined) {
        yield* appendSystemMessage(
          input.parentThreadId,
          `Discussion participant '${participant.role}' is missing a configured model.`,
        );
        return;
      }

      participants.push({
        threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
        role: participant.role,
        modelLabel: overriddenModel.model,
        modelSelection: overriddenModel,
        systemPrompt: buildSystemPrompt({
          role: participant.role,
          rawSystemText: participant.system,
        }),
      });
    }

    for (const participant of participants) {
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: discussionCommandId(`child:${input.parentThreadId}:${participant.role}`),
        threadId: participant.threadId,
        projectId: parentThread.projectId,
        title: `${parentThread.title} — ${formatRoleLabel(participant.role)}`,
        modelSelection: participant.modelSelection,
        runtimeMode: parentThread.runtimeMode,
        interactionMode: parentThread.interactionMode,
        spawnMode: parentSpawnWorkspace.mode,
        branch: parentSpawnWorkspace.branch,
        worktreePath: parentSpawnWorkspace.worktreePath,
        parentThreadId: input.parentThreadId,
        role: participant.role,
        createdAt: nowIso(),
      });

      registerPendingSystemPrompt(participant.threadId, participant.systemPrompt);

      registerSharedChatTool({
        childThreadId: participant.threadId,
        provider: participant.modelSelection.provider,
        parentThreadId: input.parentThreadId,
        role: participant.role,
        modelLabel: participant.modelLabel,
      });

      yield* sendMessageToChild({
        threadId: participant.threadId,
        text: input.messageText,
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        runtimeMode: parentThread.runtimeMode,
        interactionMode: parentThread.interactionMode,
      });
    }
  });

  const processTurnStartRequested = Effect.fn("DiscussionReactor.processTurnStartRequested")(
    function* (event: Extract<DiscussionReactorEvent, { type: "thread.turn-start-requested" }>) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread || thread.discussionId === null || thread.parentThreadId !== null) {
        return;
      }

      const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
      if (!message || message.role !== "user") {
        yield* Effect.logWarning("discussion reactor: user message not found", {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
        });
        return;
      }

      if (thread.childThreadIds.length === 0) {
        yield* createChildrenForParentThread({
          parentThreadId: event.payload.threadId,
          messageText: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        });
        return;
      }

      yield* deliverParentMessageToChildren({
        parentThreadId: event.payload.threadId,
        speakerLabel: "User",
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      });
    },
  );

  const processSummaryRequested = Effect.fn("DiscussionReactor.processSummaryRequested")(function* (
    event: Extract<DiscussionReactorEvent, { type: "thread.summary-requested" }>,
  ) {
    const parentThread = yield* resolveThread(event.payload.threadId);
    if (!parentThread) {
      return;
    }

    const isDiscussionContainer =
      parentThread.discussionId !== null || parentThread.childThreadIds.length > 0;
    if (!isDiscussionContainer) {
      return;
    }

    const transcript = parentThread.messages
      .map((msg) => {
        const label =
          msg.attribution !== undefined
            ? `${formatRoleLabel(msg.attribution.role)} (${msg.attribution.model})`
            : msg.role === "user"
              ? "User"
              : msg.role === "system"
                ? "System"
                : "Assistant";
        return `[${label}] ${msg.text}`;
      })
      .join("\n\n");

    const summaryThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
    const parentTitle = parentThread.title ?? "Untitled";
    const parentSpawnWorkspace = resolveThreadSpawnWorkspace(parentThread);

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: discussionCommandId(`summary:${event.payload.threadId}`),
      threadId: summaryThreadId,
      projectId: parentThread.projectId,
      title: `Summary — ${parentTitle}`,
      modelSelection: event.payload.modelSelection,
      runtimeMode: parentThread.runtimeMode,
      interactionMode: parentThread.interactionMode,
      spawnMode: parentSpawnWorkspace.mode,
      branch: parentSpawnWorkspace.branch,
      worktreePath: parentSpawnWorkspace.worktreePath,
      parentThreadId: event.payload.threadId,
      role: "summary",
      createdAt: nowIso(),
    });

    registerPendingSystemPrompt(
      summaryThreadId,
      [
        "You are a summarizer. Your only job is to read the transcript below and produce a structured markdown summary of the discussion.",
        "Do NOT participate in the discussion or add your own opinions. Only summarize what was said.",
        "When your summary is ready, call `post_to_chat` with the full markdown summary.",
      ].join("\n\n"),
    );

    registerSharedChatTool({
      childThreadId: summaryThreadId,
      provider: event.payload.modelSelection.provider,
      parentThreadId: event.payload.threadId,
      role: "summary",
      modelLabel: event.payload.modelSelection.model,
    });

    yield* sendMessageToChild({
      threadId: summaryThreadId,
      text: `Please summarize the following discussion transcript:\n\n${transcript}`,
      runtimeMode: parentThread.runtimeMode,
      interactionMode: parentThread.interactionMode,
    });
  });

  const processThreadCompleted = Effect.fn("DiscussionReactor.processThreadCompleted")(
    (event: Extract<DiscussionReactorEvent, { type: "thread.completed" }>) =>
      Effect.gen(function* () {
        teardownSharedChatTool(event.payload.threadId);
        const completedThread = yield* resolveThread(event.payload.threadId);
        if (!completedThread || completedThread.childThreadIds.length === 0) {
          return;
        }
        for (const childThreadId of completedThread.childThreadIds) {
          teardownSharedChatTool(childThreadId);
        }
      }),
  );

  const processEventSafely = (event: DiscussionReactorEvent) =>
    (event.type === "thread.summary-requested"
      ? processSummaryRequested(event)
      : event.type === "thread.completed"
        ? processThreadCompleted(event)
        : processTurnStartRequested(event)
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        return Effect.logError("discussion reactor failed to process orchestration event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: DiscussionReactorShape["start"] = () =>
    Stream.runForEach(
      Stream.filter(
        orchestrationEngine.streamDomainEvents as unknown as Stream.Stream<ForgeEvent>,
        (event) =>
          event.type === "thread.turn-start-requested" ||
          event.type === "thread.summary-requested" ||
          event.type === "thread.completed",
      ).pipe(Stream.map((event) => event as DiscussionReactorEvent)),
      worker.enqueue,
    ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies DiscussionReactorShape;
});

export const DiscussionReactorLive = Layer.effect(DiscussionReactor, makeDiscussionReactor);
