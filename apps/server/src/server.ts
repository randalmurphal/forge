import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import { ServerConfig } from "./config";
import { attachmentsRouteLayer, projectFaviconRouteLayer, staticAndDevRouteLayer } from "./http";
import { fixPath } from "./os-jank";
import { websocketRpcRouteLayer } from "./ws";
import { OpenLive } from "./open";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { ProjectionChannelMessageRepositoryLive } from "./persistence/Layers/ProjectionChannelMessages";
import { ProjectionChannelReadRepositoryLive } from "./persistence/Layers/ProjectionChannelReads";
import { ProjectionChannelRepositoryLive } from "./persistence/Layers/ProjectionChannels";
import { ProjectionInteractiveRequestRepositoryLive } from "./persistence/Layers/ProjectionInteractiveRequests";
import { ProjectionPhaseOutputRepositoryLive } from "./persistence/Layers/ProjectionPhaseOutputs";
import { ProjectionPhaseRunRepositoryLive } from "./persistence/Layers/ProjectionPhaseRuns";
import { ProjectionProjectRepositoryLive } from "./persistence/Layers/ProjectionProjects";
import { ProjectionThreadMessageRepositoryLive } from "./persistence/Layers/ProjectionThreadMessages";
import { ProjectionThreadRepositoryLive } from "./persistence/Layers/ProjectionThreads";
import { ProjectionThreadSessionRepositoryLive } from "./persistence/Layers/ProjectionThreadSessions";
import { ProjectionWorkflowRepositoryLive } from "./persistence/Layers/ProjectionWorkflows";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { RoutingTextGenerationLive } from "./git/Layers/RoutingTextGeneration";
import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { GitManagerLive } from "./git/Layers/GitManager";
import { KeybindingsLive } from "./keybindings";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { BootstrapReactorLive } from "./orchestration/Layers/BootstrapReactor";
import { ChannelReactorLive } from "./orchestration/Layers/ChannelReactor";
import { WorkflowReactorLive } from "./orchestration/Layers/WorkflowReactor";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry";
import { ServerSettingsLive } from "./serverSettings";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths";
import { ObservabilityLive } from "./observability/Layers/Observability";
import { ChannelServiceLive } from "./channel/Layers/ChannelService";
import { DeliberationEngineLive } from "./channel/Layers/DeliberationEngine";
import { PromptResolverLive } from "./workflow/Layers/PromptResolver";
import { QualityCheckRunnerLive } from "./workflow/Layers/QualityCheckRunner";
import { WorkflowEngineLive } from "./workflow/Layers/WorkflowEngine";
import { WorkflowRegistryLive } from "./workflow/Layers/WorkflowRegistry";

const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const BunPTY = yield* Effect.promise(() => import("./terminal/Layers/BunPTY"));
      return BunPTY.layer;
    } else {
      const NodePTY = yield* Effect.promise(() => import("./terminal/Layers/NodePTY"));
      return NodePTY.layer;
    }
  }),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        ...(config.host ? { hostname: config.host } : {}),
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(NodeHttp.createServer, {
        host: config.host,
        port: config.port,
      });
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
);

const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
);

const ProviderLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    return makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(AnalyticsServiceLayerLive),
      Layer.provide(ServerSettingsLive),
    );
  }),
);

const PersistenceLayerLive = SqlitePersistenceLayerLive;

const ProjectionRepositoriesLayerLive = Layer.mergeAll(
  ProjectionProjectRepositoryLive,
  ProjectionThreadRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
  ProjectionThreadSessionRepositoryLive,
  ProjectionWorkflowRepositoryLive,
  ProjectionPhaseRunRepositoryLive,
  ProjectionPhaseOutputRepositoryLive,
  ProjectionChannelRepositoryLive,
  ProjectionChannelMessageRepositoryLive,
  ProjectionChannelReadRepositoryLive,
  ProjectionInteractiveRequestRepositoryLive,
  ProviderSessionRuntimeRepositoryLive,
);

const ProjectionRepositoriesRuntimeLive = ProjectionRepositoriesLayerLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

const RoutingTextGenerationRuntimeLive = RoutingTextGenerationLive.pipe(
  Layer.provide(ServerSettingsLive),
);

const GitLayerLive = Layer.mergeAll(
  GitManagerLive.pipe(
    Layer.provide(GitCoreLive),
    Layer.provide(GitHubCliLive),
    Layer.provide(RoutingTextGenerationRuntimeLive),
    Layer.provide(ServerSettingsLive),
  ),
  GitCoreLive,
  RoutingTextGenerationRuntimeLive,
);

const TerminalLayerLive = TerminalManagerLive.pipe(Layer.provide(PtyAdapterLive));

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive)),
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  ),
);

const OrchestrationRuntimeLive = OrchestrationLayerLive.pipe(Layer.provide(PersistenceLayerLive));

