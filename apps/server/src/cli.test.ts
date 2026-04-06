import nodeAssert from "node:assert/strict";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@forgetools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CliError from "effect/unstable/cli/CliError";
import { Command } from "effect/unstable/cli";
import { it as vitestIt } from "vitest";

import { cli } from "./cli.ts";
import { ForgeDaemonCliError } from "./daemon/cliClient.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
};

const listenOnSocket = (
  socketPath: string,
  requests: Array<JsonRpcRequest>,
  result: unknown | ((request: JsonRpcRequest) => unknown),
) =>
  new Promise<Net.Server>((resolve, reject) => {
    const server = Net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }

        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const request = JSON.parse(line) as JsonRpcRequest;
        requests.push(request);
        const responseResult = typeof result === "function" ? result(request) : result;
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: responseResult,
          })}\n`,
        );
        socket.end();
      });
    });
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });

const closeServer = (server: Net.Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const runCli = (args: ReadonlyArray<string>) =>
  Effect.runPromise(
    Command.runWith(cli, { version: "0.0.0" })([...args]).pipe(Effect.provide(CliRuntimeLayer)),
  );

const withSocketServer = async <A>(
  result: unknown | ((request: JsonRpcRequest) => unknown),
  run: (input: {
    readonly baseDir: string;
    readonly requests: Array<JsonRpcRequest>;
  }) => Promise<A>,
) => {
  const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-cli-test-"));
  const requests: Array<JsonRpcRequest> = [];
  const server = await listenOnSocket(Path.join(baseDir, "forge.sock"), requests, result);

  try {
    return await run({ baseDir, requests });
  } finally {
    await closeServer(server);
    FS.rmSync(baseDir, { recursive: true, force: true });
  }
};

it.layer(NodeServices.layer)("cli log-level parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    Command.runWith(cli, { version: "0.0.0" })(["--log-level", "debug", "--version"]).pipe(
      Effect.provide(CliRuntimeLayer),
    ),
  );

  it.effect("rejects invalid log-level casing before launching the server", () =>
    Effect.gen(function* () {
      const error = yield* Command.runWith(cli, { version: "0.0.0" })([
        "--log-level",
        "Debug",
      ]).pipe(Effect.provide(CliRuntimeLayer), Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${error._tag}`);
      }
      assert.equal(error.option, "log-level");
      assert.equal(error.value, "Debug");
    }),
  );
});

vitestIt("routes `forge list` to session.list over the daemon socket", async () => {
  await withSocketServer([], async ({ baseDir, requests }) => {
    await runCli(["list", "--base-dir", baseDir]);

    nodeAssert.equal(requests.length, 1);
    nodeAssert.equal(requests[0]?.method, "session.list");
    nodeAssert.deepStrictEqual(requests[0]?.params, {});
  });
});

vitestIt("routes `forge create` to session.create with the expected payload", async () => {
  await withSocketServer({ sequence: 12 }, async ({ baseDir, requests }) => {
    await runCli([
      "create",
      "Build daemon loop",
      "--workflow",
      "build-loop",
      "--project",
      ".",
      "--base-dir",
      baseDir,
    ]);

    nodeAssert.equal(requests.length, 1);
    nodeAssert.equal(requests[0]?.method, "session.create");
    nodeAssert.deepStrictEqual(requests[0]?.params, {
      title: "Build daemon loop",
      workflow: "build-loop",
      projectPath: process.cwd(),
    });
  });
});

vitestIt(
  "routes `forge create --model claude:...` using the daemon model selection shape",
  async () => {
    await withSocketServer({ sequence: 13 }, async ({ baseDir, requests }) => {
      await runCli([
        "create",
        "Review bootstrap failure",
        "--project",
        ".",
        "--model",
        "claude:claude-sonnet-4-5",
        "--base-dir",
        baseDir,
      ]);

      nodeAssert.equal(requests.length, 1);
      nodeAssert.equal(requests[0]?.method, "session.create");
      nodeAssert.deepStrictEqual(requests[0]?.params, {
        title: "Review bootstrap failure",
        projectPath: process.cwd(),
        model: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-5",
        },
      });
    });
  },
);

vitestIt(
  "rejects `forge create --model` values that are missing the provider:model format",
  async () => {
    const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-cli-create-model-error-"));
    try {
      await nodeAssert.rejects(
        runCli([
          "create",
          "Bad model",
          "--project",
          ".",
          "--model",
          "claude",
          "--base-dir",
          baseDir,
        ]),
        (error) => {
          nodeAssert.equal(error instanceof ForgeDaemonCliError, true);
          nodeAssert.equal(
            error instanceof ForgeDaemonCliError &&
              error.message.includes("Invalid --model value. Expected `provider:model`"),
            true,
          );
          return true;
        },
      );
    } finally {
      FS.rmSync(baseDir, { recursive: true, force: true });
    }
  },
);

vitestIt("routes `forge answer` to request.resolve with a user-input resolution", async () => {
  await withSocketServer({ sequence: 19 }, async ({ baseDir, requests }) => {
    await runCli(["answer", "request-7", "--input", "ship it", "--base-dir", baseDir]);

    nodeAssert.equal(requests.length, 1);
    nodeAssert.equal(requests[0]?.method, "request.resolve");
    nodeAssert.deepStrictEqual(requests[0]?.params, {
      requestId: "request-7",
      resolvedWith: {
        answers: {
          input: "ship it",
        },
      },
    });
  });
});

