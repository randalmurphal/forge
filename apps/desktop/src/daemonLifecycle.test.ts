import * as FS from "node:fs";
import * as Http from "node:http";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { probeServerHealth } from "./connectionConfig";
import type { DesktopDaemonInfo } from "./daemonLifecycle";
import {
  buildDaemonWsUrl,
  buildDesktopWindowUrl,
  buildDetachedDaemonLaunchPlan,
  buildWslDaemonLaunchPlan,
  ensureDaemonConnection,
  extractProtocolUrlFromArgv,
  handleDesktopBeforeQuit,
  isDesktopUiReady,
  launchDetachedDaemon,
  parseSessionProtocolUrl,
  pingDaemon,
  registerProtocolClient,
  requestSingleInstanceOrQuit,
} from "./daemonLifecycle";

const daemonInfo: DesktopDaemonInfo = {
  pid: 42,
  wsPort: 3773,
  wsToken: "secret-token",
  socketPath: "/tmp/forge.sock",
  startedAt: "2026-04-06T12:00:00.000Z",
};

const tempDirs: string[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    FS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureDaemonConnection", () => {
  it("discovers an existing daemon without spawning a new process", async () => {
    const spawnDetachedDaemon = vi.fn(async () => undefined);
    const readDaemonInfo = vi.fn(async () => daemonInfo);
    const pingDaemon = vi.fn(async () => true);

    const result = await ensureDaemonConnection({
      paths: {
        baseDir: "/tmp/forge",
        socketPath: daemonInfo.socketPath,
        daemonInfoPath: "/tmp/forge/daemon.json",
      },
      spawnDetachedDaemon,
      readDaemonInfo,
      pingDaemon,
    });

    expect(result).toEqual({
      info: daemonInfo,
      source: "existing",
      wsUrl: "ws://127.0.0.1:3773/?token=secret-token",
    });
    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
  });

  it("waits for daemon.json from a responsive existing daemon instead of spawning a duplicate", async () => {
    const spawnDetachedDaemon = vi.fn(async () => undefined);
    const readDaemonInfo = vi
      .fn<(_: string) => Promise<DesktopDaemonInfo | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(daemonInfo);
    const pingDaemon = vi.fn(async () => true);

    const result = await ensureDaemonConnection({
      paths: {
        baseDir: "/tmp/forge",
        socketPath: daemonInfo.socketPath,
        daemonInfoPath: "/tmp/forge/daemon.json",
      },
      spawnDetachedDaemon,
      readDaemonInfo,
      pingDaemon,
      timeoutMs: 100,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({
      info: daemonInfo,
      source: "existing",
      wsUrl: "ws://127.0.0.1:3773/?token=secret-token",
    });
    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
  });

  it("waits for a manifest-backed live daemon to finish warming up instead of spawning a duplicate", async () => {
    const spawnDetachedDaemon = vi.fn(async () => undefined);
    const readDaemonInfo = vi
      .fn<(_: string) => Promise<DesktopDaemonInfo | undefined>>()
      .mockResolvedValue(daemonInfo);
    const pingDaemon = vi
      .fn<(_: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const isProcessAlive = vi.fn((pid: number) => pid === daemonInfo.pid);

    const result = await ensureDaemonConnection({
      paths: {
        baseDir: "/tmp/forge",
        socketPath: daemonInfo.socketPath,
        daemonInfoPath: "/tmp/forge/daemon.json",
      },
      spawnDetachedDaemon,
      readDaemonInfo,
      pingDaemon,
      isProcessAlive,
      timeoutMs: 100,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({
      info: daemonInfo,
      source: "existing",
      wsUrl: "ws://127.0.0.1:3773/?token=secret-token",
    });
    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
    expect(isProcessAlive).toHaveBeenCalledWith(daemonInfo.pid);
  });

  it("does not spawn a detached daemon when an existing socket stays responsive but daemon.json never appears", async () => {
    const spawnDetachedDaemon = vi.fn(async () => undefined);
    const readDaemonInfo = vi.fn(async () => undefined);
    const pingDaemon = vi.fn(async () => true);

    await expect(
      ensureDaemonConnection({
        paths: {
          baseDir: "/tmp/forge",
          socketPath: daemonInfo.socketPath,
          daemonInfoPath: "/tmp/forge/daemon.json",
        },
        spawnDetachedDaemon,
        readDaemonInfo,
        pingDaemon,
        timeoutMs: 25,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "Forge daemon is responding on /tmp/forge.sock, but /tmp/forge/daemon.json did not become available within 25ms.",
    );

    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
  });

  it("treats a manifest with a dead pid as stale and spawns a fresh daemon", async () => {
    const spawnDetachedDaemon = vi.fn(async () => undefined);
    const readDaemonInfo = vi.fn(async () => daemonInfo);
    const pingDaemon = vi.fn(async () => spawnDetachedDaemon.mock.calls.length > 0);
    const isProcessAlive = vi.fn(() => false);

    const result = await ensureDaemonConnection({
      paths: {
        baseDir: "/tmp/forge",
        socketPath: daemonInfo.socketPath,
        daemonInfoPath: "/tmp/forge/daemon.json",
      },
      spawnDetachedDaemon,
      readDaemonInfo,
      pingDaemon,
      isProcessAlive,
      timeoutMs: 100,
      pollIntervalMs: 0,
    });

    expect(result.source).toBe("spawned");
    expect(spawnDetachedDaemon).toHaveBeenCalledTimes(1);
    expect(isProcessAlive).toHaveBeenCalledWith(daemonInfo.pid);
  });

  it("spawns and waits for the daemon when none is running", async () => {
    const spawnDetachedDaemon = vi.fn(async () => undefined);
    const readDaemonInfo = vi
      .fn<(_: string) => Promise<DesktopDaemonInfo | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(daemonInfo);
    const pingDaemon = vi
      .fn<(_: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await ensureDaemonConnection({
      paths: {
        baseDir: "/tmp/forge",
        socketPath: daemonInfo.socketPath,
        daemonInfoPath: "/tmp/forge/daemon.json",
      },
      spawnDetachedDaemon,
      readDaemonInfo,
      pingDaemon,
      timeoutMs: 100,
      pollIntervalMs: 0,
    });

    expect(result.source).toBe("spawned");
    expect(result.wsUrl).toBe("ws://127.0.0.1:3773/?token=secret-token");
    expect(spawnDetachedDaemon).toHaveBeenCalledTimes(1);
  });
});

describe("daemon process launch", () => {
  it("builds a detached daemon launch plan for Electron-hosted startup", () => {
    const plan = buildDetachedDaemonLaunchPlan({
      baseDir: "/Users/randy/.forge",
      entryScriptPath: "/app/apps/server/dist/bin.mjs",
      cwd: "/Users/randy",
      execPath: "/Applications/Forge.app/Contents/MacOS/Forge",
      env: {
        FORGE_AUTH_TOKEN: "pinned-token",
        FORGE_BOOTSTRAP_FD: "3",
        FORGE_MODE: "desktop",
        FORGE_NO_BROWSER: "1",
        PATH: "/usr/bin",
      },
    });

    expect(plan).toEqual({
      command: "/Applications/Forge.app/Contents/MacOS/Forge",
      args: [
        "/app/apps/server/dist/bin.mjs",
        "--mode",
        "daemon",
        "--no-browser",
        "--base-dir",
        "/Users/randy/.forge",
      ],
      cwd: "/Users/randy",
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
  });

  it("launches the daemon as a detached ignored-stdio process and unreferences it", async () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }) as never);

    await launchDetachedDaemon(
      {
        command: "node",
        args: ["server.mjs"],
        cwd: "/tmp",
        env: { PATH: "/usr/bin" },
      },
      spawn,
    );

    expect(spawn).toHaveBeenCalledWith("node", ["server.mjs"], {
      cwd: "/tmp",
      env: { PATH: "/usr/bin" },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

describe("pingDaemon", () => {
  it("rejects symlinked daemon socket paths instead of following them", async () => {
    const baseDir = makeTempDir("forge-desktop-daemon-ping-symlink-");
    const targetSocketPath = Path.join(baseDir, "target.sock");
    const socketPath = Path.join(baseDir, "forge.sock");
    const server = Net.createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(targetSocketPath, () => {
        FS.chmodSync(targetSocketPath, 0o600);
        resolve();
      });
    });
    FS.symlinkSync(targetSocketPath, socketPath);

    try {
      await expect(pingDaemon(socketPath)).resolves.toBe(false);
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
      FS.rmSync(targetSocketPath, { force: true });
      FS.rmSync(socketPath, { force: true });
    }
  });

  it("rejects daemon socket paths whose permissions are broader than owner-only", async () => {
    const baseDir = makeTempDir("forge-desktop-daemon-ping-perms-");
    const socketPath = Path.join(baseDir, "forge.sock");
    const server = Net.createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        FS.chmodSync(socketPath, 0o666);
        resolve();
      });
    });

    try {
      await expect(pingDaemon(socketPath)).resolves.toBe(false);
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

  it("rejects ping responses whose JSON-RPC id does not match the request", async () => {
    const baseDir = makeTempDir("forge-desktop-daemon-ping-");
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
            result: { status: "ok" },
          })}\n`,
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        FS.chmodSync(socketPath, 0o600);
        resolve();
      });
    });

    try {
      await expect(pingDaemon(socketPath)).resolves.toBe(false);
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

describe("WSL daemon launch plan", () => {
  it("builds a launch plan that runs forge inside a WSL distro via wsl.exe", () => {
    const plan = buildWslDaemonLaunchPlan({
      distro: "Ubuntu",
      forgePath: "/usr/local/bin/forge",
      wslHome: "/home/randy",
      port: 4000,
      authToken: "abc123",
    });

    expect(plan.command).toBe("wsl.exe");
    expect(plan.args).toEqual([
      "-d",
      "Ubuntu",
      "--",
      "/usr/local/bin/forge",
      "--mode",
      "web",
      "--host",
      "0.0.0.0",
      "--no-browser",
      "--base-dir",
      "/home/randy/.forge",
      "--port",
      "4000",
      "--auth-token",
      "abc123",
    ]);
  });

  it("uses a custom baseDir when provided", () => {
    const plan = buildWslDaemonLaunchPlan({
      distro: "Debian",
      forgePath: "/usr/bin/forge",
      wslHome: "/home/user",
      port: 5000,
      authToken: "token",
      baseDir: "/custom/base",
    });

    expect(plan.args).toContain("--base-dir");
    const baseDirIndex = plan.args.indexOf("--base-dir");
    expect(plan.args[baseDirIndex + 1]).toBe("/custom/base");
  });

  it("appends FORGE_LOG_LEVEL to existing WSLENV", () => {
    const original = process.env.WSLENV;
    process.env.WSLENV = "PATH/l";

    try {
      const plan = buildWslDaemonLaunchPlan({
        distro: "Ubuntu",
        forgePath: "/usr/local/bin/forge",
        wslHome: "/home/randy",
        port: 4000,
        authToken: "abc123",
      });

      expect(plan.env.WSLENV).toBe("PATH/l:FORGE_LOG_LEVEL");
    } finally {
      if (original === undefined) {
        delete process.env.WSLENV;
      } else {
        process.env.WSLENV = original;
      }
    }
  });

  it("sets WSLENV to just FORGE_LOG_LEVEL when WSLENV is not set", () => {
    const original = process.env.WSLENV;
    delete process.env.WSLENV;

    try {
      const plan = buildWslDaemonLaunchPlan({
        distro: "Ubuntu",
        forgePath: "/usr/local/bin/forge",
        wslHome: "/home/randy",
        port: 4000,
        authToken: "abc123",
      });

      expect(plan.env.WSLENV).toBe("FORGE_LOG_LEVEL");
    } finally {
      if (original !== undefined) {
        process.env.WSLENV = original;
      }
    }
  });

  it("converts the port number to a string in args", () => {
    const plan = buildWslDaemonLaunchPlan({
      distro: "Ubuntu",
      forgePath: "/usr/local/bin/forge",
      wslHome: "/home/randy",
      port: 9999,
      authToken: "token",
    });

    const portIndex = plan.args.indexOf("--port");
    expect(portIndex).toBeGreaterThan(-1);
    expect(plan.args[portIndex + 1]).toBe("9999");
    expect(typeof plan.args[portIndex + 1]).toBe("string");
  });
});

describe("probeServerHealth", () => {
  it("resolves true when a server responds with 200 on /health", async () => {
    const server = Http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to get server port"));
        }
      });
    });

    try {
      await expect(probeServerHealth("127.0.0.1", port)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("resolves false when a server responds with a non-200 status", async () => {
    const server = Http.createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to get server port"));
        }
      });
    });

    try {
      await expect(probeServerHealth("127.0.0.1", port)).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("resolves false when nothing is listening on the port", async () => {
    await expect(probeServerHealth("127.0.0.1", 1, 500)).resolves.toBe(false);
  });
});

describe("single-instance and protocol helpers", () => {
  it("quits when the single-instance lock cannot be acquired", () => {
    const quit = vi.fn();
    const acquired = requestSingleInstanceOrQuit({
      requestSingleInstanceLock: () => false,
      quit,
    });

    expect(acquired).toBe(false);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("registers Forge as the default protocol client", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    const registered = registerProtocolClient(
      {
        setAsDefaultProtocolClient,
      },
      "forge",
    );

    expect(registered).toBe(true);
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith("forge");
  });

  it("extracts and parses forge session deep links", () => {
    const protocolUrl = extractProtocolUrlFromArgv(
      ["Forge", "--flag", "forge://session/thread-123"],
      "forge",
    );

    expect(protocolUrl).toBe("forge://session/thread-123");
    expect(parseSessionProtocolUrl(protocolUrl!, "forge")).toEqual({
      threadId: "thread-123",
    });
  });
});

describe("desktop UI readiness", () => {
  it("requires the app to be ready and the daemon websocket URL to exist", () => {
    expect(
      isDesktopUiReady({
        appReady: true,
        backendWsUrl: "ws://127.0.0.1:3773/?token=secret-token",
      }),
    ).toBe(true);
    expect(
      isDesktopUiReady({
        appReady: false,
        backendWsUrl: "ws://127.0.0.1:3773/?token=secret-token",
      }),
    ).toBe(false);
    expect(
      isDesktopUiReady({
        appReady: true,
        backendWsUrl: "   ",
      }),
    ).toBe(false);
  });
});

describe("desktop URL helpers", () => {
  it("builds the daemon websocket URL from daemon.json data", () => {
    expect(buildDaemonWsUrl(daemonInfo)).toBe("ws://127.0.0.1:3773/?token=secret-token");
  });

  it("routes window navigation through the desktop scheme or dev server hash", () => {
    expect(buildDesktopWindowUrl({ scheme: "forge", threadId: "thread-123" })).toBe(
      "forge://app/index.html#/thread-123",
    );
    expect(
      buildDesktopWindowUrl({
        scheme: "forge",
        threadId: "thread-123",
        devServerUrl: "http://127.0.0.1:5173/",
      }),
    ).toBe("http://127.0.0.1:5173/#/thread-123");
  });
});

describe("handleDesktopBeforeQuit", () => {
  it("marks the app as quitting without attempting to stop the daemon", () => {
    const markQuitting = vi.fn();
    const clearUpdatePollTimer = vi.fn();
    const restoreStdIoCapture = vi.fn();
    const stopDaemon = vi.fn();

    handleDesktopBeforeQuit({
      markQuitting,
      clearUpdatePollTimer,
      restoreStdIoCapture,
      stopDaemon,
    });

    expect(markQuitting).toHaveBeenCalledTimes(1);
    expect(clearUpdatePollTimer).toHaveBeenCalledTimes(1);
    expect(restoreStdIoCapture).toHaveBeenCalledTimes(1);
    expect(stopDaemon).not.toHaveBeenCalled();
  });
});
