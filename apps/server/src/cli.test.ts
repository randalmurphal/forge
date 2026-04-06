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
