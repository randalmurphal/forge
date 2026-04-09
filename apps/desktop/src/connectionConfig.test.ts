import * as FS from "node:fs";
import * as Http from "node:http";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearConnectionConfig,
  generateAuthToken,
  probeServerHealth,
  readConnectionConfig,
  resolveConnectionMode,
  validateWsUrl,
  writeConnectionConfig,
  type ConnectionConfig,
} from "./connectionConfig";

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

// ---------------------------------------------------------------------------
// validateWsUrl
// ---------------------------------------------------------------------------

describe("validateWsUrl", () => {
  it("accepts a valid ws:// URL with a port", () => {
    const result = validateWsUrl("ws://localhost:3773/ws");
    expect(result).toEqual({ valid: true, url: "ws://localhost:3773/ws" });
  });

  it("accepts a valid wss:// URL with a port", () => {
    const result = validateWsUrl("wss://example.com:443/ws");
    expect(result).toEqual({ valid: true, url: "wss://example.com:443/ws" });
  });

  it("accepts a ws:// URL with a pathname but no port", () => {
    const result = validateWsUrl("ws://example.com/some/path");
    expect(result).toEqual({ valid: true, url: "ws://example.com/some/path" });
  });

  it("trims whitespace from the URL", () => {
    const result = validateWsUrl("  ws://localhost:3773/ws  ");
    expect(result).toEqual({ valid: true, url: "ws://localhost:3773/ws" });
  });

  it("rejects an empty string", () => {
    const result = validateWsUrl("");
    expect(result).toEqual({ valid: false, error: "URL is empty" });
  });

  it("rejects a whitespace-only string", () => {
    const result = validateWsUrl("   ");
    expect(result).toEqual({ valid: false, error: "URL is empty" });
  });

  it("rejects an unparseable URL", () => {
    const result = validateWsUrl("not-a-url");
    expect(result).toEqual({ valid: false, error: "Invalid URL format" });
  });

  it("rejects http:// protocol", () => {
    const result = validateWsUrl("http://localhost:3773");
    expect(result.valid).toBe(false);
    expect((result as { valid: false; error: string }).error).toContain("Protocol must be ws://");
  });

  it("rejects https:// protocol", () => {
    const result = validateWsUrl("https://localhost:3773");
    expect(result.valid).toBe(false);
  });

  it("rejects a URL without a port or meaningful path", () => {
    const result = validateWsUrl("ws://localhost");
    expect(result).toEqual({ valid: false, error: "URL must include a port or a path" });
  });

  it("rejects a URL with ws://localhost/ (root path only, no port)", () => {
    const result = validateWsUrl("ws://localhost/");
    expect(result).toEqual({ valid: false, error: "URL must include a port or a path" });
  });

  it("accepts port 1 (lower boundary)", () => {
    const result = validateWsUrl("ws://localhost:1");
    expect(result.valid).toBe(true);
  });

  it("accepts port 65535 (upper boundary)", () => {
    const result = validateWsUrl("ws://localhost:65535");
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readConnectionConfig / writeConnectionConfig / clearConnectionConfig
// ---------------------------------------------------------------------------

describe("readConnectionConfig", () => {
  it("returns undefined when no config file exists", () => {
    const dir = makeTempDir("forge-conn-no-file-");
    expect(readConnectionConfig(dir)).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    const dir = makeTempDir("forge-conn-bad-json-");
    FS.writeFileSync(Path.join(dir, "connection.json"), "not json", "utf8");
    expect(readConnectionConfig(dir)).toBeUndefined();
  });

  it("returns undefined for a non-object value", () => {
    const dir = makeTempDir("forge-conn-non-object-");
    FS.writeFileSync(Path.join(dir, "connection.json"), '"just a string"', "utf8");
    expect(readConnectionConfig(dir)).toBeUndefined();
  });

  it("returns undefined for null JSON", () => {
    const dir = makeTempDir("forge-conn-null-");
    FS.writeFileSync(Path.join(dir, "connection.json"), "null", "utf8");
    expect(readConnectionConfig(dir)).toBeUndefined();
  });

  it("returns undefined when mode is missing", () => {
    const dir = makeTempDir("forge-conn-no-mode-");
    FS.writeFileSync(Path.join(dir, "connection.json"), JSON.stringify({ foo: "bar" }), "utf8");
    expect(readConnectionConfig(dir)).toBeUndefined();
  });

  it("returns undefined when mode is invalid", () => {
    const dir = makeTempDir("forge-conn-bad-mode-");
    FS.writeFileSync(Path.join(dir, "connection.json"), JSON.stringify({ mode: "ssh" }), "utf8");
    expect(readConnectionConfig(dir)).toBeUndefined();
  });

  it("reads a valid local config", () => {
    const dir = makeTempDir("forge-conn-local-");
    FS.writeFileSync(Path.join(dir, "connection.json"), JSON.stringify({ mode: "local" }), "utf8");
    expect(readConnectionConfig(dir)).toEqual({ mode: "local" });
  });

  it("reads a valid wsl config with optional fields", () => {
    const dir = makeTempDir("forge-conn-wsl-");
    const config = { mode: "wsl", wslDistro: "Ubuntu", wslForgePath: "/usr/local/bin/forge" };
    FS.writeFileSync(Path.join(dir, "connection.json"), JSON.stringify(config), "utf8");
    expect(readConnectionConfig(dir)).toEqual(config);
  });

  it("reads a valid external config with optional fields", () => {
    const dir = makeTempDir("forge-conn-external-");
    const config = {
      mode: "external",
      externalWsUrl: "ws://remote:3773/ws",
      externalLabel: "dev server",
    };
    FS.writeFileSync(Path.join(dir, "connection.json"), JSON.stringify(config), "utf8");
    expect(readConnectionConfig(dir)).toEqual(config);
  });

  it("ignores non-string optional fields", () => {
    const dir = makeTempDir("forge-conn-bad-optional-");
    const config = { mode: "wsl", wslDistro: 42, wslForgePath: true };
    FS.writeFileSync(Path.join(dir, "connection.json"), JSON.stringify(config), "utf8");
    expect(readConnectionConfig(dir)).toEqual({ mode: "wsl" });
  });

  it("reads wslPort and wslAuthToken from valid WSL config", () => {
    const dir = makeTempDir("forge-conn-wsl-port-token-");
    const config = {
      mode: "wsl",
      wslDistro: "Ubuntu",
      wslForgePath: "/usr/local/bin/forge",
      wslPort: 4000,
      wslAuthToken: "abc123hextoken",
    };
    FS.writeFileSync(Path.join(dir, "connection.json"), JSON.stringify(config), "utf8");
    expect(readConnectionConfig(dir)).toEqual(config);
  });

  it("ignores non-number wslPort", () => {
    const dir = makeTempDir("forge-conn-wsl-bad-port-");
    const config = { mode: "wsl", wslPort: "not-a-number" };
    FS.writeFileSync(Path.join(dir, "connection.json"), JSON.stringify(config), "utf8");
    expect(readConnectionConfig(dir)).toEqual({ mode: "wsl" });
  });

  it("ignores non-finite wslPort (NaN, Infinity)", () => {
    const dir = makeTempDir("forge-conn-wsl-nan-port-");
    // JSON.stringify converts NaN/Infinity to null, so test with a direct write
    FS.writeFileSync(Path.join(dir, "connection.json"), '{"mode":"wsl","wslPort":null}', "utf8");
    expect(readConnectionConfig(dir)).toEqual({ mode: "wsl" });
  });

  it("ignores non-string wslAuthToken", () => {
    const dir = makeTempDir("forge-conn-wsl-bad-token-");
    const config = { mode: "wsl", wslAuthToken: 12345 };
    FS.writeFileSync(Path.join(dir, "connection.json"), JSON.stringify(config), "utf8");
    expect(readConnectionConfig(dir)).toEqual({ mode: "wsl" });
  });
});

describe("writeConnectionConfig", () => {
  it("writes a config file and can be read back", () => {
    const dir = makeTempDir("forge-conn-write-");
    const config: ConnectionConfig = {
      mode: "wsl",
      wslDistro: "Ubuntu",
      wslForgePath: "/usr/local/bin/forge",
    };

    writeConnectionConfig(dir, config);

    const result = readConnectionConfig(dir);
    expect(result).toEqual(config);
  });

  it("persists wslPort and wslAuthToken through round-trip", () => {
    const dir = makeTempDir("forge-conn-write-wsl-full-");
    const config: ConnectionConfig = {
      mode: "wsl",
      wslDistro: "Ubuntu",
      wslForgePath: "/usr/local/bin/forge",
      wslPort: 4000,
      wslAuthToken: "abc123hextoken",
    };

    writeConnectionConfig(dir, config);

    const result = readConnectionConfig(dir);
    expect(result).toEqual(config);
    expect(result!.wslPort).toBe(4000);
    expect(result!.wslAuthToken).toBe("abc123hextoken");
  });

  it("creates the parent directory if it does not exist", () => {
    const dir = makeTempDir("forge-conn-write-nested-");
    const nested = Path.join(dir, "sub", "dir");

    writeConnectionConfig(nested, { mode: "local" });

    // The file should be at nested/connection.json
    expect(readConnectionConfig(nested)).toEqual({ mode: "local" });
  });
});

describe("clearConnectionConfig", () => {
  it("removes an existing config file", () => {
    const dir = makeTempDir("forge-conn-clear-");
    writeConnectionConfig(dir, { mode: "local" });
    expect(readConnectionConfig(dir)).toBeDefined();

    clearConnectionConfig(dir);
    expect(readConnectionConfig(dir)).toBeUndefined();
  });

  it("does nothing when no config file exists", () => {
    const dir = makeTempDir("forge-conn-clear-missing-");
    expect(() => clearConnectionConfig(dir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveConnectionMode
// ---------------------------------------------------------------------------

describe("resolveConnectionMode", () => {
  it("returns external mode when FORGE_WS_URL is set", () => {
    const dir = makeTempDir("forge-conn-resolve-env-");
    const result = resolveConnectionMode({ FORGE_WS_URL: "ws://remote:3773/ws" }, dir);
    expect(result).toEqual({
      type: "external",
      config: { mode: "external", externalWsUrl: "ws://remote:3773/ws" },
    });
  });

  it("ignores empty FORGE_WS_URL", () => {
    const dir = makeTempDir("forge-conn-resolve-empty-env-");
    const result = resolveConnectionMode({ FORGE_WS_URL: "  " }, dir);
    // Should fall through to saved config or platform default
    expect(result.type).not.toBe("external");
  });

  it("returns saved config when connection.json exists", () => {
    const dir = makeTempDir("forge-conn-resolve-saved-");
    writeConnectionConfig(dir, { mode: "wsl", wslDistro: "Ubuntu" });

    const result = resolveConnectionMode({}, dir);
    expect(result).toEqual({
      type: "wsl",
      config: { mode: "wsl", wslDistro: "Ubuntu" },
    });
  });

  it("returns saved WSL config including wslPort and wslAuthToken", () => {
    const dir = makeTempDir("forge-conn-resolve-wsl-full-");
    writeConnectionConfig(dir, {
      mode: "wsl",
      wslDistro: "Ubuntu",
      wslPort: 4000,
      wslAuthToken: "token-hex",
    });

    const result = resolveConnectionMode({}, dir);
    expect(result.type).toBe("wsl");
    expect(result.config!.wslPort).toBe(4000);
    expect(result.config!.wslAuthToken).toBe("token-hex");
  });

  it("falls back to local when no env, no config, and not win32", () => {
    const dir = makeTempDir("forge-conn-resolve-default-");
    // On non-win32 platforms (which our test runner is), this should return local
    if (process.platform !== "win32") {
      const result = resolveConnectionMode({}, dir);
      expect(result).toEqual({ type: "local" });
    }
  });
});

// ---------------------------------------------------------------------------
// generateAuthToken
// ---------------------------------------------------------------------------

describe("generateAuthToken", () => {
  it("generates a 64-character hex string", () => {
    const token = generateAuthToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens on successive calls", () => {
    const a = generateAuthToken();
    const b = generateAuthToken();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// probeServerHealth
// ---------------------------------------------------------------------------

describe("probeServerHealth", () => {
  it("resolves true when a local server responds with 200 on /health", async () => {
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

  it("resolves false when the server responds with a non-200 status", async () => {
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
    // Port 1 is almost certainly not in use and will ECONNREFUSED
    await expect(probeServerHealth("127.0.0.1", 1, 500)).resolves.toBe(false);
  });
});
