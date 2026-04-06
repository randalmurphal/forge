import assert from "node:assert/strict";
import { Deferred, Effect, Layer, Option, Ref } from "effect";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";
import { expect, it } from "vitest";

import type { OrchestrationReadModel } from "@forgetools/contracts";
import { ChannelService, type ChannelServiceShape } from "../../channel/Services/ChannelService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  WorkflowRegistry,
  type WorkflowRegistryShape,
} from "../../workflow/Services/WorkflowRegistry.ts";
import {
  WorkspacePaths,
  type WorkspacePathsShape,
} from "../../workspace/Services/WorkspacePaths.ts";
import { SocketTransport } from "../Services/SocketTransport.ts";
import { SocketTransportLive } from "./SocketTransport.ts";

const defaultModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
} as const;

const makeSnapshot = (): OrchestrationReadModel => {
  const now = "2026-04-06T18:00:00.000Z";
  return {
    snapshotSequence: 7,
    updatedAt: now,
    projects: [
      {
        id: "project-1" as never,
        title: "Project One",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: "thread-1" as never,
        projectId: "project-1" as never,
        title: "Thread One",
        modelSelection: defaultModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        parentThreadId: null,
        phaseRunId: null,
        workflowId: null,
        currentPhaseId: null,
        patternId: null,
        role: null,
        childThreadIds: [],
        bootstrapStatus: null,
        messages: [
          {
            id: "msg-1" as never,
            role: "user",
            text: "hello",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: "thread-1" as never,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      },
    ],
    phaseRuns: [],
    channels: [],
    pendingRequests: [
      {
        id: "request-1" as never,
        threadId: "thread-1" as never,
        phaseRunId: "phase-1" as never,
        type: "gate",
        status: "pending",
        payload: {
          type: "gate",
          gateType: "human-approval",
          phaseRunId: "phase-1" as never,
        },
        createdAt: now,
      },
    ],
    workflows: [],
  };
};

const sendRaw = (socketPath: string, payload: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = Net.createConnection(socketPath);
    socket.setEncoding("utf8");

    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      socket.end();
      resolve(JSON.parse(line));
    });
  });

const sendRawExpectSilence = (
  socketPath: string,
  payload: string,
  timeoutMs = 75,
): Promise<"silent"> =>
  new Promise((resolve, reject) => {
    const socket = Net.createConnection(socketPath);
    socket.setEncoding("utf8");

    const timeout = setTimeout(() => {
      socket.end();
      resolve("silent");
    }, timeoutMs);

    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      clearTimeout(timeout);
      socket.end();
      reject(new Error(`expected no response, received: ${chunk}`));
    });
    socket.on("end", () => {
      clearTimeout(timeout);
      resolve("silent");
    });
  });

const makeTestLayer = (options?: {
  snapshot?: OrchestrationReadModel;
  orchestrationEngine?: Partial<OrchestrationEngineShape>;
  projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
  channelService?: Partial<ChannelServiceShape>;
  workflowRegistry?: Partial<WorkflowRegistryShape>;
  workspacePaths?: Partial<WorkspacePathsShape>;
}) => {
  const snapshot = options?.snapshot ?? makeSnapshot();
  return SocketTransportLive.pipe(
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        getReadModel: () => Effect.succeed(snapshot),
        readEvents: () => {
          throw new Error("not used");
        },
        dispatch: () => Effect.succeed({ sequence: 42 }),
        streamDomainEvents: undefined as never,
        ...options?.orchestrationEngine,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getSnapshot: () => Effect.succeed(snapshot),
        getCounts: () => Effect.succeed({ projectCount: 1, threadCount: 1 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        ...options?.projectionSnapshotQuery,
      }),
    ),
    Layer.provide(
      Layer.mock(ChannelService)({
        createChannel: () => Effect.die("not used"),
        postMessage: () => Effect.die("not used"),
        getMessages: () => Effect.succeed([]),
        getUnreadCount: () => Effect.succeed(0),
        getCursor: () => Effect.succeed(-1 as never),
        advanceCursor: () => Effect.void,
        ...options?.channelService,
      }),
    ),
    Layer.provide(
      Layer.mock(WorkflowRegistry)({
        queryAll: () => Effect.succeed([]),
        queryById: () => Effect.succeed(Option.none()),
        queryByName: () => Effect.succeed(Option.none()),
        ...options?.workflowRegistry,
      }),
    ),
    Layer.provide(
      Layer.mock(WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
        resolveRelativePathWithinRoot: () => Effect.die("not used"),
        ...options?.workspacePaths,
      }),
    ),
  );
};

