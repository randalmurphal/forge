import {
  CommandId,
  DesignArtifactId,
  type ForgeCommand,
  type ForgeEvent,
  InteractiveRequestId,
  type ThreadId,
} from "@forgetools/contracts";
import { makeDrainableWorker } from "@forgetools/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { registerPendingMcpServer } from "../provider/pendingMcpServers.ts";
import { registerPendingSystemPrompt } from "../provider/pendingSystemPrompt.ts";
import { storeArtifact } from "./artifactStorage.ts";
import { registerDesignBridge, removeDesignBridge, DESIGN_BRIDGE_ROUTE } from "./designBridge.ts";
import { makeDesignMcpServer, makeDesignCodexMcpServerConfig } from "./designMcpServer.ts";
import { resolveDesignSystemPrompt } from "./designSystemPrompt.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  DesignModeReactor,
  type DesignModeReactorShape,
} from "../orchestration/Services/DesignModeReactor.ts";
import { ProjectionInteractiveRequestRepository } from "../persistence/Services/ProjectionInteractiveRequests.ts";

type DesignReactorEvent = Extract<ForgeEvent, { type: "request.resolved" | "thread.completed" }>;

interface PendingDesignChoice {
  readonly resolve: (value: { readonly chosen: string; readonly title: string }) => void;
  readonly reject: (reason: Error) => void;
}

function designCommandId(tag: string): CommandId {
  return CommandId.makeUnsafe(`design:${tag}:${crypto.randomUUID()}`);
}

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

