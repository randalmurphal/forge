import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChannelId,
  ChannelMessageId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  InteractiveRequestId,
  KeybindingRule,
  OpenError,
  PhaseRunId,
  TerminalNotRunningError,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ResolvedKeybindingRule,
  ThreadId,
  WorkflowId,
  WorkflowPhaseId,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
} from "@forgetools/contracts";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import type { ServerConfigShape } from "./config.ts";
import { deriveServerPaths, ServerConfig } from "./config.ts";
import { makeRoutesLayer } from "./server.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { GitCore, type GitCoreShape } from "./git/Services/GitCore.ts";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import { Keybindings, type KeybindingsShape } from "./keybindings.ts";
import { Open, type OpenShape } from "./open.ts";
import { ChannelService, type ChannelServiceShape } from "./channel/Services/ChannelService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import {
  ProjectionInteractiveRequestRepository,
  type ProjectionInteractiveRequestRepositoryShape,
} from "./persistence/Services/ProjectionInteractiveRequests.ts";
import {
  ProjectionPhaseOutputRepository,
  type ProjectionPhaseOutputRepositoryShape,
} from "./persistence/Services/ProjectionPhaseOutputs.ts";
import {
  ProjectionPhaseRunRepository,
  type ProjectionPhaseRunRepositoryShape,
} from "./persistence/Services/ProjectionPhaseRuns.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "./persistence/Services/ProjectionThreadMessages.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "./persistence/Services/ProjectionThreads.ts";
import {
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
} from "./persistence/Services/ProjectionThreadSessions.ts";
import {
  ProjectionWorkflowRepository,
  type ProjectionWorkflowRepositoryShape,
} from "./persistence/Services/ProjectionWorkflows.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import { ServerLifecycleEvents, type ServerLifecycleEventsShape } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "./serverRuntimeStartup.ts";
import { ServerSettingsService, type ServerSettingsShape } from "./serverSettings.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import {
  WorkflowRegistry,
  type WorkflowRegistryShape,
} from "./workflow/Services/WorkflowRegistry.ts";

const defaultProjectId = ProjectId.makeUnsafe("project-default");
const defaultThreadId = ThreadId.makeUnsafe("thread-default");
const defaultModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
} as const;

const makeDefaultOrchestrationReadModel = () => {
  const now = new Date().toISOString();
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        parentThreadId: null,
        phaseRunId: null,
        workflowId: null,
        currentPhaseId: null,
        patternId: null,
        role: null,
        childThreadIds: [],
        bootstrapStatus: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
    phaseRuns: [],
    channels: [],
    pendingRequests: [],
    workflows: [],
  };
};

const workspaceAndProjectServicesLayer = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive)),
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  ),
  ProjectFaviconResolverLive,
);

