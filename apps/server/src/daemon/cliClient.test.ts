import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { buildDaemonLaunchPlan, readDaemonInfoFile, sendDaemonRpc } from "./cliClient.ts";
import { DAEMON_SOCKET_PROTOCOL_VERSION } from "./protocol.ts";

const VALID_DAEMON_WS_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const tempDirs: string[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const writeDaemonInfo = (daemonInfoPath: string, socketPath: string, mode = 0o600): void => {
  FS.writeFileSync(
    daemonInfoPath,
    JSON.stringify({
      pid: 42,
      wsPort: 3773,
      wsToken: VALID_DAEMON_WS_TOKEN,
      socketPath,
      startedAt: "2026-04-06T12:00:00.000Z",
    }),
    { encoding: "utf8", mode },
  );
  FS.chmodSync(daemonInfoPath, mode);
};

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readDaemonInfoFile", () => {
  it("reads a trusted daemon.json manifest", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-info-");
    const daemonInfoPath = Path.join(baseDir, "daemon.json");
    const socketPath = Path.join(baseDir, "forge.sock");
    writeDaemonInfo(daemonInfoPath, socketPath);

    const info = await Effect.runPromise(
      readDaemonInfoFile(daemonInfoPath, {
        expectedSocketPath: socketPath,
      }),
    );

    expect(info?.socketPath).toBe(socketPath);
    expect(info?.wsToken).toBe(VALID_DAEMON_WS_TOKEN);
  });

  it("rejects daemon.json when the socket path does not match the Forge socket", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-info-mismatch-");
    const daemonInfoPath = Path.join(baseDir, "daemon.json");
    const socketPath = Path.join(baseDir, "forge.sock");
    writeDaemonInfo(daemonInfoPath, "/tmp/other.sock");

    const info = await Effect.runPromise(
      readDaemonInfoFile(daemonInfoPath, {
        expectedSocketPath: socketPath,
      }),
    );

    expect(info).toBeUndefined();
  });

  it("rejects daemon.json when permissions are broader than owner-only", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-info-perms-");
    const daemonInfoPath = Path.join(baseDir, "daemon.json");
    const socketPath = Path.join(baseDir, "forge.sock");
    writeDaemonInfo(daemonInfoPath, socketPath, 0o644);

    const info = await Effect.runPromise(
      readDaemonInfoFile(daemonInfoPath, {
        expectedSocketPath: socketPath,
      }),
    );

    expect(info).toBeUndefined();
  });

  it("rejects daemon.json when required fields are empty", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-info-empty-fields-");
    const daemonInfoPath = Path.join(baseDir, "daemon.json");
    const socketPath = Path.join(baseDir, "forge.sock");
    FS.writeFileSync(
      daemonInfoPath,
      JSON.stringify({
        pid: 42,
        wsPort: 3773,
        wsToken: "",
        socketPath,
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    FS.chmodSync(daemonInfoPath, 0o600);

    const info = await Effect.runPromise(
      readDaemonInfoFile(daemonInfoPath, {
        expectedSocketPath: socketPath,
      }),
    );

    expect(info).toBeUndefined();
  });

  it("rejects daemon.json when wsPort is outside the TCP port range", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-info-invalid-port-");
    const daemonInfoPath = Path.join(baseDir, "daemon.json");
    const socketPath = Path.join(baseDir, "forge.sock");
    FS.writeFileSync(
      daemonInfoPath,
      JSON.stringify({
        pid: 42,
        wsPort: 70_000,
        wsToken: VALID_DAEMON_WS_TOKEN,
        socketPath,
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    FS.chmodSync(daemonInfoPath, 0o600);

    const info = await Effect.runPromise(
      readDaemonInfoFile(daemonInfoPath, {
        expectedSocketPath: socketPath,
      }),
    );

    expect(info).toBeUndefined();
  });

  it("rejects daemon.json when wsToken is not a 256-bit hex token", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-info-invalid-token-");
    const daemonInfoPath = Path.join(baseDir, "daemon.json");
    const socketPath = Path.join(baseDir, "forge.sock");
    FS.writeFileSync(
      daemonInfoPath,
      JSON.stringify({
        pid: 42,
        wsPort: 3773,
        wsToken: "secret-token",
        socketPath,
        startedAt: "2026-04-06T12:00:00.000Z",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    FS.chmodSync(daemonInfoPath, 0o600);

    const info = await Effect.runPromise(
      readDaemonInfoFile(daemonInfoPath, {
        expectedSocketPath: socketPath,
      }),
    );

    expect(info).toBeUndefined();
  });

  it("rejects daemon.json when startedAt is not a canonical ISO timestamp", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-info-invalid-started-at-");
    const daemonInfoPath = Path.join(baseDir, "daemon.json");
    const socketPath = Path.join(baseDir, "forge.sock");
    FS.writeFileSync(
      daemonInfoPath,
      JSON.stringify({
        pid: 42,
        wsPort: 3773,
        wsToken: VALID_DAEMON_WS_TOKEN,
        socketPath,
        startedAt: "2026-04-06T07:00:00-05:00",
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    FS.chmodSync(daemonInfoPath, 0o600);

    const info = await Effect.runPromise(
      readDaemonInfoFile(daemonInfoPath, {
        expectedSocketPath: socketPath,
      }),
    );

    expect(info).toBeUndefined();
  });

  it("rejects symlinked daemon.json manifests", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-info-symlink-");
    const daemonInfoPath = Path.join(baseDir, "daemon.json");
    const targetPath = Path.join(baseDir, "target-daemon.json");
    const socketPath = Path.join(baseDir, "forge.sock");

    writeDaemonInfo(targetPath, socketPath);
    FS.symlinkSync(targetPath, daemonInfoPath);

    const info = await Effect.runPromise(
      readDaemonInfoFile(daemonInfoPath, {
        expectedSocketPath: socketPath,
      }),
    );

    expect(info).toBeUndefined();
  });
});

describe("buildDaemonLaunchPlan", () => {
  it("clears inherited daemon auth token overrides so each daemon startup can rotate wsToken", () => {
    const originalAuthToken = process.env.FORGE_AUTH_TOKEN;
    const originalBootstrapFd = process.env.FORGE_BOOTSTRAP_FD;
    const originalMode = process.env.FORGE_MODE;
    const originalNoBrowser = process.env.FORGE_NO_BROWSER;

    process.env.FORGE_AUTH_TOKEN = "pinned-token";
    process.env.FORGE_BOOTSTRAP_FD = "9";
    process.env.FORGE_MODE = "desktop";
    process.env.FORGE_NO_BROWSER = "1";

    try {
      const plan = buildDaemonLaunchPlan({
        baseDir: "/Users/randy/.forge",
        entryScriptPath: "/repo/apps/server/dist/bin.mjs",
        execPath: "/usr/local/bin/node",
      });

      expect(plan).not.toBeInstanceOf(Error);
      expect(plan).toMatchObject({
        command: "/usr/local/bin/node",
        args: [
          "/repo/apps/server/dist/bin.mjs",
          "--mode",
          "daemon",
          "--no-browser",
          "--base-dir",
          "/Users/randy/.forge",
        ],
      });
      if (!(plan instanceof Error)) {
        expect(plan.env.FORGE_AUTH_TOKEN).toBeUndefined();
        expect(plan.env.FORGE_BOOTSTRAP_FD).toBeUndefined();
        expect(plan.env.FORGE_MODE).toBeUndefined();
        expect(plan.env.FORGE_NO_BROWSER).toBeUndefined();
      }
    } finally {
      if (originalAuthToken === undefined) {
        delete process.env.FORGE_AUTH_TOKEN;
      } else {
        process.env.FORGE_AUTH_TOKEN = originalAuthToken;
      }
      if (originalBootstrapFd === undefined) {
        delete process.env.FORGE_BOOTSTRAP_FD;
      } else {
        process.env.FORGE_BOOTSTRAP_FD = originalBootstrapFd;
      }
      if (originalMode === undefined) {
        delete process.env.FORGE_MODE;
      } else {
        process.env.FORGE_MODE = originalMode;
      }
      if (originalNoBrowser === undefined) {
        delete process.env.FORGE_NO_BROWSER;
      } else {
        process.env.FORGE_NO_BROWSER = originalNoBrowser;
      }
    }
  });
});

describe("sendDaemonRpc", () => {
  it("includes the daemon socket protocol version in each CLI request", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-rpc-");
    const socketPath = Path.join(baseDir, "forge.sock");
    const seenRequests: Array<Record<string, unknown>> = [];
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
        seenRequests.push(JSON.parse(line) as Record<string, unknown>);
        const id = seenRequests[0]?.id;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\n`);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const result = await Effect.runPromise(
        sendDaemonRpc<{ readonly ok: boolean }>({
          socketPath,
          method: "session.list",
        }),
      );

      expect(result).toEqual({ ok: true });
      expect(seenRequests).toHaveLength(1);
      expect(seenRequests[0]).toMatchObject({
        jsonrpc: "2.0",
        method: "session.list",
        forgeProtocolVersion: DAEMON_SOCKET_PROTOCOL_VERSION,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      FS.rmSync(socketPath, { force: true });
    }
  });

  it("rejects responses whose JSON-RPC id does not match the request", async () => {
    const baseDir = makeTempDir("forge-cli-daemon-rpc-mismatch-");
    const socketPath = Path.join(baseDir, "forge.sock");
    const server = Net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }

        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: "different-request-id",
            result: { ok: true },
          })}\n`,
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      await expect(
        Effect.runPromise(
          sendDaemonRpc<{ readonly ok: boolean }>({
            socketPath,
            method: "session.list",
          }),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("Received mismatched JSON-RPC response id."),
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      FS.rmSync(socketPath, { force: true });
    }
  });
});