it("bind accepts daemon.ping JSON-RPC requests and returns status + uptime", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(Effect.provide(makeTestLayer())),
    );
    const binding = await Effect.runPromise(
      transport.bind({
        socketPath,
        startedAt: "2026-04-06T18:00:00.000Z",
      }),
    );

    try {
      const response = (await sendRaw(
        socketPath,
        `${JSON.stringify({ jsonrpc: "2.0", id: "ping-1", method: "daemon.ping", params: {} })}\n`,
      )) as {
        readonly result: { readonly status: string; readonly uptime: number };
      };

      assert.equal(response.result.status, "ok");
      assert.equal(typeof response.result.uptime, "number");
      expect(response.result.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("bind delays daemon.ping responses until the daemon runtime is ready", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const ready = await Effect.runPromise(Deferred.make<void, Error>());
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(Effect.provide(makeTestLayer())),
    );
    const binding = await Effect.runPromise(
      transport.bind({
        socketPath,
        awaitReady: Deferred.await(ready),
      }),
    );

    try {
      const responsePromise = sendRaw(
        socketPath,
        `${JSON.stringify({ jsonrpc: "2.0", id: "ping-delayed", method: "daemon.ping", params: {} })}\n`,
      );

      const earlyResult = await Promise.race([
        responsePromise.then(() => "response"),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      assert.equal(earlyResult, "timeout");

      await Effect.runPromise(Deferred.succeed(ready, undefined));

      const response = (await responsePromise) as {
        readonly result: { readonly status: string; readonly uptime: number };
      };
      assert.equal(response.result.status, "ok");
      assert.equal(typeof response.result.uptime, "number");
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("bind returns method-not-found for unknown JSON-RPC methods", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(Effect.provide(makeTestLayer())),
    );
    const binding = await Effect.runPromise(transport.bind({ socketPath }));

    try {
      const response = (await sendRaw(
        socketPath,
        `${JSON.stringify({ jsonrpc: "2.0", id: "missing-1", method: "unknown.method", params: {} })}\n`,
      )) as {
        readonly error: { readonly code: number; readonly message: string };
      };

      assert.equal(response.error.code, -32601);
      assert.equal(response.error.message, "Method 'unknown.method' not found");
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("bind returns parse errors for malformed JSON input", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(Effect.provide(makeTestLayer())),
    );
    const binding = await Effect.runPromise(transport.bind({ socketPath }));

    try {
      const response = (await sendRaw(socketPath, "{not-json}\n")) as {
        readonly error: { readonly code: number; readonly message: string };
      };

      assert.equal(response.error.code, -32700);
      assert.equal(response.error.message, "Parse error");
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("bind does not respond to unknown-method notifications with no id", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(Effect.provide(makeTestLayer())),
    );
    const binding = await Effect.runPromise(transport.bind({ socketPath }));

    try {
      const result = await sendRawExpectSilence(
        socketPath,
        `${JSON.stringify({ jsonrpc: "2.0", method: "unknown.method", params: {} })}\n`,
      );

      assert.equal(result, "silent");
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("bind does not respond to invalid-param notifications with no id", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(Effect.provide(makeTestLayer())),
    );
    const binding = await Effect.runPromise(transport.bind({ socketPath }));

    try {
      const result = await sendRawExpectSilence(
        socketPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "channel.intervene",
          params: {
            channelId: "channel-1",
          },
        })}\n`,
      );

      assert.equal(result, "silent");
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("gate.approve resolves the current pending gate when phaseRunId is omitted", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const dispatched = await Effect.runPromise(Ref.make<ReadonlyArray<unknown>>([]));
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(
        Effect.provide(
          makeTestLayer({
            orchestrationEngine: {
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.as({ sequence: 43 }),
                ),
            },
          }),
        ),
      ),
    );
    const binding = await Effect.runPromise(transport.bind({ socketPath }));

    try {
      const response = (await sendRaw(
        socketPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "approve-1",
          method: "gate.approve",
          params: {
            sessionId: "thread-1",
          },
        })}\n`,
      )) as {
        readonly result: { readonly sequence: number };
      };

      assert.equal(response.result.sequence, 43);

      const commands = await Effect.runPromise(Ref.get(dispatched));
      assert.equal(commands.length, 1);
      assert.deepStrictEqual(
        {
          type: (commands[0] as { readonly type: string }).type,
          requestId: (commands[0] as { readonly requestId: string }).requestId,
          resolvedWith: (commands[0] as { readonly resolvedWith: unknown }).resolvedWith,
        },
        {
          type: "request.resolve",
          requestId: "request-1",
          resolvedWith: { decision: "approve" },
        },
      );
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("gate.reject fails safely when phaseRunId is omitted for an ambiguous session", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");
  const baseSnapshot = makeSnapshot();
  const snapshot = {
    ...baseSnapshot,
    pendingRequests: [
      ...baseSnapshot.pendingRequests,
      {
        id: "request-2" as never,
        threadId: "thread-1" as never,
        phaseRunId: "phase-2" as never,
        type: "gate",
        status: "pending",
        payload: {
          type: "gate",
          gateType: "human-approval",
          phaseRunId: "phase-2" as never,
        },
        createdAt: "2026-04-06T18:01:00.000Z",
      },
    ],
  } satisfies OrchestrationReadModel;

  try {
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(
        Effect.provide(
          makeTestLayer({
            snapshot,
          }),
        ),
      ),
    );
    const binding = await Effect.runPromise(transport.bind({ socketPath }));

    try {
      const response = (await sendRaw(
        socketPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "reject-1",
          method: "gate.reject",
          params: {
            sessionId: "thread-1",
            reason: "need another pass",
          },
        })}\n`,
      )) as {
        readonly error: { readonly code: number; readonly message: string };
      };

      assert.equal(response.error.code, -32000);
      assert.equal(
        response.error.message,
        "Multiple pending gate requests found for thread 'thread-1'; specify phaseRunId.",
      );
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("bootstrap.retry resolves the current pending bootstrap-failed request", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");
  const baseSnapshot = makeSnapshot();
  const snapshot = {
    ...baseSnapshot,
    pendingRequests: [
      {
        id: "request-bootstrap-1" as never,
        threadId: "thread-1" as never,
        type: "bootstrap-failed",
        status: "pending",
        payload: {
          type: "bootstrap-failed",
          error: "bootstrap failed",
          stdout: "command output",
          command: "bun install",
        },
        createdAt: "2026-04-06T18:02:00.000Z",
      },
    ],
  } satisfies OrchestrationReadModel;

  try {
    const dispatched = await Effect.runPromise(Ref.make<ReadonlyArray<unknown>>([]));
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(
        Effect.provide(
          makeTestLayer({
            snapshot,
            orchestrationEngine: {
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.as({ sequence: 51 }),
                ),
            },
          }),
        ),
      ),
    );
    const binding = await Effect.runPromise(transport.bind({ socketPath }));

    try {
      const response = (await sendRaw(
        socketPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "bootstrap-retry-1",
          method: "bootstrap.retry",
          params: {
            sessionId: "thread-1",
          },
        })}\n`,
      )) as {
        readonly result: { readonly sequence: number };
      };

      assert.equal(response.result.sequence, 51);

      const commands = await Effect.runPromise(Ref.get(dispatched));
      assert.equal(commands.length, 1);
      assert.deepStrictEqual(
        {
          type: (commands[0] as { readonly type: string }).type,
          requestId: (commands[0] as { readonly requestId: string }).requestId,
          resolvedWith: (commands[0] as { readonly resolvedWith: unknown }).resolvedWith,
        },
        {
          type: "request.resolve",
          requestId: "request-bootstrap-1",
          resolvedWith: { action: "retry" },
        },
      );
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("bootstrap.skip fails when there is no pending bootstrap-failed request", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(Effect.provide(makeTestLayer())),
    );
    const binding = await Effect.runPromise(transport.bind({ socketPath }));

    try {
      const response = (await sendRaw(
        socketPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "bootstrap-skip-1",
          method: "bootstrap.skip",
          params: {
            sessionId: "thread-1",
          },
        })}\n`,
      )) as {
        readonly error: { readonly code: number; readonly message: string };
      };

      assert.equal(response.error.code, -32000);
      assert.equal(
        response.error.message,
        "No pending bootstrap request found for thread 'thread-1'.",
      );
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("channel.intervene maps to channel.post-message orchestration commands", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const dispatched = await Effect.runPromise(Ref.make<ReadonlyArray<unknown>>([]));
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(
        Effect.provide(
          makeTestLayer({
            orchestrationEngine: {
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.as({ sequence: 99 }),
                ),
            },
          }),
        ),
      ),
    );
    const binding = await Effect.runPromise(transport.bind({ socketPath }));

    try {
      const response = (await sendRaw(
        socketPath,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "intervene-1",
          method: "channel.intervene",
          params: {
            channelId: "channel-1",
            content: "please re-evaluate",
          },
        })}\n`,
      )) as {
        readonly result: { readonly sequence: number };
      };

      assert.equal(response.result.sequence, 99);

      const commands = await Effect.runPromise(Ref.get(dispatched));
      assert.equal(commands.length, 1);
      assert.deepStrictEqual(
        {
          type: (commands[0] as { readonly type: string }).type,
          fromType: (commands[0] as { readonly fromType: string }).fromType,
          fromId: (commands[0] as { readonly fromId: string }).fromId,
          channelId: (commands[0] as { readonly channelId: string }).channelId,
          content: (commands[0] as { readonly content: string }).content,
        },
        {
          type: "channel.post-message",
          fromType: "human",
          fromId: "human",
          channelId: "channel-1",
          content: "please re-evaluate",
        },
      );
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});

