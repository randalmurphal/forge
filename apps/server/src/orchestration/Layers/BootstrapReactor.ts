import { exec, type ExecException } from "node:child_process";

import {
  CommandId,
  type ForgeCommand,
  type ForgeEvent,
  ForgeProjectConfig,
  InteractiveRequestId,
  type ThreadId,
} from "@forgetools/contracts";
import { makeDrainableWorker } from "@forgetools/shared/DrainableWorker";
import { resolveThreadSpawnMode } from "@forgetools/shared/threadWorkspace";
import {
  Cause,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  SchemaIssue,
  Stream,
} from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProjectionInteractiveRequestRepository } from "../../persistence/Services/ProjectionInteractiveRequests.ts";
import { BootstrapReactor, type BootstrapReactorShape } from "../Services/BootstrapReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

type BootstrapEvent = Extract<
  ForgeEvent,
  {
    type: "thread.created" | "request.resolved";
  }
>;

type BootstrapFailure = {
  readonly _tag: "BootstrapFailure";
  readonly error: string;
  readonly stdout: string;
  readonly command: string;
};

interface ShellExecutionResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

const decodeForgeProjectConfig = Schema.decodeUnknownEffect(ForgeProjectConfig);
const DEFAULT_BOOTSTRAP_BRANCH_PREFIX = "forge";
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function bootstrapFailure(input: Omit<BootstrapFailure, "_tag">): BootstrapFailure {
  return {
    _tag: "BootstrapFailure",
    ...input,
  };
}

function bootstrapCommandId(
  threadId: ThreadId,
  attempt: number,
  step: "start" | "meta" | "complete" | "fail" | "request" | "skip",
): CommandId {
  return CommandId.makeUnsafe(`bootstrap:${threadId}:${attempt}:${step}`);
}

function bootstrapRequestId(threadId: ThreadId, attempt: number): InteractiveRequestId {
  return InteractiveRequestId.makeUnsafe(`bootstrap-request:${threadId}:${attempt}`);
}

function parseBootstrapRequestAttempt(requestId: string, threadId: ThreadId): number | null {
  const prefix = `bootstrap-request:${threadId}:`;
  if (!requestId.startsWith(prefix)) {
    return null;
  }
  const attempt = Number.parseInt(requestId.slice(prefix.length), 10);
  return Number.isFinite(attempt) && attempt > 0 ? attempt : null;
}

function nextBootstrapAttemptFromRequest(requestId: string, threadId: ThreadId): number | null {
  const attempt = parseBootstrapRequestAttempt(requestId, threadId);
  return attempt === null ? null : attempt + 1;
}

function normalizeBootstrapBranch(threadId: ThreadId): string {
  return `${DEFAULT_BOOTSTRAP_BRANCH_PREFIX}/${threadId}`;
}

function formatBootstrapOutput(stdout: string, stderr: string): string {
  const sections: string[] = [];
  const trimmedStdout = stdout.trimEnd();
  if (trimmedStdout.length > 0) {
    sections.push(`stdout:\n${trimmedStdout}`);
  }
  const trimmedStderr = stderr.trimEnd();
  if (trimmedStderr.length > 0) {
    sections.push(`stderr:\n${trimmedStderr}`);
  }
  return sections.join("\n\n");
}

function parseBootstrapAttempt(commandId: string | null, threadId: ThreadId): number | null {
  if (commandId === null) {
    return null;
  }
  const prefix = `bootstrap:${threadId}:`;
  if (!commandId.startsWith(prefix)) {
    return null;
  }
  const remainder = commandId.slice(prefix.length);
  const attempt = Number.parseInt(remainder.split(":")[0] ?? "", 10);
  return Number.isFinite(attempt) && attempt > 0 ? attempt : null;
}