const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfigShape>;
  layers?: {
    keybindings?: Partial<KeybindingsShape>;
    providerRegistry?: Partial<ProviderRegistryShape>;
    serverSettings?: Partial<ServerSettingsShape>;
    open?: Partial<OpenShape>;
    gitCore?: Partial<GitCoreShape>;
    gitManager?: Partial<GitManagerShape>;
    terminalManager?: Partial<TerminalManagerShape>;
    orchestrationEngine?: Partial<OrchestrationEngineShape>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
    workflowRegistry?: Partial<WorkflowRegistryShape>;
    channelService?: Partial<ChannelServiceShape>;
    projectionWorkflowRepository?: Partial<ProjectionWorkflowRepositoryShape>;
    projectionPhaseRunRepository?: Partial<ProjectionPhaseRunRepositoryShape>;
    projectionPhaseOutputRepository?: Partial<ProjectionPhaseOutputRepositoryShape>;
    projectionThreadRepository?: Partial<ProjectionThreadRepositoryShape>;
    projectionThreadMessageRepository?: Partial<ProjectionThreadMessageRepositoryShape>;
    projectionThreadSessionRepository?: Partial<ProjectionThreadSessionRepositoryShape>;
    projectionInteractiveRequestRepository?: Partial<ProjectionInteractiveRequestRepositoryShape>;
    checkpointDiffQuery?: Partial<CheckpointDiffQueryShape>;
    serverLifecycleEvents?: Partial<ServerLifecycleEventsShape>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartupShape>;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    const config: ServerConfigShape = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "forge-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      authToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      ...options?.config,
    };
    const layerConfig = Layer.succeed(ServerConfig, config);

    const mockedServicesLayer = Layer.mergeAll(
      Layer.mock(Keybindings)({
        streamChanges: Stream.empty,
        ...options?.layers?.keybindings,
      }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([]),
        refresh: () => Effect.succeed([]),
        streamChanges: Stream.empty,
        ...options?.layers?.providerRegistry,
      }),
      Layer.mock(ServerSettingsService)({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
        streamChanges: Stream.empty,
        ...options?.layers?.serverSettings,
      }),
      Layer.mock(Open)({
        ...options?.layers?.open,
      }),
      Layer.mock(GitCore)({
        ...options?.layers?.gitCore,
      }),
      Layer.mock(GitManager)({
        ...options?.layers?.gitManager,
      }),
      Layer.mock(TerminalManager)({
        ...options?.layers?.terminalManager,
      }),
      Layer.mock(OrchestrationEngineService)({
        getReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
        readEvents: () => Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        ...options?.layers?.orchestrationEngine,
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
        ...options?.layers?.projectionSnapshotQuery,
      }),
      Layer.mock(WorkflowRegistry)({
        queryAll: () => Effect.succeed([]),
        queryById: () => Effect.succeed(Option.none()),
        queryByName: () => Effect.succeed(Option.none()),
        ...options?.layers?.workflowRegistry,
      }),
      Layer.mock(ChannelService)({
        createChannel: () => Effect.die("unused"),
        postMessage: () => Effect.die("unused"),
        getMessages: () => Effect.succeed([]),
        getUnreadCount: () => Effect.succeed(0),
        getCursor: () => Effect.succeed(-1 as never),
        advanceCursor: () => Effect.void,
        ...options?.layers?.channelService,
      }),
      Layer.mock(ProjectionWorkflowRepository)({
        upsert: () => Effect.void,
        queryById: () => Effect.succeed(Option.none()),
        queryByName: () => Effect.succeed(Option.none()),
        queryAll: () => Effect.succeed([]),
        delete: () => Effect.void,
        ...options?.layers?.projectionWorkflowRepository,
      }),
      Layer.mock(ProjectionPhaseRunRepository)({
        upsert: () => Effect.void,
        queryById: () => Effect.succeed(Option.none()),
        queryByThreadId: () => Effect.succeed([]),
        updateStatus: () => Effect.void,
        ...options?.layers?.projectionPhaseRunRepository,
      }),
      Layer.mock(ProjectionPhaseOutputRepository)({
        upsert: () => Effect.void,
        queryByPhaseRunId: () => Effect.succeed([]),
        queryByKey: () => Effect.succeed(Option.none()),
        ...options?.layers?.projectionPhaseOutputRepository,
      }),
      Layer.mock(ProjectionThreadRepository)({
        upsert: () => Effect.void,
        getById: () => Effect.succeed(Option.none()),
        listByProjectId: () => Effect.succeed([]),
        deleteById: () => Effect.void,
        ...options?.layers?.projectionThreadRepository,
      }),
      Layer.mock(ProjectionThreadMessageRepository)({
        upsert: () => Effect.void,
        getByMessageId: () => Effect.succeed(Option.none()),
        listByThreadId: () => Effect.succeed([]),
        deleteByThreadId: () => Effect.void,
        ...options?.layers?.projectionThreadMessageRepository,
      }),
      Layer.mock(ProjectionThreadSessionRepository)({
        upsert: () => Effect.void,
        getByThreadId: () => Effect.succeed(Option.none()),
        deleteByThreadId: () => Effect.void,
        ...options?.layers?.projectionThreadSessionRepository,
      }),
      Layer.mock(ProjectionInteractiveRequestRepository)({
        upsert: () => Effect.void,
        queryByThreadId: () => Effect.succeed([]),
        queryById: () => Effect.succeed(Option.none()),
        queryPending: () => Effect.succeed([]),
        updateStatus: () => Effect.void,
        markStale: () => Effect.void,
        ...options?.layers?.projectionInteractiveRequestRepository,
      }),
      Layer.mock(CheckpointDiffQuery)({
        getTurnDiff: () =>
          Effect.succeed({
            threadId: defaultThreadId,
            fromTurnCount: 0,
            toTurnCount: 0,
            diff: "",
          }),
        getFullThreadDiff: () =>
          Effect.succeed({
            threadId: defaultThreadId,
            fromTurnCount: 0,
            toTurnCount: 0,
            diff: "",
          }),
        ...options?.layers?.checkpointDiffQuery,
      }),
      Layer.mock(ServerLifecycleEvents)({
        publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
        snapshot: Effect.succeed({ sequence: 0, events: [] }),
        stream: Stream.empty,
        ...options?.layers?.serverLifecycleEvents,
      }),
      Layer.mock(ServerRuntimeStartup)({
        awaitCommandReady: Effect.void,
        markHttpListening: Effect.void,
        enqueueCommand: (effect) => effect,
        ...options?.layers?.serverRuntimeStartup,
      }),
    );

    const appLayer = HttpRouter.serve(makeRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(mockedServicesLayer),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

const wsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const getWsServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `ws://127.0.0.1:${address.port}${pathname}`;
  });

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar");
      const response = yield* Effect.promise(() => fetch(url, { redirect: "manual" }));

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "http://127.0.0.1:5173/");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves project favicon requests before the dev URL redirect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-",
      });
      yield* fileSystem.writeFileString(
        path.join(projectDir, "favicon.svg"),
        "<svg>router-project-favicon</svg>",
      );

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "<svg>router-project-favicon</svg>");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the fallback project favicon when no icon exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-fallback-",
      });

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.include(yield* response.text, 'data-fallback="project-favicon"');
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files from state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.bin`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const response = yield* HttpClient.get(`/attachments/${attachmentId}`);
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files for URL-encoded paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: "thread%20folder/message%20folder/file%20name.png",
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-encoded-ok");

      const response = yield* HttpClient.get(
        "/attachments/thread%20folder/message%20folder/file%20name.png",
      );
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-encoded-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for missing attachment id lookups", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get(
        "/attachments/missing-11111111-1111-4111-8111-111111111111",
      );
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when auth token is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest({
        config: {
          authToken: "secret-token",
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertInclude(String(result.failure), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts websocket rpc handshake when auth token is provided", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-ok-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest({
        config: {
          authToken: "secret-token",
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws?token=secret-token");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const providers = [] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.equal(first.config.observability.logsDirectoryPath.endsWith("/logs"), true);
        assert.equal(first.config.observability.localTracingEnabled, true);
        assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(first.config.observability.otlpTracesEnabled, true);
        assert.equal(first.config.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(first.config.observability.otlpMetricsEnabled, true);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: { issues: [] },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig emits provider status updates", () =>
    Effect.gen(function* () {
      const providers = [] as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      assert.deepEqual(second, {
        version: 1,
        type: "providerStatuses",
        payload: { providers },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: new Date().toISOString() },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        assert.equal(second?.type, "ready");
        assert.equal(second?.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-search-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: "/definitely/not/a/real/workspace/path",
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectSearchEntriesError");
      assertInclude(
        result.failure.message,
        "Workspace root does not exist: /definitely/not/a/real/workspace/path",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }),
        ),
      );

      assert.equal(response.relativePath, "nested/created.txt");
      const persisted = yield* fs.readFileString(path.join(workspaceDir, "nested", "created.txt"));
      assert.equal(persisted, "written-by-rpc");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "../escape.txt",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectWriteFileError");
      assert.equal(
        result.failure.message,
        "Workspace file path must stay within the project root.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor", () =>
    Effect.gen(function* () {
      let openedInput: { cwd: string; editor: EditorId } | null = null;
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: (input) =>
              Effect.sync(() => {
                openedInput = input;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ),
      );

      assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor errors", () =>
    Effect.gen(function* () {
      const openError = new OpenError({ message: "Editor command not found: cursor" });
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: () => Effect.fail(openError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, openError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            status: () =>
              Effect.succeed({
                isRepo: true,
                hasOriginRemote: true,
                isDefaultBranch: true,
                branch: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            runStackedAction: (input, options) =>
              Effect.gen(function* () {
                const result = {
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                };

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "phase_started",
                    phase: "commit",
                    label: "Committing...",
                  }) ?? Effect.void
                );

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "action_finished",
                    result,
                  }) ?? Effect.void
                );

                return result;
              }),
            resolvePullRequest: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
              }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
                branch: "feature/demo",
                worktreePath: null,
              }),
          },
          gitCore: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled",
                branch: "main",
                upstreamBranch: "origin/main",
              }),
            listBranches: () =>
              Effect.succeed({
                branches: [
                  {
                    name: "main",
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasOriginRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/tmp/wt", branch: "feature/demo" },
              }),
            removeWorktree: () => Effect.void,
            createBranch: () => Effect.void,
            checkoutBranch: () => Effect.void,
            initRepo: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const status = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitStatus]({ cwd: "/tmp/repo" })),
      );
      assert.equal(status.branch, "main");

      const pull = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitPull]({ cwd: "/tmp/repo" })),
      );
      assert.equal(pull.status, "pulled");

      const stackedEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ),
      );
      const lastStackedEvent = stackedEvents.at(-1);
      assert.equal(lastStackedEvent?.kind, "action_finished");
      if (lastStackedEvent?.kind === "action_finished") {
        assert.equal(lastStackedEvent.result.action, "commit");
      }

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: "/tmp/repo",
            reference: "1",
          }),
        ),
      );
      assert.equal(resolvedPr.pullRequest.number, 1);

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: "/tmp/repo",
            reference: "1",
            mode: "local",
          }),
        ),
      );
      assert.equal(prepared.branch, "feature/demo");

      const branches = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitListBranches]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(branches.branches[0]?.name, "main");

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktree]({
            cwd: "/tmp/repo",
            branch: "main",
            path: null,
          }),
        ),
      );
      assert.equal(worktree.worktree.branch, "feature/demo");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRemoveWorktree]({
            cwd: "/tmp/repo",
            path: "/tmp/wt",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateBranch]({
            cwd: "/tmp/repo",
            branch: "feature/new",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCheckout]({
            cwd: "/tmp/repo",
            branch: "main",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitInit]({
            cwd: "/tmp/repo",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.pull errors", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "pull",
        command: "git pull --ff-only",
        cwd: "/tmp/repo",
        detail: "upstream missing",
      });
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            pullCurrentBranch: () => Effect.fail(gitError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitPull]({ cwd: "/tmp/repo" })).pipe(
          Effect.result,
        ),
      );

      assertFailure(result, gitError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration methods", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.makeUnsafe("project-a"),
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            projectId: ProjectId.makeUnsafe("project-a"),
            title: "Thread A",
            modelSelection: defaultModelSelection,
            interactionMode: "default" as const,
            runtimeMode: "full-access" as const,
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            parentThreadId: null,
            phaseRunId: null,
            workflowId: null,
            currentPhaseId: null,
            patternId: null,
            role: null,
            childThreadIds: [],
            bootstrapStatus: null,
            latestTurn: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
        phaseRuns: [],
        channels: [],
        pendingRequests: [],
        workflows: [],
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () => Effect.succeed(snapshot),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.makeUnsafe("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "turn-diff",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.makeUnsafe("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "full-diff",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const snapshotResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      );
      assert.equal(snapshotResult.snapshotSequence, 1);

      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe("cmd-1"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: now,
          }),
        ),
      );
      assert.equal(dispatchResult.sequence, 7);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.makeUnsafe("thread-1"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(turnDiffResult.diff, "turn-diff");

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.makeUnsafe("thread-1"),
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(fullDiffResult.diff, "full-diff");

      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({
            fromSequenceExclusive: 0,
          }),
        ),
      );
      assert.deepEqual(replayResult, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes thread terminals after a successful archive command", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-archive");
      const closeInputs: Array<Parameters<TerminalManagerShape["close"]>[0]> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                closeInputs.push(input);
              }),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 8 }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("cmd-thread-archive"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 8);
      assert.deepEqual(closeInputs, [{ threadId }]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeOrchestrationDomainEvents with replay/live overlap resilience",
    () =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe("thread-1");
        let replayCursor: number | null = null;
        const makeEvent = (sequence: number): OrchestrationEvent =>
          ({
            sequence,
            eventId: `event-${sequence}`,
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.reverted",
            payload: {
              threadId,
              turnCount: sequence,
            },
          }) as OrchestrationEvent;

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed({
                  ...makeDefaultOrchestrationReadModel(),
                  snapshotSequence: 1,
                }),
              readEvents: (fromSequenceExclusive) => {
                replayCursor = fromSequenceExclusive;
                return Stream.make(makeEvent(2), makeEvent(3));
              },
              streamDomainEvents: Stream.make(makeEvent(3), makeEvent(4)),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}).pipe(
              Stream.take(3),
              Stream.runCollect,
            ),
          ),
        );

        assert.equal(replayCursor, 1);
        assert.deepEqual(
          Array.from(events).map((event) => event.sequence),
          [2, 3, 4],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeWorkflowEvents with staged event mapping", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("thread-workflow");
      const phaseRunId = PhaseRunId.makeUnsafe("phase-run-workflow");
      const phaseId = WorkflowPhaseId.makeUnsafe("phase-design");
      const requestId = InteractiveRequestId.makeUnsafe("request-gate");
      let replayCursor: number | null = null;

      const phaseStartedEvent = {
        sequence: 2,
        eventId: "event-2",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.phase-started",
        payload: {
          threadId,
          phaseRunId,
          phaseId,
          phaseName: "Design",
          phaseType: "single-agent",
          iteration: 1,
          startedAt: now,
        },
      } as unknown as OrchestrationEvent;
      const gateOpenedEvent = {
        sequence: 3,
        eventId: "event-3",
        aggregateKind: "request",
        aggregateId: requestId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "request.opened",
        payload: {
          requestId,
          threadId,
          childThreadId: null,
          phaseRunId,
          requestType: "gate",
          payload: {
            type: "gate",
            gateType: "human-approval",
            phaseRunId,
          },
          createdAt: now,
        },
      } as unknown as OrchestrationEvent;
      const gateResolvedEvent = {
        sequence: 4,
        eventId: "event-4",
        aggregateKind: "request",
        aggregateId: requestId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "request.resolved",
        payload: {
          requestId,
          resolvedWith: {
            decision: "approve",
          },
          resolvedAt: now,
        },
      } as unknown as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                ...makeDefaultOrchestrationReadModel(),
                snapshotSequence: 1,
              }),
            readEvents: (fromSequenceExclusive) => {
              replayCursor = fromSequenceExclusive;
              return Stream.make(phaseStartedEvent, gateOpenedEvent);
            },
            streamDomainEvents: Stream.make(gateOpenedEvent, gateResolvedEvent),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeWorkflowEvents]({ threadId }).pipe(
            Stream.take(3),
            Stream.runCollect,
          ),
        ),
      );

      assert.equal(replayCursor, 1);
      assert.deepEqual(Array.from(events), [
        {
          channel: "workflow.phase",
          threadId,
          phaseRunId,
          event: "started",
          phaseInfo: {
            phaseId,
            phaseName: "Design",
            phaseType: "single-agent",
            iteration: 1,
          },
          timestamp: now,
        },
        {
          channel: "workflow.gate",
          threadId,
          phaseRunId,
          gateType: "human-approval",
          status: "waiting-human",
          requestId,
          timestamp: now,
        },
        {
          channel: "workflow.gate",
          threadId,
          phaseRunId,
          gateType: "human-approval",
          status: "passed",
          timestamp: now,
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeChannelMessages with staged event mapping", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const ownerThreadId = ThreadId.makeUnsafe("thread-parent");
      const participantThreadId = ThreadId.makeUnsafe("thread-child");
      const channelId = ChannelId.makeUnsafe("channel-review");
      const messageId = ChannelMessageId.makeUnsafe("channel-message-1");
      let replayCursor: number | null = null;

      const channelCreatedEvent = {
        sequence: 2,
        eventId: "event-2",
        aggregateKind: "channel",
        aggregateId: channelId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "channel.created",
        payload: {
          channelId,
          threadId: ownerThreadId,
          channelType: "deliberation",
          phaseRunId: null,
          createdAt: now,
        },
      } as unknown as OrchestrationEvent;
      const messagePostedEvent = {
        sequence: 3,
        eventId: "event-3",
        aggregateKind: "channel",
        aggregateId: channelId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "channel.message-posted",
        payload: {
          channelId,
          messageId,
          sequence: 1,
          fromType: "agent",
          fromId: participantThreadId,
          fromRole: "reviewer",
          content: "Please tighten the failure handling.",
          createdAt: now,
        },
      } as unknown as OrchestrationEvent;
      const conclusionEvent = {
        sequence: 4,
        eventId: "event-4",
        aggregateKind: "channel",
        aggregateId: channelId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "channel.conclusion-proposed",
        payload: {
          channelId,
          threadId: participantThreadId,
          summary: "The patch is ready with one follow-up note.",
          proposedAt: now,
        },
      } as unknown as OrchestrationEvent;
      const closedEvent = {
        sequence: 5,
        eventId: "event-5",
        aggregateKind: "channel",
        aggregateId: channelId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "channel.closed",
        payload: {
          channelId,
          closedAt: now,
        },
      } as unknown as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                ...makeDefaultOrchestrationReadModel(),
                snapshotSequence: 1,
              }),
            readEvents: (fromSequenceExclusive) => {
              replayCursor = fromSequenceExclusive;
              return Stream.make(channelCreatedEvent, messagePostedEvent);
            },
            streamDomainEvents: Stream.make(messagePostedEvent, conclusionEvent, closedEvent),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeChannelMessages]({ channelId }).pipe(
            Stream.take(3),
            Stream.runCollect,
          ),
        ),
      );

      assert.equal(replayCursor, 1);
      assert.deepEqual(Array.from(events), [
        {
          channel: "channel.message",
          channelId,
          threadId: ownerThreadId,
          message: {
            id: messageId,
            channelId,
            sequence: 1,
            fromType: "agent",
            fromId: participantThreadId,
            fromRole: "reviewer",
            content: "Please tighten the failure handling.",
            createdAt: now,
          },
          timestamp: now,
        },
        {
          channel: "channel.conclusion",
          channelId,
          threadId: ownerThreadId,
          sessionId: participantThreadId,
          summary: "The patch is ready with one follow-up note.",
          allProposed: false,
          timestamp: now,
        },
        {
          channel: "channel.status",
          channelId,
          status: "closed",
          timestamp: now,
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc workflow, session, channel, and phase query methods", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const workflowId = WorkflowId.makeUnsafe("workflow-query");
      const phaseRunId = PhaseRunId.makeUnsafe("phase-run-query");
      const phaseId = WorkflowPhaseId.makeUnsafe("phase-query");
      const childThreadId = ThreadId.makeUnsafe("thread-child");
      const channelId = ChannelId.makeUnsafe("channel-query");
      const workflow = {
        id: workflowId,
        name: "Query Workflow",
        description: "workflow used by ws query tests",
        builtIn: false,
        createdAt: now,
        updatedAt: now,
        phases: [
          {
            id: phaseId,
            name: "implement",
            type: "single-agent" as const,
            agent: {
              prompt: "implement",
              output: { type: "conversation" as const },
            },
            gate: {
              after: "done" as const,
              onFail: "stop" as const,
              maxRetries: 0,
            },
          },
        ],
      };
      const upsertedWorkflows: Array<any> = [];

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                ...makeDefaultOrchestrationReadModel(),
                channels: [
                  {
                    id: channelId,
                    threadId: defaultThreadId,
                    type: "deliberation" as const,
                    status: "open" as const,
                    phaseRunId,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              }),
          },
          workflowRegistry: {
            queryAll: () => Effect.succeed([workflow]),
            queryById: ({ workflowId: requestedWorkflowId }) =>
              Effect.succeed(
                requestedWorkflowId === workflowId ? Option.some(workflow) : Option.none(),
              ),
          },
          projectionWorkflowRepository: {
            upsert: (row) =>
              Effect.sync(() => {
                upsertedWorkflows.push(row);
              }),
          },
          channelService: {
            getMessages: () =>
              Effect.succeed([
                {
                  id: ChannelMessageId.makeUnsafe("channel-message-query"),
                  channelId,
                  sequence: 0,
                  fromType: "agent",
                  fromId: childThreadId,
                  fromRole: "reviewer",
                  content: "channel content",
                  createdAt: now,
                },
              ]),
          },
          projectionPhaseRunRepository: {
            queryByThreadId: ({ threadId }) =>
              Effect.succeed(
                threadId === defaultThreadId
                  ? [
                      {
                        phaseRunId,
                        threadId: defaultThreadId,
                        workflowId,
                        phaseId,
                        phaseName: "implement",
                        phaseType: "single-agent" as const,
                        sandboxMode: "workspace-write" as const,
                        iteration: 1,
                        status: "completed" as const,
                        gateResult: null,
                        qualityChecks: null,
                        deliberationState: null,
                        startedAt: now,
                        completedAt: now,
                      },
                    ]
                  : [],
              ),
            queryById: ({ phaseRunId: requestedPhaseRunId }) =>
              Effect.succeed(
                requestedPhaseRunId === phaseRunId
                  ? Option.some({
                      phaseRunId,
                      threadId: defaultThreadId,
                      workflowId,
                      phaseId,
                      phaseName: "implement",
                      phaseType: "single-agent" as const,
                      sandboxMode: "workspace-write" as const,
                      iteration: 1,
                      status: "completed" as const,
                      gateResult: null,
                      qualityChecks: null,
                      deliberationState: null,
                      startedAt: now,
                      completedAt: now,
                    })
                  : Option.none(),
              ),
          },
          projectionPhaseOutputRepository: {
            queryByKey: ({ phaseRunId: requestedPhaseRunId, outputKey }) =>
              Effect.succeed(
                requestedPhaseRunId === phaseRunId && outputKey === "output"
                  ? Option.some({
                      phaseRunId,
                      outputKey: "output",
                      content: "phase output",
                      sourceType: "conversation",
                      sourceId: null,
                      metadata: null,
                      createdAt: now,
                      updatedAt: now,
                    })
                  : Option.none(),
              ),
          },
          projectionThreadRepository: {
            getById: ({ threadId }) =>
              Effect.succeed(
                threadId === defaultThreadId
                  ? Option.some({
                      threadId: defaultThreadId,
                      projectId: defaultProjectId,
                      title: "Default Thread",
                      modelSelection: defaultModelSelection,
                      runtimeMode: "full-access" as const,
                      interactionMode: "default" as const,
                      branch: "main",
                      worktreePath: null,
                      latestTurnId: null,
                      createdAt: now,
                      updatedAt: now,
                      archivedAt: null,
                      deletedAt: null,
                      parentThreadId: null,
                      phaseRunId: null,
                      workflowId: null,
                      workflowSnapshot: null,
                      currentPhaseId: null,
                      patternId: null,
                      role: null,
                      deliberationState: null,
                      bootstrapStatus: null,
                      completedAt: null,
                      transcriptArchived: false,
                    })
                  : Option.none(),
              ),
            listByProjectId: () =>
              Effect.succeed([
                {
                  threadId: defaultThreadId,
                  projectId: defaultProjectId,
                  title: "Default Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access" as const,
                  interactionMode: "default" as const,
                  branch: "main",
                  worktreePath: null,
                  latestTurnId: null,
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: null,
                  deletedAt: null,
                  parentThreadId: null,
                  phaseRunId: null,
                  workflowId: null,
                  workflowSnapshot: null,
                  currentPhaseId: null,
                  patternId: null,
                  role: null,
                  deliberationState: null,
                  bootstrapStatus: null,
                  completedAt: null,
                  transcriptArchived: false,
                },
                {
                  threadId: childThreadId,
                  projectId: defaultProjectId,
                  title: "Child Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "approval-required" as const,
                  interactionMode: "default" as const,
                  branch: null,
                  worktreePath: null,
                  latestTurnId: null,
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: null,
                  deletedAt: null,
                  parentThreadId: defaultThreadId,
                  phaseRunId,
                  workflowId: workflowId,
                  workflowSnapshot: null,
                  currentPhaseId: phaseId,
                  patternId: null,
                  role: "reviewer",
                  deliberationState: null,
                  bootstrapStatus: "completed",
                  completedAt: null,
                  transcriptArchived: false,
                },
              ]),
          },
          projectionThreadMessageRepository: {
            listByThreadId: ({ threadId }) =>
              Effect.succeed(
                threadId === defaultThreadId
                  ? [
                      {
                        messageId: "message-1" as any,
                        threadId: defaultThreadId,
                        turnId: null,
                        role: "assistant" as const,
                        text: "transcript entry",
                        attachments: undefined,
                        isStreaming: false,
                        createdAt: now,
                        updatedAt: now,
                      },
                    ]
                  : [],
              ),
          },
          projectionThreadSessionRepository: {
            getByThreadId: ({ threadId }) =>
              Effect.succeed(
                threadId === childThreadId
                  ? Option.some({
                      threadId: childThreadId,
                      status: "running" as const,
                      providerName: "codex",
                      runtimeMode: "approval-required" as const,
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    })
                  : Option.none(),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const workflowList = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.workflowList]({})),
      );
      assert.equal(workflowList.workflows[0]?.workflowId, workflowId);

      const workflowGet = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.workflowGet]({ workflowId })),
      );
      assert.equal(workflowGet.workflow.name, "Query Workflow");

      const created = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.workflowCreate]({ workflow })),
      );
      assert.equal(created.workflow.builtIn, false);

      const updated = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.workflowUpdate]({ workflow })),
      );
      assert.equal(updated.workflow.id, workflowId);
      assert.equal(upsertedWorkflows.length, 2);

      const transcript = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.sessionGetTranscript]({ sessionId: defaultThreadId }),
        ),
      );
      assert.equal(transcript.entries[0]?.text, "transcript entry");

      const children = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.sessionGetChildren]({ sessionId: defaultThreadId }),
        ),
      );
      assert.equal(children.children[0]?.threadId, childThreadId);

      const channelMessages = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.channelGetMessages]({ channelId })),
      );
      assert.equal(channelMessages.messages[0]?.content, "channel content");

      const channel = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.channelGetChannel]({ channelId })),
      );
      assert.equal(channel.channel.id, channelId);

      const phaseRunList = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.phaseRunList]({ threadId: defaultThreadId }),
        ),
      );
      assert.equal(phaseRunList.phaseRuns[0]?.phaseRunId, phaseRunId);

      const phaseRun = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.phaseRunGet]({ phaseRunId })),
      );
      assert.equal(phaseRun.phaseRun.phaseName, "implement");

      const phaseOutput = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.phaseOutputGet]({ phaseRunId, outputKey: "output" }),
        ),
      );
      assert.equal(phaseOutput.output.content, "phase output");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc channel-specific workflow and channel push subscriptions", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe("thread-push");
      const channelId = ChannelId.makeUnsafe("channel-push");
      const phaseRunId = PhaseRunId.makeUnsafe("phase-run-push");
      const phaseId = WorkflowPhaseId.makeUnsafe("phase-push");
      const messageId = ChannelMessageId.makeUnsafe("channel-message-push");

      const workflowPhaseEvent = {
        sequence: 2,
        eventId: "event-2",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.phase-started",
        payload: {
          threadId,
          phaseRunId,
          phaseId,
          phaseName: "Implement",
          phaseType: "single-agent",
          iteration: 1,
          startedAt: now,
        },
      } as unknown as OrchestrationEvent;
      const workflowQualityEvent = {
        sequence: 3,
        eventId: "event-3",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.quality-check-started",
        payload: {
          threadId,
          phaseRunId,
          checks: [{ check: "typecheck", required: true }],
          startedAt: now,
        },
      } as unknown as OrchestrationEvent;
      const workflowBootstrapEvent = {
        sequence: 4,
        eventId: "event-4",
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.bootstrap-started",
        payload: {
          threadId,
          startedAt: now,
        },
      } as unknown as OrchestrationEvent;
      const workflowGateEvent = {
        sequence: 5,
        eventId: "event-5",
        aggregateKind: "request",
        aggregateId: "request-push",
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "request.opened",
        payload: {
          requestId: "request-push",
          threadId,
          childThreadId: null,
          phaseRunId,
          requestType: "gate",
          payload: {
            type: "gate",
            gateType: "human-approval",
            phaseRunId,
          },
          createdAt: now,
        },
      } as unknown as OrchestrationEvent;
      const channelCreatedEvent = {
        sequence: 6,
        eventId: "event-6",
        aggregateKind: "channel",
        aggregateId: channelId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "channel.created",
        payload: {
          channelId,
          threadId,
          channelType: "deliberation",
          phaseRunId: null,
          createdAt: now,
        },
      } as unknown as OrchestrationEvent;
      const channelMessageEvent = {
        sequence: 7,
        eventId: "event-7",
        aggregateKind: "channel",
        aggregateId: channelId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "channel.message-posted",
        payload: {
          channelId,
          messageId,
          sequence: 1,
          fromType: "agent",
          fromId: ThreadId.makeUnsafe("thread-participant"),
          fromRole: "reviewer",
          content: "event payload",
          createdAt: now,
        },
      } as unknown as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () =>
              Effect.succeed({
                ...makeDefaultOrchestrationReadModel(),
                snapshotSequence: 1,
              }),
            readEvents: () =>
              Stream.make(
                workflowPhaseEvent,
                workflowQualityEvent,
                workflowBootstrapEvent,
                workflowGateEvent,
                channelCreatedEvent,
                channelMessageEvent,
              ),
            streamDomainEvents: Stream.empty,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const phaseEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeWorkflowPhase]({ threadId }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      assert.equal(Array.from(phaseEvents)[0]?.channel, "workflow.phase");

      const qualityEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeWorkflowQualityChecks]({ threadId }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      assert.equal(Array.from(qualityEvents)[0]?.channel, "workflow.quality-check");

      const bootstrapEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeWorkflowBootstrap]({ threadId }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      assert.equal(Array.from(bootstrapEvents)[0]?.channel, "workflow.bootstrap");

      const gateEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeWorkflowGate]({ threadId }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      assert.equal(Array.from(gateEvents)[0]?.channel, "workflow.gate");

      const channelEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeChannelMessage]({ channelId }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      assert.equal(Array.from(channelEvents)[0]?.channel, "channel.message");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration.getSnapshot errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "ProjectionSnapshotQuery.getSnapshot",
                  detail: "projection unavailable",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})).pipe(
          Effect.result,
        ),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationGetSnapshotError");
      assertInclude(result.failure.message, "Failed to load orchestration snapshot");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