export const makeDesignModeReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverConfig = yield* ServerConfig;
  const interactiveRequests = yield* ProjectionInteractiveRequestRepository;
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);
  const serverBaseUrl = resolveLocalServerBaseUrl(serverConfig);

  const pendingDesignChoices = new Map<string, PendingDesignChoice>();
  const bridgeTokensByThread = new Map<string, string>();

  const dispatchForgeCommand = (command: ForgeCommand) =>
    orchestrationEngine.dispatch(
      command as unknown as Parameters<typeof orchestrationEngine.dispatch>[0],
    );

  const setupDesignMode: DesignModeReactorShape["setupDesignMode"] = (input) => {
    const { threadId, provider, artifactsBaseDir } = input;

    const systemPrompt = resolveDesignSystemPrompt(serverConfig.baseDir);
    registerPendingSystemPrompt(threadId, systemPrompt);

    const onRenderDesign = async (renderArgs: {
      readonly html: string;
      readonly title: string;
      readonly description?: string | undefined;
    }) => {
      const stored = storeArtifact(artifactsBaseDir, threadId, {
        html: renderArgs.html,
        title: renderArgs.title,
        ...(renderArgs.description !== undefined ? { description: renderArgs.description } : {}),
      });

      await runPromise(
        dispatchForgeCommand({
          type: "thread.design.artifact-rendered",
          commandId: designCommandId("artifact-rendered"),
          threadId: threadId as ThreadId,
          artifactId: DesignArtifactId.makeUnsafe(stored.artifactId),
          title: stored.title,
          description: stored.description,
          artifactPath: stored.artifactPath,
          createdAt: nowIso(),
        }),
      );

      return { artifactId: stored.artifactId, status: "rendered" };
    };

    const onPresentOptions = async (optionArgs: {
      readonly prompt: string;
      readonly options: ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly description: string;
        readonly html: string;
      }>;
    }) => {
      const requestId = InteractiveRequestId.makeUnsafe(
        `design-option:${threadId}:${crypto.randomUUID()}`,
      );

      const storedOptions = optionArgs.options.map((option) => {
        const stored = storeArtifact(artifactsBaseDir, threadId, {
          html: option.html,
          title: option.title,
          description: option.description,
          kind: "option",
        });
        return {
          id: option.id,
          title: option.title,
          description: option.description,
          artifactId: DesignArtifactId.makeUnsafe(stored.artifactId),
          artifactPath: stored.artifactPath,
        };
      });

      const choicePromise = new Promise<{ readonly chosen: string; readonly title: string }>(
        (resolve, reject) => {
          pendingDesignChoices.set(requestId, { resolve, reject });
        },
      );

      const createdAt = nowIso();

      await runPromise(
        dispatchForgeCommand({
          type: "request.open",
          commandId: designCommandId("design-option-request"),
          requestId,
          threadId: threadId as ThreadId,
          requestType: "design-option",
          payload: {
            type: "design-option",
            prompt: optionArgs.prompt,
            options: storedOptions,
          },
          createdAt,
        }),
      );

      await runPromise(
        dispatchForgeCommand({
          type: "thread.design.options-presented",
          commandId: designCommandId("options-presented"),
          threadId: threadId as ThreadId,
          requestId,
          prompt: optionArgs.prompt,
          options: storedOptions,
          createdAt,
        }),
      );

      return choicePromise;
    };

    const mcpServerName = `forge-design-${threadId}`;
    let bridgeToken = bridgeTokensByThread.get(threadId);
    if (bridgeToken === undefined) {
      bridgeToken = registerDesignBridge(async (action) => {
        if (action.action === "render_design") {
          const result = await onRenderDesign(action);
          return JSON.stringify(result);
        }
        if (action.action === "present_options") {
          const result = await onPresentOptions(action);
          return JSON.stringify(result);
        }
        throw new Error(`Unknown design bridge action: ${(action as { action: string }).action}`);
      });
      bridgeTokensByThread.set(threadId, bridgeToken);
    }

    registerPendingMcpServer(threadId, {
      config:
        provider === "claudeAgent"
          ? {
              [mcpServerName]: makeDesignMcpServer({
                serverName: mcpServerName,
                onRenderDesign,
                onPresentOptions,
              }),
            }
          : {
              [mcpServerName]: makeDesignCodexMcpServerConfig({
                serverName: mcpServerName,
                bridgeToken,
                bridgeUrl: `${serverBaseUrl}${DESIGN_BRIDGE_ROUTE}`,
                ...(serverConfig.authToken === undefined
                  ? {}
                  : { bridgeAuthToken: serverConfig.authToken }),
              }),
            },
    });
  };

  const teardownDesignMode: DesignModeReactorShape["teardownDesignMode"] = (threadId) => {
    const token = bridgeTokensByThread.get(threadId);
    if (token !== undefined) {
      removeDesignBridge(token);
      bridgeTokensByThread.delete(threadId);
    }

    for (const [requestId, pending] of pendingDesignChoices) {
      if (requestId.includes(threadId)) {
        pending.reject(new Error("Design mode session ended."));
        pendingDesignChoices.delete(requestId);
      }
    }
  };

  const processRequestResolved = Effect.fn("DesignModeReactor.processRequestResolved")(function* (
    event: Extract<DesignReactorEvent, { type: "request.resolved" }>,
  ) {
    const request = yield* interactiveRequests.queryById({
      requestId: event.payload.requestId,
    });
    if (Option.isNone(request)) {
      return;
    }

    if (request.value.type !== "design-option" || request.value.resolvedWith === null) {
      return;
    }

    const resolution = request.value.resolvedWith;
    const chosenOptionId = "chosenOptionId" in resolution ? resolution.chosenOptionId : null;
    if (chosenOptionId === null) {
      return;
    }

    const pending = pendingDesignChoices.get(event.payload.requestId);
    if (!pending) {
      return;
    }

    pendingDesignChoices.delete(event.payload.requestId);

    // Resolve the option title from the request payload
    const optionPayload = request.value.payload;
    const chosenOption =
      "options" in optionPayload
        ? (optionPayload.options as ReadonlyArray<{ id: string; title: string }>).find(
            (opt) => opt.id === chosenOptionId,
          )
        : undefined;

    const chosenTitle = chosenOption?.title ?? (chosenOptionId as string);

    yield* dispatchForgeCommand({
      type: "thread.design.option-chosen",
      commandId: designCommandId("option-chosen"),
      threadId: request.value.threadId as ThreadId,
      requestId: event.payload.requestId as InteractiveRequestId,
      chosenOptionId: chosenOptionId as string,
      chosenTitle,
      createdAt: nowIso(),
    });

    pending.resolve({
      chosen: chosenOptionId as string,
      title: chosenTitle,
    });
  });

  const processThreadCompleted = Effect.fn("DesignModeReactor.processThreadCompleted")(
    (event: Extract<DesignReactorEvent, { type: "thread.completed" }>) =>
      Effect.sync(() => {
        teardownDesignMode(event.payload.threadId);
      }),
  );

  const processEventSafely = (event: DesignReactorEvent) =>
    (event.type === "thread.completed"
      ? processThreadCompleted(event)
      : processRequestResolved(event)
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        return Effect.logError("design mode reactor failed to process orchestration event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: DesignModeReactorShape["start"] = () =>
    Stream.runForEach(
      Stream.filter(
        orchestrationEngine.streamDomainEvents as unknown as Stream.Stream<ForgeEvent>,
        (event) => event.type === "request.resolved" || event.type === "thread.completed",
      ).pipe(Stream.map((event) => event as DesignReactorEvent)),
      worker.enqueue,
    ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    start,
    setupDesignMode,
    teardownDesignMode,
    drain: worker.drain,
  } satisfies DesignModeReactorShape;
});

export const DesignModeReactorLive = Layer.effect(DesignModeReactor, makeDesignModeReactor);