function needsBootstrapFromThreadCreated(
  event: Extract<BootstrapEvent, { type: "thread.created" }>,
): boolean {
  const payload = event.payload as Record<string, unknown>;
  const bootstrapStatus =
    typeof payload.bootstrapStatus === "string" ? payload.bootstrapStatus : null;
  const spawnMode =
    typeof payload.spawnMode === "string" &&
    (payload.spawnMode === "local" || payload.spawnMode === "worktree")
      ? payload.spawnMode
      : resolveThreadSpawnMode({
          branch: typeof payload.branch === "string" ? payload.branch : null,
          worktreePath: typeof payload.worktreePath === "string" ? payload.worktreePath : null,
          ...(typeof payload.spawnBranch === "string" || payload.spawnBranch === null
            ? { spawnBranch: payload.spawnBranch as string | null }
            : {}),
          ...(typeof payload.spawnWorktreePath === "string" || payload.spawnWorktreePath === null
            ? {
                spawnWorktreePath: payload.spawnWorktreePath as string | null,
              }
            : {}),
        });
  return bootstrapStatus === "queued" || spawnMode === "worktree";
}

function runShellCommand(
  command: string,
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
  },
): Promise<ShellExecutionResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            stdout,
            stderr,
            code: 0,
            signal: null,
            timedOut: false,
          });
          return;
        }

        const execError = error as ExecException;
        resolve({
          stdout,
          stderr,
          code: typeof execError.code === "number" ? execError.code : null,
          signal: execError.signal ?? null,
          timedOut: execError.killed === true,
        });
      },
    );
  });
}

