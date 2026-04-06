import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { readDaemonInfoFile } from "./cliClient.ts";

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
      wsToken: "secret-token",
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
    expect(info?.wsToken).toBe("secret-token");
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
});