const CheckpointStoreRuntimeLive = CheckpointStoreLive.pipe(Layer.provide(GitCoreLive));

const CheckpointDiffQueryRuntimeLive = CheckpointDiffQueryLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(CheckpointStoreRuntimeLive),
);

const CheckpointingLayerLive = Layer.mergeAll(
  CheckpointStoreRuntimeLive,
  CheckpointDiffQueryRuntimeLive,
);

const ProviderRuntimeIngestionRuntimeLive = ProviderRuntimeIngestionLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(ProviderLayerLive),
  Layer.provide(ServerSettingsLive),
);

const ProviderCommandReactorRuntimeLive = ProviderCommandReactorLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(ProviderLayerLive),
  Layer.provide(GitCoreLive),
  Layer.provide(RoutingTextGenerationRuntimeLive),
  Layer.provide(ServerSettingsLive),
);

const CheckpointReactorRuntimeLive = CheckpointReactorLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(ProviderLayerLive),
  Layer.provide(CheckpointStoreRuntimeLive),
  Layer.provide(RuntimeReceiptBusLive),
  Layer.provide(WorkspaceLayerLive),
);

const WorkflowRegistryRuntimeLive = WorkflowRegistryLive.pipe(
  Layer.provide(ProjectionRepositoriesRuntimeLive),
);

const WorkflowEngineRuntimeLive = WorkflowEngineLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(ProjectionRepositoriesRuntimeLive),
  Layer.provide(WorkflowRegistryRuntimeLive),
  Layer.provide(QualityCheckRunnerLive),
);

const ChannelServiceRuntimeLive = ChannelServiceLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(ProjectionRepositoriesRuntimeLive),
);

const DeliberationEngineRuntimeLive = DeliberationEngineLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(ProjectionRepositoriesRuntimeLive),
);

const BootstrapReactorRuntimeLive = BootstrapReactorLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(ProjectionRepositoriesRuntimeLive),
  Layer.provide(GitCoreLive),
);

const WorkflowReactorRuntimeLive = WorkflowReactorLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(WorkflowEngineRuntimeLive),
  Layer.provide(ProjectionRepositoriesRuntimeLive),
  Layer.provide(WorkflowRegistryRuntimeLive),
);

const ChannelReactorRuntimeLive = ChannelReactorLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(ChannelServiceRuntimeLive),
  Layer.provide(DeliberationEngineRuntimeLive),
);

const OrchestrationReactorRuntimeLive = OrchestrationReactorLive.pipe(
  Layer.provide(ProviderRuntimeIngestionRuntimeLive),
  Layer.provide(ProviderCommandReactorRuntimeLive),
  Layer.provide(CheckpointReactorRuntimeLive),
  Layer.provide(BootstrapReactorRuntimeLive),
  Layer.provide(WorkflowReactorRuntimeLive),
  Layer.provide(ChannelReactorRuntimeLive),
);

const ServerRuntimeStartupRuntimeLive = ServerRuntimeStartupLive.pipe(
  Layer.provide(OrchestrationRuntimeLive),
  Layer.provide(KeybindingsLive),
  Layer.provide(ServerSettingsLive),
  Layer.provide(AnalyticsServiceLayerLive),
  Layer.provide(OpenLive),
  Layer.provide(ServerLifecycleEventsLive),
  Layer.provide(OrchestrationReactorRuntimeLive),
);

const WorkflowLayerLive = Layer.mergeAll(
  WorkflowRegistryRuntimeLive,
  PromptResolverLive,
  QualityCheckRunnerLive,
  WorkflowEngineRuntimeLive,
);

const ChannelLayerLive = Layer.mergeAll(ChannelServiceRuntimeLive, DeliberationEngineRuntimeLive);

const ReactorLayerLive = OrchestrationReactorRuntimeLive;

const RuntimeServicesLive = Layer.mergeAll(
  ProjectionRepositoriesRuntimeLive,
  OrchestrationRuntimeLive,
  CheckpointingLayerLive,
  GitLayerLive,
  ProviderLayerLive,
  TerminalLayerLive,
  KeybindingsLive,
  ProviderRegistryLive,
  WorkspaceLayerLive,
  ProjectFaviconResolverLive,
  WorkflowLayerLive,
  ChannelLayerLive,
  ReactorLayerLive,
  ServerRuntimeStartupRuntimeLive,
  OpenLive,
  ServerLifecycleEventsLive,
);

export const makeRoutesLayer = Layer.mergeAll(
  attachmentsRouteLayer,
  projectFaviconRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer,
);

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }),
      httpListeningLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(ServerSettingsLive),
      Layer.provideMerge(PersistenceLayerLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = Layer.launch(makeServerLayer) satisfies Effect.Effect<
  never,
  any,
  ServerConfig
>;