export const makeBootstrapReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const interactiveRequests = yield* ProjectionInteractiveRequestRepository;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const dispatchForgeCommand = (command: ForgeCommand) =>
    orchestrationEngine.dispatch(
      command as unknown as Parameters<typeof orchestrationEngine.dispatch>[0],
    );

  const nextBootstrapAttempt = Effect.fn("BootstrapReactor.nextBootstrapAttempt")(function* (
    threadId: ThreadId,
  ) {
    const events = yield* Stream.runCollect(orchestrationEngine.readEvents(0)).pipe(
      Effect.map((chunk): ReadonlyArray<ForgeEvent> => Array.from(chunk)),
    );

    let maxAttempt = 0;
    for (const event of events) {
      const attempt = parseBootstrapAttempt(event.commandId, threadId);
      if (attempt !== null) {
        maxAttempt = Math.max(maxAttempt, attempt);
      }
    }

    return maxAttempt + 1;
  });

  const resolveThreadContext = Effect.fn("BootstrapReactor.resolveThreadContext")(function* (
    threadId: ThreadId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return Option.none<{
        readonly thread: (typeof readModel.threads)[number];
        readonly project: (typeof readModel.projects)[number];
        readonly worktreePath: string;
        readonly branch: string;
      }>();
    }

    const project = readModel.projects.find((entry) => entry.id === thread.projectId);
    if (!project) {
      return Option.none<{
        readonly thread: (typeof readModel.threads)[number];
        readonly project: (typeof readModel.projects)[number];
        readonly worktreePath: string;
        readonly branch: string;
      }>();
    }

    return Option.some({
      thread,
      project,
      worktreePath: thread.worktreePath ?? path.join(serverConfig.worktreesDir, thread.id),
      branch: thread.branch ?? normalizeBootstrapBranch(thread.id),
    });
  });

  const loadBootstrapConfig = Effect.fn("BootstrapReactor.loadBootstrapConfig")(function* (
    projectRoot: string,
  ) {
    const configPath = path.join(projectRoot, ".forge", "config.json");
    const exists = yield* fileSystem.exists(configPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none<{ readonly command: string; readonly timeout: number }>();
    }

    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.mapError((cause) =>
        bootstrapFailure({
          error: `Failed to read Forge config at '${configPath}': ${cause.message}`,
          stdout: "",
          command: `read ${configPath}`,
        }),
      ),
    );

    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        bootstrapFailure({
          error:
            cause instanceof Error
              ? `Failed to parse Forge config at '${configPath}': ${cause.message}`
              : `Failed to parse Forge config at '${configPath}'.`,
          stdout: "",
          command: `parse ${configPath}`,
        }),
    });

    const config = yield* decodeForgeProjectConfig(parsed).pipe(
      Effect.mapError((error) =>
        bootstrapFailure({
          error: `Failed to decode Forge config at '${configPath}': ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          stdout: "",
          command: `decode ${configPath}`,
        }),
      ),
    );

    return config.bootstrap === undefined ? Option.none() : Option.some(config.bootstrap);
  });

  const ensureWorktree = Effect.fn("BootstrapReactor.ensureWorktree")(function* (input: {
    readonly threadId: ThreadId;
    readonly attempt: number;
    readonly projectRoot: string;
    readonly branch: string;
    readonly worktreePath: string;
  }) {
    const alreadyExists = yield* fileSystem
      .exists(input.worktreePath)
      .pipe(Effect.orElseSucceed(() => false));

    if (alreadyExists) {
      return {
        branch: input.branch,
        worktreePath: input.worktreePath,
      };
    }

    const branches = yield* git.listBranches({ cwd: input.projectRoot }).pipe(
      Effect.mapError((error) =>
        bootstrapFailure({
          error: error.message,
          stdout: "",
          command: error.command,
        }),
      ),
    );

    const currentBranch = branches.branches.find((entry) => entry.current)?.name;
    if (!currentBranch) {
      return yield* Effect.fail(
        bootstrapFailure({
          error: `Failed to resolve a current branch for '${input.projectRoot}'.`,
          stdout: "",
          command: `git branch --show-current (${input.projectRoot})`,
        }),
      );
    }

    const desiredBranch =
      input.branch === currentBranch ? normalizeBootstrapBranch(input.threadId) : input.branch;

    const worktree = yield* git
      .createWorktree({
        cwd: input.projectRoot,
        branch: currentBranch,
        newBranch: desiredBranch,
        path: input.worktreePath,
      })
      .pipe(
        Effect.mapError((error) =>
          bootstrapFailure({
            error: error.message,
            stdout: "",
            command: error.command,
          }),
        ),
      );

    yield* dispatchForgeCommand({
      type: "thread.meta.update",
      commandId: bootstrapCommandId(input.threadId, input.attempt, "meta"),
      threadId: input.threadId,
      branch: worktree.worktree.branch,
      worktreePath: worktree.worktree.path,
    });

    return {
      branch: worktree.worktree.branch,
      worktreePath: worktree.worktree.path,
    };
  });

  const dispatchBootstrapFailure = Effect.fn("BootstrapReactor.dispatchBootstrapFailure")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly attempt: number;
      readonly failure: BootstrapFailure;
      readonly createdAt: string;
    }) {
      yield* dispatchForgeCommand({
        type: "thread.bootstrap-failed",
        commandId: bootstrapCommandId(input.threadId, input.attempt, "fail"),
        threadId: input.threadId,
        error: input.failure.error,
        stdout: input.failure.stdout,
        command: input.failure.command,
        createdAt: input.createdAt,
      });

      yield* dispatchForgeCommand({
        type: "request.open",
        commandId: bootstrapCommandId(input.threadId, input.attempt, "request"),
        requestId: bootstrapRequestId(input.threadId, input.attempt),
        threadId: input.threadId,
        requestType: "bootstrap-failed",
        payload: {
          type: "bootstrap-failed",
          error: input.failure.error,
          stdout: input.failure.stdout,
          command: input.failure.command,
        },
        createdAt: input.createdAt,
      });
    },
  );

  const runBootstrapAttempt = Effect.fn("BootstrapReactor.runBootstrapAttempt")(function* (
    threadId: ThreadId,
    attempt: number,
  ) {
    const createdAt = new Date().toISOString();
    const resolved = yield* resolveThreadContext(threadId);
    if (Option.isNone(resolved)) {
      return;
    }

    const context = resolved.value;
    if (
      context.thread.bootstrapStatus === "completed" ||
      context.thread.bootstrapStatus === "skipped"
    ) {
      return;
    }

    yield* dispatchForgeCommand({
      type: "thread.bootstrap-started",
      commandId: bootstrapCommandId(threadId, attempt, "start"),
      threadId,
      createdAt,
    });

    yield* Effect.gen(function* () {
      const worktree = yield* ensureWorktree({
        threadId,
        attempt,
        projectRoot: context.project.workspaceRoot,
        branch: context.branch,
        worktreePath: context.worktreePath,
      });

      const bootstrapConfig = yield* loadBootstrapConfig(context.project.workspaceRoot);
      if (Option.isNone(bootstrapConfig)) {
        yield* dispatchForgeCommand({
          type: "thread.bootstrap-completed",
          commandId: bootstrapCommandId(threadId, attempt, "complete"),
          threadId,
          createdAt,
        });
        return;
      }

      const execution = yield* Effect.tryPromise({
        try: () =>
          runShellCommand(bootstrapConfig.value.command, {
            cwd: worktree.worktreePath,
            timeoutMs: bootstrapConfig.value.timeout,
          }),
        catch: (cause) =>
          bootstrapFailure({
            error:
              cause instanceof Error
                ? `Failed to execute bootstrap command '${bootstrapConfig.value.command}': ${cause.message}`
                : `Failed to execute bootstrap command '${bootstrapConfig.value.command}'.`,
            stdout: "",
            command: bootstrapConfig.value.command,
          }),
      });

      if (execution.timedOut || execution.code !== 0) {
        return yield* Effect.fail(
          bootstrapFailure({
            error: execution.timedOut
              ? `Bootstrap command timed out after ${bootstrapConfig.value.timeout}ms.`
              : execution.code !== null
                ? `Bootstrap command failed with exit code ${execution.code}.`
                : execution.signal
                  ? `Bootstrap command terminated by signal ${execution.signal}.`
                  : "Bootstrap command failed.",
            stdout: formatBootstrapOutput(execution.stdout, execution.stderr),
            command: bootstrapConfig.value.command,
          }),
        );
      }

      yield* dispatchForgeCommand({
        type: "thread.bootstrap-completed",
        commandId: bootstrapCommandId(threadId, attempt, "complete"),
        threadId,
        createdAt,
      });
    }).pipe(
      Effect.catchIf(
        (error): error is BootstrapFailure =>
          (error as BootstrapFailure)._tag === "BootstrapFailure",
        (failure) =>
          dispatchBootstrapFailure({
            threadId,
            attempt,
            failure,
            createdAt,
          }),
      ),
    );
  });

  const processThreadCreated = Effect.fn("BootstrapReactor.processThreadCreated")(function* (
    event: Extract<BootstrapEvent, { type: "thread.created" }>,
  ) {
    if (!needsBootstrapFromThreadCreated(event)) {
      return;
    }

    const attempt = yield* nextBootstrapAttempt(event.payload.threadId);
    yield* runBootstrapAttempt(event.payload.threadId, attempt);
  });

  const processRequestResolved = Effect.fn("BootstrapReactor.processRequestResolved")(function* (
    event: Extract<BootstrapEvent, { type: "request.resolved" }>,
  ) {
    const request = yield* interactiveRequests.queryById({
      requestId: event.payload.requestId,
    });
    if (Option.isNone(request)) {
      return;
    }

    if (request.value.type !== "bootstrap-failed" || request.value.resolvedWith === null) {
      return;
    }

    const resolution = request.value.resolvedWith;
    const action = "action" in resolution ? resolution.action : null;
    if (action === null) {
      return;
    }

    const followUpAttempt =
      nextBootstrapAttemptFromRequest(request.value.requestId, request.value.threadId) ??
      (yield* nextBootstrapAttempt(request.value.threadId));

    if (action === "skip") {
      yield* dispatchForgeCommand({
        type: "thread.bootstrap-skipped",
        commandId: bootstrapCommandId(request.value.threadId, followUpAttempt, "skip"),
        threadId: request.value.threadId,
        createdAt: event.payload.resolvedAt,
      });
      return;
    }

    if (action !== "retry") {
      return;
    }

    yield* runBootstrapAttempt(request.value.threadId, followUpAttempt);
  });

  const processEvent = Effect.fn("BootstrapReactor.processEvent")(function* (
    event: BootstrapEvent,
  ) {
    switch (event.type) {
      case "thread.created":
        yield* processThreadCreated(event);
        return;
      case "request.resolved":
        yield* processRequestResolved(event);
        return;
    }
  });

  const processEventSafely = (event: BootstrapEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        return Effect.logError("bootstrap reactor failed to process orchestration event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: BootstrapReactorShape["start"] = () =>
    Stream.runForEach(
      Stream.filter(
        orchestrationEngine.streamDomainEvents as unknown as Stream.Stream<ForgeEvent>,
        (event) => event.type === "thread.created" || event.type === "request.resolved",
      ).pipe(Stream.map((event) => event as BootstrapEvent)),
      worker.enqueue,
    ).pipe(Effect.forkScoped, Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies BootstrapReactorShape;
});

export const BootstrapReactorLive = Layer.effect(BootstrapReactor, makeBootstrapReactor);
