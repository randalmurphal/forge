import {
  type Channel,
  type ChannelId,
  CommandId,
  type DeliberationConfig,
  type ForgeCommand,
  type ForgeEvent,
  MessageId,
  ThreadId,
  type WorkflowId,
} from "@forgetools/contracts";
import { makeDrainableWorker } from "@forgetools/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { ChannelService } from "../../channel/Services/ChannelService.ts";
import { registerPendingDynamicTools } from "../../channel/pendingDynamicTools.ts";
import { PromptResolver } from "../../workflow/Services/PromptResolver.ts";
import { WorkflowRegistry } from "../../workflow/Services/WorkflowRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { PatternReactor, type PatternReactorShape } from "../Services/PatternReactor.ts";

type PatternReactorEvent = Extract<ForgeEvent, { type: "thread.turn-start-requested" }>;

function nowIso(): string {
  return new Date().toISOString();
}

function patternCommandId(tag: string): CommandId {
  return CommandId.makeUnsafe(`pattern:${tag}:${crypto.randomUUID()}`);
}

export const makePatternReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const channelService = yield* ChannelService;
  const workflowRegistry = yield* WorkflowRegistry;
  const promptResolver = yield* PromptResolver;
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);

  const dispatchForgeCommand = (command: ForgeCommand) =>
    orchestrationEngine.dispatch(
      command as unknown as Parameters<typeof orchestrationEngine.dispatch>[0],
    );

  const registerChannelToolForChild = (
    childThreadId: ThreadId,
    parentThreadId: ThreadId,
    role: string,
  ) => {
    registerPendingDynamicTools(
      childThreadId,
      [
        {
          name: "post_to_channel",
          description:
            "Post a message to the shared deliberation channel. All other participants will see it.",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string", description: "The message content to post." },
            },
            required: ["message"],
          },
        },
      ],
      async (toolName, args) => {
        if (toolName !== "post_to_channel") {
          return { content: `Unknown tool: ${toolName}`, success: false };
        }
        const message = typeof args.message === "string" ? args.message : JSON.stringify(args);
        const readModel = await runPromise(orchestrationEngine.getReadModel());
        const channel = readModel.channels.find(
          (ch: { threadId: string; type: string }) =>
            ch.threadId === parentThreadId && ch.type === "deliberation",
        );
        if (!channel) {
          return { content: "No deliberation channel found.", success: false };
        }
        await runPromise(
          channelService.postMessage({
            channelId: channel.id as ChannelId,
            fromType: "agent",
            fromId: childThreadId,
            fromRole: role,
            content: message,
            cursorThreadId: childThreadId,
          }),
        );
        return { content: "Message posted to channel.", success: true };
      },
    );
  };

  const resolveThread = Effect.fn("PatternReactor.resolveThread")(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const findDeliberationChannel = Effect.fn("PatternReactor.findDeliberationChannel")(function* (
    threadId: ThreadId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const channel = readModel.channels.find(
      (ch) => ch.threadId === threadId && ch.type === "deliberation",
    );
    return channel === undefined ? Option.none<Channel>() : Option.some(channel);
  });

  const resolveDeliberationConfig = Effect.fn("PatternReactor.resolveDeliberationConfig")(
    function* (workflowId: WorkflowId) {
      const workflowOption = yield* workflowRegistry.queryById({ workflowId });
      if (Option.isNone(workflowOption)) {
        return Option.none<DeliberationConfig>();
      }

      const workflow = workflowOption.value;
      for (const phase of workflow.phases) {
        if (phase.type === "multi-agent" && phase.deliberation !== undefined) {
          return Option.some(phase.deliberation);
        }
      }

      return Option.none<DeliberationConfig>();
    },
  );

  const createChildThreadsAndChannel = Effect.fn("PatternReactor.createChildThreadsAndChannel")(
    function* (input: { readonly threadId: ThreadId; readonly messageText: string }) {
      const thread = yield* resolveThread(input.threadId);
      if (!thread || thread.workflowId === null) {
        return;
      }

      const deliberationOption = yield* resolveDeliberationConfig(thread.workflowId);
      if (Option.isNone(deliberationOption)) {
        yield* Effect.logWarning("pattern reactor: no deliberation config found", {
          threadId: input.threadId,
          workflowId: thread.workflowId,
        });
        return;
      }

      const deliberation = deliberationOption.value;

      // Step 1: Create all child threads first so the deliberation engine
      // can find participants when the channel message is posted.
      const children: Array<{ threadId: ThreadId; role: string }> = [];
      for (const participant of deliberation.participants) {
        const childThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
        children.push({ threadId: childThreadId, role: participant.role });

        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: patternCommandId(`child:${input.threadId}:${participant.role}`),
          threadId: childThreadId,
          projectId: thread.projectId,
          title: `${thread.title} — ${participant.role}`,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: null,
          worktreePath: null,
          patternId: thread.patternId ?? undefined,
          parentThreadId: input.threadId,
          role: participant.role,
          createdAt: nowIso(),
        });
      }

      // Step 2: Create the deliberation channel now that participants exist.
      yield* channelService.createChannel({
        threadId: input.threadId,
        type: "deliberation",
      });

      // Step 3: Register dynamic tools and deliver the user's message to each child.
      for (const child of children) {
        registerChannelToolForChild(child.threadId, input.threadId, child.role);

        const childMessageId = MessageId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: patternCommandId(`turn:${child.threadId}`),
          threadId: child.threadId,
          message: {
            messageId: childMessageId,
            role: "user" as const,
            text: input.messageText,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: nowIso(),
        });
      }
    },
  );

  const deliverMessageToChildren = Effect.fn("PatternReactor.deliverMessageToChildren")(
    function* (input: { readonly threadId: ThreadId; readonly messageText: string }) {
      const thread = yield* resolveThread(input.threadId);
      if (!thread) {
        return;
      }

      // Post the user's message to the existing deliberation channel.
      const channelOption = yield* findDeliberationChannel(input.threadId);
      if (Option.isSome(channelOption)) {
        yield* channelService.postMessage({
          channelId: channelOption.value.id,
          fromType: "human",
          fromId: input.threadId,
          content: input.messageText,
        });
      }

      // Deliver the message to each child thread.
      for (const childThreadId of thread.childThreadIds) {
        const childMessageId = MessageId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: patternCommandId(`turn:${childThreadId}`),
          threadId: childThreadId,
          message: {
            messageId: childMessageId,
            role: "user" as const,
            text: input.messageText,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: nowIso(),
        });
      }
    },
  );

  const processTurnStartRequested = Effect.fn("PatternReactor.processTurnStartRequested")(
    function* (event: PatternReactorEvent) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }

      // Only handle pattern container threads (has patternId, no parent).
      if (thread.patternId === null || thread.parentThreadId !== null) {
        return;
      }

      // Find the user message from the read model.
      const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
      if (!message || message.role !== "user") {
        yield* Effect.logWarning("pattern reactor: user message not found", {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
        });
        return;
      }

      const isFirstMessage = thread.childThreadIds.length === 0;

      if (isFirstMessage) {
        yield* createChildThreadsAndChannel({
          threadId: event.payload.threadId,
          messageText: message.text,
        });
      } else {
        yield* deliverMessageToChildren({
          threadId: event.payload.threadId,
          messageText: message.text,
        });
      }
    },
  );

  const processEventSafely = (event: PatternReactorEvent) =>
    processTurnStartRequested(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        return Effect.logError("pattern reactor failed to process orchestration event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: PatternReactorShape["start"] = () =>
    Stream.runForEach(
      Stream.filter(
        orchestrationEngine.streamDomainEvents as unknown as Stream.Stream<ForgeEvent>,
        (event) => event.type === "thread.turn-start-requested",
      ).pipe(Stream.map((event) => event as PatternReactorEvent)),
      worker.enqueue,
    ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies PatternReactorShape;
});

export const PatternReactorLive = Layer.effect(PatternReactor, makePatternReactor);