vitestIt("routes `forge approve` to gate.approve using sessionId params", async () => {
  await withSocketServer({ sequence: 23 }, async ({ baseDir, requests }) => {
    await runCli(["approve", "thread-7", "--base-dir", baseDir]);

    nodeAssert.equal(requests.length, 1);
    nodeAssert.equal(requests[0]?.method, "gate.approve");
    nodeAssert.deepStrictEqual(requests[0]?.params, {
      sessionId: "thread-7",
    });
  });
});

vitestIt("routes `forge reject` to gate.reject with an optional reason", async () => {
  await withSocketServer({ sequence: 24 }, async ({ baseDir, requests }) => {
    await runCli(["reject", "thread-8", "needs another pass", "--base-dir", baseDir]);

    nodeAssert.equal(requests.length, 1);
    nodeAssert.equal(requests[0]?.method, "gate.reject");
    nodeAssert.deepStrictEqual(requests[0]?.params, {
      sessionId: "thread-8",
      reason: "needs another pass",
    });
  });
});

vitestIt("routes `forge intervene` to channel.intervene", async () => {
  await withSocketServer({ sequence: 25 }, async ({ baseDir, requests }) => {
    await runCli(["intervene", "channel-7", "please reassess", "--base-dir", baseDir]);

    nodeAssert.equal(requests.length, 1);
    nodeAssert.equal(requests[0]?.method, "channel.intervene");
    nodeAssert.deepStrictEqual(requests[0]?.params, {
      channelId: "channel-7",
      content: "please reassess",
    });
  });
});

vitestIt("routes `forge daemon stop` to daemon.stop", async () => {
  await withSocketServer(
    (request: JsonRpcRequest) =>
      request.method === "daemon.ping" ? { status: "ok", uptime: 1 } : null,
    async ({ baseDir, requests }) => {
      await runCli(["daemon", "stop", "--base-dir", baseDir]);

      nodeAssert.equal(requests.length, 2);
      nodeAssert.equal(requests[0]?.method, "daemon.ping");
      nodeAssert.equal(requests[1]?.method, "daemon.stop");
    },
  );
});

vitestIt("routes `forge daemon restart` through stop then launch", async () => {
  const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-cli-daemon-restart-"));
  const requests: Array<JsonRpcRequest> = [];
  const socketPath = Path.join(baseDir, "forge.sock");
  const fakeDaemonScriptPath = Path.join(baseDir, "fake-daemon.js");
  const originalArgv1 = process.argv[1];

  FS.writeFileSync(
    fakeDaemonScriptPath,
    [
      'const FS = require("node:fs");',
      'const Net = require("node:net");',
      'const Path = require("node:path");',
      'const baseDirIndex = process.argv.indexOf("--base-dir");',
      "const baseDir = baseDirIndex === -1 ? undefined : process.argv[baseDirIndex + 1];",
      'if (!baseDir) throw new Error("missing --base-dir");',
      'const socketPath = Path.join(baseDir, "forge.sock");',
      "try {",
      "  FS.rmSync(socketPath, { force: true });",
      "} catch {}",
      "const startedAt = Date.now();",
      "let handledSessionList = false;",
      "const server = Net.createServer((socket) => {",
      '  socket.setEncoding("utf8");',
      '  let buffer = "";',
      '  socket.on("data", (chunk) => {',
      "    buffer += chunk;",
      '    const newlineIndex = buffer.indexOf("\\n");',
      "    if (newlineIndex === -1) return;",
      "    const line = buffer.slice(0, newlineIndex);",
      "    buffer = buffer.slice(newlineIndex + 1);",
      "    const request = JSON.parse(line);",
      "    let result = null;",
      '    if (request.method === "daemon.ping") {',
      '      result = { status: "ok", uptime: Date.now() - startedAt };',
      '    } else if (request.method === "session.list") {',
      "      handledSessionList = true;",
      "      result = [];",
      "    }",
      '    socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\\n`, () => {',
      "      if (handledSessionList) {",
      "        server.close(() => process.exit(0));",
      "      }",
      "    });",
      "  });",
      "});",
      "server.listen(socketPath);",
      "setTimeout(() => server.close(() => process.exit(0)), 5000);",
    ].join("\n"),
    "utf8",
  );

  const server = await listenOnSocket(socketPath, requests, (request: JsonRpcRequest) => {
    if (request.method === "daemon.ping") {
      return { status: "ok", uptime: 1 };
    }
    if (request.method === "daemon.stop") {
      setImmediate(() => {
        void closeServer(server).catch(() => undefined);
      });
      return null;
    }
    return null;
  });

  try {
    process.argv[1] = fakeDaemonScriptPath;

    await runCli(["daemon", "restart", "--base-dir", baseDir]);

    nodeAssert.equal(requests.length, 2);
    nodeAssert.equal(requests[0]?.method, "daemon.ping");
    nodeAssert.equal(requests[1]?.method, "daemon.stop");
    await sleep(300);
  } finally {
    if (originalArgv1 === undefined) {
      delete process.argv[1];
    } else {
      process.argv[1] = originalArgv1;
    }
    await closeServer(server).catch(() => undefined);
    FS.rmSync(baseDir, { recursive: true, force: true });
  }
});

vitestIt("reports a friendly error when the daemon socket is missing", async () => {
  const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "forge-cli-daemon-missing-"));
  try {
    await nodeAssert.rejects(runCli(["list", "--base-dir", baseDir]), (error) => {
      nodeAssert.equal(error instanceof ForgeDaemonCliError, true);
      nodeAssert.equal(
        error instanceof ForgeDaemonCliError &&
          error.message.includes("Start it with `forge daemon start`."),
        true,
      );
      return true;
    });
  } finally {
    FS.rmSync(baseDir, { recursive: true, force: true });
  }
});
