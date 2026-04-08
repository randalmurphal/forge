import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  InteractiveRequestId,
  ProjectId,
  ThreadId,
} from "@forgetools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionInteractiveRequestRepositoryLive } from "../../persistence/Layers/ProjectionInteractiveRequests.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionInteractiveRequestRepository } from "../../persistence/Services/ProjectionInteractiveRequests.ts";
import { BootstrapReactor } from "../Services/BootstrapReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { BootstrapReactorLive } from "./BootstrapReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "forge-bootstrap-reactor-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "hello\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function writeForgeConfig(cwd: string, command: string, timeout = 5_000): void {
  const forgeDir = path.join(cwd, ".forge");
  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(forgeDir, "config.json"),
    JSON.stringify(
      {
        bootstrap: {
          command,
          timeout,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("BootstrapReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<any, any> | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness() {
    const projectRoot = createGitRepository();
    tempDirs.push(projectRoot);

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );

    const layer = BootstrapReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(ProjectionInteractiveRequestRepositoryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(GitCoreLive),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "forge-bootstrap-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer as any);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(BootstrapReactor));
    const requests = await runtime.runPromise(
      Effect.service(ProjectionInteractiveRequestRepository),
    );
    const config = (await runtime.runPromise(Effect.service(ServerConfig) as any)) as {
      worktreesDir: string;
    };

    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Project",
        workspaceRoot: projectRoot,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    return {
      engine,
      reactor,
      requests,
      projectRoot,
      worktreesDir: config.worktreesDir,
      drain: () => Effect.runPromise(reactor.drain),
    };
  }

  it("creates the thread worktree, runs bootstrap, and dispatches completion", async () => {
    const harness = await createHarness();
    writeForgeConfig(
      harness.projectRoot,
      `node -e "require('fs').writeFileSync('bootstrapped.txt','ok\\n')"`,
    );

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-success"),
        threadId: ThreadId.makeUnsafe("thread-bootstrap-success"),
        projectId: asProjectId("project-1"),
        title: "Bootstrap Success",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        spawnMode: "worktree",
        branch: "forge/thread-bootstrap-success",
        worktreePath: null,
        createdAt,
      }),
    );

    await harness.drain();

    const worktreePath = path.join(harness.worktreesDir, "thread-bootstrap-success");
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.readFileSync(path.join(worktreePath, "bootstrapped.txt"), "utf8")).toBe("ok\n");

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).toContain("thread.bootstrap-completed");

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-bootstrap-success");
    expect(thread?.bootstrapStatus).toBe("completed");
    expect(thread?.worktreePath).toBe(worktreePath);
  });

  it("opens a bootstrap-failed interactive request when bootstrap exits non-zero", async () => {
    const harness = await createHarness();
    writeForgeConfig(
      harness.projectRoot,
      `node -e "process.stdout.write('bootstrap out\\n'); process.stderr.write('bootstrap err\\n'); process.exit(1)"`,
    );

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-fail"),
        threadId: ThreadId.makeUnsafe("thread-bootstrap-fail"),
        projectId: asProjectId("project-1"),
        title: "Bootstrap Fail",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        spawnMode: "worktree",
        branch: "forge/thread-bootstrap-fail",
        worktreePath: null,
        createdAt,
      }),
    );

    await harness.drain();

    const request = await Effect.runPromise(
      harness.requests.queryById({
        requestId: InteractiveRequestId.makeUnsafe("bootstrap-request:thread-bootstrap-fail:1"),
      }),
    );

    expect(Option.isSome(request)).toBe(true);
    expect(Option.getOrNull(request)?.type).toBe("bootstrap-failed");
    expect(Option.getOrNull(request)?.status).toBe("pending");
    if (Option.isSome(request) && request.value.payload.type === "bootstrap-failed") {
      expect(request.value.payload.stdout).toContain("bootstrap out");
      expect(request.value.payload.stdout).toContain("bootstrap err");
    }

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-bootstrap-fail");
    expect(thread?.bootstrapStatus).toBe("failed");
  });

  it("retries bootstrap after a bootstrap-failed request is resolved with retry", async () => {
    const harness = await createHarness();
    writeForgeConfig(
      harness.projectRoot,
      `node -e "process.stdout.write('first fail\\n'); process.exit(1)"`,
    );

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-retry"),
        threadId: ThreadId.makeUnsafe("thread-bootstrap-retry"),
        projectId: asProjectId("project-1"),
        title: "Bootstrap Retry",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        spawnMode: "worktree",
        branch: "forge/thread-bootstrap-retry",
        worktreePath: null,
        createdAt,
      }),
    );
    await harness.drain();

    writeForgeConfig(
      harness.projectRoot,
      `node -e "require('fs').writeFileSync('retried.txt','done\\n')"`,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "request.resolve",
        commandId: CommandId.makeUnsafe("cmd-bootstrap-request-resolve"),
        requestId: InteractiveRequestId.makeUnsafe("bootstrap-request:thread-bootstrap-retry:1"),
        resolvedWith: {
          action: "retry",
        },
        createdAt: new Date().toISOString(),
      } as any),
    );
    await harness.drain();

    const worktreePath = path.join(harness.worktreesDir, "thread-bootstrap-retry");
    expect(fs.readFileSync(path.join(worktreePath, "retried.txt"), "utf8")).toBe("done\n");

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-bootstrap-retry");
    expect(thread?.bootstrapStatus).toBe("completed");

    const events = (await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    )) as Array<any>;
    const retryCommands = events
      .filter((event) => event.type === "thread.bootstrap-completed")
      .map((event) => event.commandId);
    expect(retryCommands).toContain("bootstrap:thread-bootstrap-retry:2:complete");
  });

  it("uses deterministic command ids so duplicate bootstrap completion dispatches collapse on replay", async () => {
    const harness = await createHarness();
    writeForgeConfig(
      harness.projectRoot,
      `node -e "require('fs').writeFileSync('idempotent.txt','ok\\n')"`,
    );

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-idempotent"),
        threadId: ThreadId.makeUnsafe("thread-bootstrap-idempotent"),
        projectId: asProjectId("project-1"),
        title: "Bootstrap Idempotent",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        spawnMode: "worktree",
        branch: "forge/thread-bootstrap-idempotent",
        worktreePath: null,
        createdAt,
      }),
    );
    await harness.drain();

    const duplicate = await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.bootstrap-completed",
        commandId: CommandId.makeUnsafe("bootstrap:thread-bootstrap-idempotent:1:complete"),
        threadId: ThreadId.makeUnsafe("thread-bootstrap-idempotent"),
        createdAt: new Date().toISOString(),
      } as any),
    );

    const events = (await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    )) as Array<any>;
    const completed = events.filter(
      (event) =>
        event.type === "thread.bootstrap-completed" &&
        event.commandId === "bootstrap:thread-bootstrap-idempotent:1:complete",
    );

    expect(duplicate.sequence).toBe(completed[0]?.sequence);
    expect(completed).toHaveLength(1);
  });

  it("derives retry follow-up attempts from the bootstrap request id on duplicate request.resolved delivery", async () => {
    const threadId = ThreadId.makeUnsafe("thread-bootstrap-duplicate-resolution");
    const requestId = InteractiveRequestId.makeUnsafe(
      "bootstrap-request:thread-bootstrap-duplicate-resolution:1",
    );
    const commands: Array<{ readonly type: string; readonly commandId: string }> = [];
    const persistedEvents = [
      {
        sequence: 1,
        commandId: "bootstrap:thread-bootstrap-duplicate-resolution:1:fail",
      },
    ];

    const layer = BootstrapReactorLive.pipe(
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () => Effect.die("unused"),
          readEvents: () => Stream.fromIterable(persistedEvents as Array<any>),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push({
                type: command.type,
                commandId: command.commandId,
              });
              persistedEvents.push({
                sequence: persistedEvents.length + 1,
                commandId: command.commandId,
              });
              return { sequence: persistedEvents.length };
            }),
          streamDomainEvents: Stream.fromIterable([
            {
              type: "request.resolved",
              payload: {
                requestId,
                resolvedWith: { action: "skip" },
                resolvedAt: "2026-04-05T18:00:00.000Z",
              },
            },
            {
              type: "request.resolved",
              payload: {
                requestId,
                resolvedWith: { action: "skip" },
                resolvedAt: "2026-04-05T18:00:01.000Z",
              },
            },
          ] as Array<any>),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProjectionInteractiveRequestRepository)({
          upsert: () => Effect.die("unused"),
          queryByThreadId: () => Effect.succeed([]),
          queryPending: () => Effect.succeed([]),
          updateStatus: () => Effect.void,
          markStale: () => Effect.void,
          queryById: () =>
            Effect.succeed(
              Option.some({
                requestId,
                threadId,
                childThreadId: null,
                phaseRunId: null,
                type: "bootstrap-failed" as const,
                status: "resolved" as const,
                payload: {
                  type: "bootstrap-failed" as const,
                  error: "boom",
                  stdout: "",
                  command: "echo boom",
                },
                resolvedWith: {
                  action: "skip" as const,
                },
                createdAt: "2026-04-05T17:59:59.000Z",
                resolvedAt: "2026-04-05T18:00:00.000Z",
                staleReason: null,
              }),
            ),
        }),
      ),
      Layer.provideMerge(Layer.mock(GitCore)({})),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "forge-bootstrap-duplicate-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* BootstrapReactor;
          yield* reactor.start();
          yield* Effect.sleep("50 millis");
          yield* reactor.drain;
        }),
      ).pipe(Effect.provide(layer)),
    );

    expect(commands).toEqual([
      {
        type: "thread.bootstrap-skipped",
        commandId: "bootstrap:thread-bootstrap-duplicate-resolution:2:skip",
      },
      {
        type: "thread.bootstrap-skipped",
        commandId: "bootstrap:thread-bootstrap-duplicate-resolution:2:skip",
      },
    ]);
  });

  it("does not bootstrap local threads created on the main workspace", async () => {
    const harness = await createHarness();
    writeForgeConfig(
      harness.projectRoot,
      `node -e "require('fs').writeFileSync('should-not-run.txt','nope\\n')"`,
    );

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-local-main"),
        threadId: ThreadId.makeUnsafe("thread-local-main"),
        projectId: asProjectId("project-1"),
        title: "Local Main",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        spawnMode: "local",
        branch: "main",
        worktreePath: null,
        createdAt,
      }),
    );

    await harness.drain();

    expect(fs.existsSync(path.join(harness.worktreesDir, "thread-local-main"))).toBe(false);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === "thread-local-main");
    expect(thread?.bootstrapStatus).toBe(null);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    expect(events.map((event) => event.type)).not.toContain("thread.bootstrap-completed");
    expect(fs.existsSync(path.join(harness.projectRoot, "should-not-run.txt"))).toBe(false);
  });
});