it("daemon.stop returns a response before invoking the async shutdown hook", async () => {
  const socketDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-socket-transport-"));
  const socketPath = Path.join(socketDir, "forge.sock");

  try {
    const stopStarted = await Effect.runPromise(Deferred.make<void, Error>());
    const stopRelease = await Effect.runPromise(Deferred.make<void, Error>());
    const stopCompleted = await Effect.runPromise(Ref.make(false));
    const transport = await Effect.runPromise(
      Effect.service(SocketTransport).pipe(Effect.provide(makeTestLayer())),
    );
    const binding = await Effect.runPromise(
      transport.bind({
        socketPath,
        stopDaemon: Deferred.succeed(stopStarted, undefined).pipe(
          Effect.andThen(Deferred.await(stopRelease)),
          Effect.andThen(Ref.set(stopCompleted, true)),
        ),
      }),
    );

    try {
      const responsePromise = sendRaw(
        socketPath,
        `${JSON.stringify({ jsonrpc: "2.0", id: "stop-1", method: "daemon.stop", params: {} })}\n`,
      );

      await Effect.runPromise(Deferred.await(stopStarted));

      const response = (await responsePromise) as {
        readonly result: null;
      };
      assert.equal(response.result, null);
      assert.equal(await Effect.runPromise(Ref.get(stopCompleted)), false);

      await Effect.runPromise(Deferred.succeed(stopRelease, undefined));
      await Effect.runPromise(Effect.sleep("25 millis"));
      assert.equal(await Effect.runPromise(Ref.get(stopCompleted)), true);
    } finally {
      await Effect.runPromise(binding.close.pipe(Effect.catch(() => Effect.void)));
    }
  } finally {
    FS.rmSync(socketDir, { recursive: true, force: true });
  }
});
