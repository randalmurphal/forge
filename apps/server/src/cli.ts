import * as Crypto from "node:crypto";

import type { ModelSelection, SessionSummary } from "@forgetools/contracts";
import { NetService } from "@forgetools/shared/Net";
import { parsePersistedServerObservabilitySettings } from "@forgetools/shared/serverSettings";
import { Config, Console, Effect, FileSystem, LogLevel, Option, Path, Schema } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  ServerConfig,
  RuntimeMode,
  type ServerConfigShape,
} from "./config";
import { readBootstrapEnvelope } from "./bootstrap";
import { resolveBaseDir } from "./os-jank";
import { runServer } from "./server";
import {
  buildDaemonLaunchPlan,
  cleanEmptyWorktrees,
  type CliDaemonPaths,
  type DaemonStatusSnapshot,
  ForgeDaemonCliError,
  getDaemonStatusSnapshot,
  launchDaemonProcess,
  resolveCliDaemonPaths,
  sendDaemonRpc,
  waitForDaemonReady,
  waitForDaemonStopped,
} from "./daemon/cliClient";

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const BootstrapEnvelopeSchema = Schema.Struct({
  mode: Schema.optional(RuntimeMode),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  forgeHome: Schema.optional(Schema.String),
  devUrl: Schema.optional(Schema.URLFromString),
  noBrowser: Schema.optional(Schema.Boolean),
  authToken: Schema.optional(Schema.String),
  autoBootstrapProjectFromCwd: Schema.optional(Schema.Boolean),
  logWebSocketEvents: Schema.optional(Schema.Boolean),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});

const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to FORGE_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for WebSocket connections."),
  Flag.withAlias("token"),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to FORGE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("FORGE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.logLevel("FORGE_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.boolean("FORGE_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: Config.string("FORGE_TRACE_FILE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceMaxBytes: Config.int("FORGE_TRACE_MAX_BYTES").pipe(Config.withDefault(10 * 1024 * 1024)),
  traceMaxFiles: Config.int("FORGE_TRACE_MAX_FILES").pipe(Config.withDefault(10)),
  traceBatchWindowMs: Config.int("FORGE_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(200)),
  otlpTracesUrl: Config.string("FORGE_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.string("FORGE_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: Config.int("FORGE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpServiceName: Config.string("FORGE_OTLP_SERVICE_NAME").pipe(
    Config.withDefault("forge-server"),
  ),
  mode: Config.schema(RuntimeMode, "FORGE_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.port("FORGE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("FORGE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  forgeHome: Config.string("FORGE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("FORGE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  authToken: Config.string("FORGE_AUTH_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.int("FORGE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("FORGE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("FORGE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly authToken: Option.Option<string>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
        : Option.none();

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        flags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.mode)),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        flags.port,
        Option.fromUndefinedOr(env.port),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.port)),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(
        flags.devUrl,
        Option.fromUndefinedOr(env.devUrl),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.devUrl)),
      ),
      () => undefined,
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          flags.baseDir,
          Option.fromUndefinedOr(env.forgeHome),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.forgeHome),
          ),
        ),
      ),
    );
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const noBrowser = resolveBooleanFlag(
      flags.noBrowser,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.noBrowser),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.noBrowser),
          ),
        ),
        () => mode === "desktop" || mode === "daemon",
      ),
    );
    const authToken =
      Option.getOrUndefined(
        resolveOptionPrecedence(
          flags.authToken,
          Option.fromUndefinedOr(env.authToken),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.authToken),
          ),
        ),
      ) ?? (mode === "daemon" ? Crypto.randomBytes(32).toString("hex") : undefined);
    const autoBootstrapProjectFromCwd = resolveBooleanFlag(
      flags.autoBootstrapProjectFromCwd,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.autoBootstrapProjectFromCwd),
          ),
        ),
        () => mode === "web",
      ),
    );
    const logWebSocketEvents = resolveBooleanFlag(
      flags.logWebSocketEvents,
      Option.getOrElse(
        resolveOptionPrecedence(
          Option.fromUndefinedOr(env.logWebSocketEvents),
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.logWebSocketEvents),
          ),
        ),
        () => Boolean(devUrl),
      ),
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        flags.host,
        Option.fromUndefinedOr(env.host),
        Option.flatMap(bootstrapEnvelope, (bootstrap) => Option.fromUndefinedOr(bootstrap.host)),
      ),
      () => (mode === "desktop" || mode === "daemon" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const config: ServerConfigShape = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl:
        env.otlpTracesUrl ??
        Option.getOrUndefined(
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.otlpTracesUrl),
          ),
        ) ??
        persistedObservabilitySettings.otlpTracesUrl,
      otlpMetricsUrl:
        env.otlpMetricsUrl ??
        Option.getOrUndefined(
          Option.flatMap(bootstrapEnvelope, (bootstrap) =>
            Option.fromUndefinedOr(bootstrap.otlpMetricsUrl),
          ),
        ) ??
        persistedObservabilitySettings.otlpMetricsUrl,
      otlpExportIntervalMs: env.otlpExportIntervalMs,
      otlpServiceName: env.otlpServiceName,
      mode,
      port,
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      noBrowser,
      authToken,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
    };

    return config;
  });

const commandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

interface CliDaemonFlags {
  readonly baseDir: Option.Option<string>;
}

const cliDaemonFlags = {
  baseDir: baseDirFlag,
} as const;

const modelFlag = Flag.string("model").pipe(
  Flag.withDescription(
    "Provider/model selector in the form `codex:gpt-5-codex` or `claude:claude-sonnet-4-5`.",
  ),
  Flag.optional,
);

const phaseRunIdFlag = Flag.string("phase-run-id").pipe(
  Flag.withDescription("Explicit phase run id when a session has multiple pending gates."),
  Flag.optional,
);

const renderSessionLine = (session: SessionSummary) =>
  [
    session.threadId,
    session.status.padEnd(15, " "),
    (session.sessionType ?? "agent").padEnd(8, " "),
    session.title,
  ].join("  ");

const renderSessionDetails = (session: SessionSummary) =>
  [
    `Session: ${session.threadId}`,
    `Title: ${session.title}`,
    `Status: ${session.status}`,
    `Type: ${session.sessionType}`,
    `Provider: ${session.provider ?? "-"}`,
    `Model: ${session.model?.model ?? "-"}`,
    `Project: ${session.projectId}`,
    `Workflow: ${session.workflowId ?? "-"}`,
    `Phase: ${session.currentPhaseId ?? "-"}`,
    `Branch: ${session.branch ?? "-"}`,
    `Children: ${session.childThreadIds.length}`,
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`,
  ].join("\n");

const renderDaemonStatus = (
  status: DaemonStatusSnapshot,
  sessions: ReadonlyArray<SessionSummary>,
) => {
  const runningCount = sessions.filter((session) => session.status === "running").length;
  const attentionCount = sessions.filter((session) => session.status === "needs-attention").length;
  return [
    `Daemon: ${status.running ? "running" : "stopped"}`,
    `Base dir: ${status.paths.baseDir}`,
    `Socket: ${status.paths.socketPath}`,
    `PID: ${status.info?.pid ?? "-"}`,
    `WebSocket port: ${status.info?.wsPort ?? "-"}`,
    `Started: ${status.info?.startedAt ?? "-"}`,
    `Uptime ms: ${status.ping?.uptime ?? "-"}`,
    `Sessions: ${sessions.length}`,
    `Running sessions: ${runningCount}`,
    `Needs attention: ${attentionCount}`,
  ].join("\n");
};

const resolveCliPathsFromInput = (input: CliDaemonFlags) =>
  resolveCliDaemonPaths(Option.getOrUndefined(input.baseDir));

const loadDaemonSessions = (paths: CliDaemonPaths) =>
  sendDaemonRpc<ReadonlyArray<SessionSummary>>({
    socketPath: paths.socketPath,
    method: "session.list",
  });

const queueSummary = (label: string, result: unknown) => {
  const sequence =
    typeof result === "object" && result !== null && "sequence" in result
      ? (result as { readonly sequence?: unknown }).sequence
      : undefined;
  return sequence === undefined ? `${label}.` : `${label} Receipt sequence=${String(sequence)}.`;
};

const normalizeModelProvider = (provider: string): ModelSelection["provider"] | undefined => {
  switch (provider.trim().toLowerCase()) {
    case "codex":
      return "codex";
    case "claude":
    case "claudeagent":
    case "claude-agent":
      return "claudeAgent";
    default:
      return undefined;
  }
};

const parseCliModelSelection = (
  rawModel: string,
): Effect.Effect<ModelSelection, ForgeDaemonCliError> =>
  Effect.sync(() => {
    const separatorIndex = rawModel.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === rawModel.length - 1) {
      throw new ForgeDaemonCliError({
        message:
          "Invalid --model value. Expected `provider:model`, for example `codex:gpt-5-codex` or `claude:claude-sonnet-4-5`.",
      });
    }

    const provider = normalizeModelProvider(rawModel.slice(0, separatorIndex));
    const model = rawModel.slice(separatorIndex + 1).trim();
    if (provider === undefined || model.length === 0) {
      throw new ForgeDaemonCliError({
        message:
          "Invalid --model value. Expected `provider:model`, for example `codex:gpt-5-codex` or `claude:claude-sonnet-4-5`.",
      });
    }

    return {
      provider,
      model,
    } satisfies ModelSelection;
  });

const startDaemonFromCli = (paths: CliDaemonPaths) =>
  Effect.gen(function* () {
    const status = yield* getDaemonStatusSnapshot(paths);
    if (status.running) {
      const sessions = yield* loadDaemonSessions(paths);
      yield* Console.log(renderDaemonStatus(status, sessions));
      return;
    }

    const launchPlan = buildDaemonLaunchPlan({ baseDir: paths.baseDir });
    if (launchPlan instanceof ForgeDaemonCliError) {
      return yield* launchPlan;
    }
    const child = yield* launchDaemonProcess(launchPlan);
    const childExit = Effect.promise(
      () =>
        new Promise<{
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
        }>((resolve) => {
          child.once("exit", (code, signal) => resolve({ code, signal }));
        }),
    );

    const outcome = yield* waitForDaemonReady(paths).pipe(
      Effect.map((readyStatus) => ({ type: "ready" as const, readyStatus })),
      Effect.raceFirst(childExit.pipe(Effect.map((exit) => ({ type: "exit" as const, exit })))),
      Effect.timeoutOption("1500 millis"),
    );

    if (Option.isNone(outcome)) {
      yield* Console.log(`Daemon launch requested. PID=${child.pid ?? "unknown"}.`);
      return;
    }
    if (outcome.value.type === "exit") {
      return yield* new ForgeDaemonCliError({
        message: `Forge daemon exited before becoming ready (code=${outcome.value.exit.code ?? "null"}, signal=${outcome.value.exit.signal ?? "null"}).`,
      });
    }
    if (outcome.value.readyStatus === undefined) {
      yield* Console.log(`Daemon launch requested. PID=${child.pid ?? "unknown"}.`);
      return;
    }
    const sessions = yield* loadDaemonSessions(paths);
    yield* Console.log(renderDaemonStatus(outcome.value.readyStatus, sessions));
  });

const restartDaemonFromCli = (paths: CliDaemonPaths) =>
  Effect.gen(function* () {
    const status = yield* getDaemonStatusSnapshot(paths);
    if (status.running) {
      yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "daemon.stop",
      });
      const stopped = yield* waitForDaemonStopped(paths);
      if (!stopped) {
        return yield* new ForgeDaemonCliError({
          message: `Forge daemon did not stop within 5000ms at ${paths.socketPath}.`,
        });
      }
    }

    yield* startDaemonFromCli(paths);
  });

const rootCommand = Command.make("forge", commandFlags).pipe(
  Command.withDescription("Run the Forge server or talk to the Forge daemon."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
    }),
  ),
);

const listCommand = Command.make("list", cliDaemonFlags).pipe(
  Command.withDescription("List sessions from the running Forge daemon."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const sessions = yield* loadDaemonSessions(paths);
      if (sessions.length === 0) {
        yield* Console.log("No sessions.");
        return;
      }
      yield* Console.log(sessions.map(renderSessionLine).join("\n"));
    }),
  ),
);

const statusCommand = Command.make("status", {
  ...cliDaemonFlags,
  sessionId: Argument.string("session-id").pipe(Argument.optional),
}).pipe(
  Command.withDescription("Show daemon status or a detailed session status."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);

      if (Option.isNone(input.sessionId)) {
        const status = yield* getDaemonStatusSnapshot(paths);
        const sessions = status.running ? yield* loadDaemonSessions(paths) : [];
        yield* Console.log(renderDaemonStatus(status, sessions));
        return;
      }

      const session = yield* sendDaemonRpc<SessionSummary>({
        socketPath: paths.socketPath,
        method: "session.get",
        params: {
          sessionId: input.sessionId.value,
        },
      });
      yield* Console.log(renderSessionDetails(session));
    }),
  ),
);

const createCommand = Command.make("create", {
  ...cliDaemonFlags,
  title: Argument.string("title"),
  workflow: Flag.string("workflow").pipe(Flag.optional),
  project: Flag.string("project").pipe(Flag.withDescription("Project path.")),
  model: modelFlag,
}).pipe(
  Command.withDescription("Create a new session through the daemon socket API."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const path = yield* Path.Path;
      const model = Option.isSome(input.model)
        ? yield* parseCliModelSelection(input.model.value)
        : undefined;
      const result = yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "session.create",
        params: {
          title: input.title,
          ...(Option.isSome(input.workflow) ? { workflow: input.workflow.value } : {}),
          projectPath: path.resolve(input.project),
          ...(model === undefined ? {} : { model }),
        },
      });
      yield* Console.log(queueSummary(`Queued session.create for '${input.title}'`, result));
    }),
  ),
);

const correctCommand = Command.make("correct", {
  ...cliDaemonFlags,
  sessionId: Argument.string("session-id"),
  message: Argument.string("message"),
}).pipe(
  Command.withDescription("Send a correction to a session."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const result = yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "session.correct",
        params: {
          sessionId: input.sessionId,
          content: input.message,
        },
      });
      yield* Console.log(queueSummary(`Queued correction for ${input.sessionId}`, result));
    }),
  ),
);

const approveCommand = Command.make("approve", {
  ...cliDaemonFlags,
  sessionId: Argument.string("session-id"),
  phaseRunId: phaseRunIdFlag,
}).pipe(
  Command.withDescription("Approve the current pending gate for a session."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const result = yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "gate.approve",
        params: {
          sessionId: input.sessionId,
          ...(Option.isSome(input.phaseRunId) ? { phaseRunId: input.phaseRunId.value } : {}),
        },
      });
      yield* Console.log(queueSummary(`Queued gate approval for ${input.sessionId}`, result));
    }),
  ),
);

const rejectCommand = Command.make("reject", {
  ...cliDaemonFlags,
  sessionId: Argument.string("session-id"),
  reason: Argument.string("reason").pipe(Argument.optional),
  phaseRunId: phaseRunIdFlag,
}).pipe(
  Command.withDescription("Reject the current pending gate for a session."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const result = yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "gate.reject",
        params: {
          sessionId: input.sessionId,
          ...(Option.isSome(input.reason) ? { reason: input.reason.value } : {}),
          ...(Option.isSome(input.phaseRunId) ? { phaseRunId: input.phaseRunId.value } : {}),
        },
      });
      yield* Console.log(queueSummary(`Queued gate rejection for ${input.sessionId}`, result));
    }),
  ),
);

const interveneCommand = Command.make("intervene", {
  ...cliDaemonFlags,
  channelId: Argument.string("channel-id"),
  message: Argument.string("message"),
  fromRole: Flag.string("role").pipe(
    Flag.withDescription("Optional human role label for the channel intervention."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Post a human intervention message to a channel."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const result = yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "channel.intervene",
        params: {
          channelId: input.channelId,
          content: input.message,
          ...(Option.isSome(input.fromRole) ? { fromRole: input.fromRole.value } : {}),
        },
      });
      yield* Console.log(
        queueSummary(`Queued channel intervention for ${input.channelId}`, result),
      );
    }),
  ),
);

const pauseCommand = Command.make("pause", {
  ...cliDaemonFlags,
  sessionId: Argument.string("session-id"),
}).pipe(
  Command.withDescription("Pause a running session."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const result = yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "session.pause",
        params: { sessionId: input.sessionId },
      });
      yield* Console.log(queueSummary(`Queued pause for ${input.sessionId}`, result));
    }),
  ),
);

const resumeCommand = Command.make("resume", {
  ...cliDaemonFlags,
  sessionId: Argument.string("session-id"),
}).pipe(
  Command.withDescription("Resume a paused session."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const result = yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "session.resume",
        params: { sessionId: input.sessionId },
      });
      yield* Console.log(queueSummary(`Queued resume for ${input.sessionId}`, result));
    }),
  ),
);

const cancelCommand = Command.make("cancel", {
  ...cliDaemonFlags,
  sessionId: Argument.string("session-id"),
  reason: Flag.string("reason").pipe(Flag.optional),
}).pipe(
  Command.withDescription("Cancel a session."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const result = yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "session.cancel",
        params: {
          sessionId: input.sessionId,
          ...(Option.isSome(input.reason) ? { reason: input.reason.value } : {}),
        },
      });
      yield* Console.log(queueSummary(`Queued cancel for ${input.sessionId}`, result));
    }),
  ),
);

const answerCommand = Command.make("answer", {
  ...cliDaemonFlags,
  requestId: Argument.string("request-id"),
  input: Flag.string("input"),
}).pipe(
  Command.withDescription("Resolve a pending interactive request with text input."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const result = yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "request.resolve",
        params: {
          requestId: input.requestId,
          resolvedWith: {
            answers: {
              input: input.input,
            },
          },
        },
      });
      yield* Console.log(queueSummary(`Queued request.resolve for ${input.requestId}`, result));
    }),
  ),
);

const cleanupCommand = Command.make("cleanup", cliDaemonFlags).pipe(
  Command.withDescription("Remove empty directories under ~/.forge/worktrees."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const removed = yield* cleanEmptyWorktrees(paths.worktreesDir);
      yield* Console.log(
        removed.length === 0
          ? "No empty Forge worktree directories removed."
          : `Removed empty Forge worktree directories: ${removed.join(", ")}`,
      );
    }),
  ),
);

const daemonStatusCommand = Command.make("status", cliDaemonFlags).pipe(
  Command.withDescription("Show daemon runtime status."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const status = yield* getDaemonStatusSnapshot(paths);
      const sessions = status.running ? yield* loadDaemonSessions(paths) : [];
      yield* Console.log(renderDaemonStatus(status, sessions));
    }),
  ),
);

const daemonStopCommand = Command.make("stop", cliDaemonFlags).pipe(
  Command.withDescription("Stop the running daemon gracefully."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      const status = yield* getDaemonStatusSnapshot(paths);
      if (!status.running) {
        yield* Console.log("Forge daemon is already stopped.");
        return;
      }
      yield* sendDaemonRpc({
        socketPath: paths.socketPath,
        method: "daemon.stop",
      });
      yield* Console.log("Queued daemon stop.");
    }),
  ),
);

const daemonStartCommand = Command.make("start", cliDaemonFlags).pipe(
  Command.withDescription("Launch the daemon as a detached background process."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      yield* startDaemonFromCli(paths);
    }),
  ),
);

const daemonRestartCommand = Command.make("restart", cliDaemonFlags).pipe(
  Command.withDescription("Restart the daemon after waiting for graceful shutdown."),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const paths = yield* resolveCliPathsFromInput(input);
      yield* restartDaemonFromCli(paths);
    }),
  ),
);

const daemonCommand = Command.make("daemon").pipe(
  Command.withDescription("Manage the background Forge daemon."),
  Command.withSubcommands([
    daemonStartCommand,
    daemonStopCommand,
    daemonStatusCommand,
    daemonRestartCommand,
  ]),
);

export const cli = rootCommand.pipe(
  Command.withSubcommands([
    listCommand,
    statusCommand,
    createCommand,
    correctCommand,
    approveCommand,
    rejectCommand,
    interveneCommand,
    pauseCommand,
    resumeCommand,
    cancelCommand,
    answerCommand,
    cleanupCommand,
    daemonCommand,
  ]),
);
