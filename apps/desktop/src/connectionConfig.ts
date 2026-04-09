import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";

export interface ConnectionConfig {
  readonly mode: "local" | "wsl" | "external";
  readonly wslDistro?: string;
  readonly wslForgePath?: string;
  readonly wslPort?: number;
  readonly wslAuthToken?: string;
  readonly externalWsUrl?: string;
  readonly externalLabel?: string;
}

export interface ResolvedConnectionMode {
  readonly type: "local" | "wsl" | "external";
  readonly config?: ConnectionConfig;
}

export interface ConnectionTestResult {
  readonly success: boolean;
  readonly error?: string;
}

const CONNECTION_CONFIG_FILENAME = "connection.json";
const VALID_MODES = new Set(["local", "wsl", "external"]);

/**
 * Determine the connection mode based on environment and saved config.
 *
 * Priority:
 * 1. FORGE_WS_URL env var → external mode
 * 2. connection.json → saved mode
 * 3. win32 → wsl (needs setup)
 * 4. Default → local daemon
 */
export function resolveConnectionMode(
  env: NodeJS.ProcessEnv,
  userDataPath: string,
): ResolvedConnectionMode {
  const envWsUrl = env.FORGE_WS_URL?.trim();
  if (envWsUrl && envWsUrl.length > 0) {
    return {
      type: "external",
      config: { mode: "external", externalWsUrl: envWsUrl },
    };
  }

  const saved = readConnectionConfig(userDataPath);
  if (saved !== undefined) {
    return { type: saved.mode, config: saved };
  }

  if (process.platform === "win32") {
    return { type: "wsl" };
  }

  return { type: "local" };
}

/**
 * Read and validate connection.json from the user data directory.
 * Returns undefined if the file doesn't exist, can't be parsed, or has an invalid mode.
 */
export function readConnectionConfig(userDataPath: string): ConnectionConfig | undefined {
  const configPath = join(userDataPath, CONNECTION_CONFIG_FILENAME);
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (parsed === null || typeof parsed !== "object") return undefined;

    const obj = parsed as Record<string, unknown>;
    const mode = obj.mode;
    if (typeof mode !== "string" || !VALID_MODES.has(mode)) return undefined;

    return {
      mode: mode as ConnectionConfig["mode"],
      ...(typeof obj.wslDistro === "string" ? { wslDistro: obj.wslDistro } : {}),
      ...(typeof obj.wslForgePath === "string" ? { wslForgePath: obj.wslForgePath } : {}),
      ...(typeof obj.wslPort === "number" && Number.isFinite(obj.wslPort)
        ? { wslPort: obj.wslPort }
        : {}),
      ...(typeof obj.wslAuthToken === "string" ? { wslAuthToken: obj.wslAuthToken } : {}),
      ...(typeof obj.externalWsUrl === "string" ? { externalWsUrl: obj.externalWsUrl } : {}),
      ...(typeof obj.externalLabel === "string" ? { externalLabel: obj.externalLabel } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Persist a connection config to connection.json.
 * Creates the parent directory if it doesn't exist.
 */
export function writeConnectionConfig(userDataPath: string, config: ConnectionConfig): void {
  const configPath = join(userDataPath, CONNECTION_CONFIG_FILENAME);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Delete connection.json if it exists. Ignores missing-file errors.
 */
export function clearConnectionConfig(userDataPath: string): void {
  const configPath = join(userDataPath, CONNECTION_CONFIG_FILENAME);
  if (!existsSync(configPath)) return;

  try {
    unlinkSync(configPath);
  } catch (error) {
    // Only swallow ENOENT (race: file removed between existsSync and unlinkSync)
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/**
 * Validate a WebSocket URL string.
 * Must be ws:// or wss:// with a valid host, and either a port or a pathname.
 */
export function validateWsUrl(
  rawUrl: string,
):
  | { readonly valid: true; readonly url: string }
  | { readonly valid: false; readonly error: string } {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "URL is empty" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { valid: false, error: `Protocol must be ws:// or wss://, got ${parsed.protocol}` };
  }

  if (!parsed.hostname || parsed.hostname.length === 0) {
    return { valid: false, error: "URL must include a hostname" };
  }

  const hasPort = parsed.port.length > 0;
  const hasPathname = parsed.pathname.length > 0 && parsed.pathname !== "/";

  if (!hasPort && !hasPathname) {
    return { valid: false, error: "URL must include a port or a path" };
  }

  if (hasPort) {
    const port = parseInt(parsed.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return { valid: false, error: `Port must be between 1 and 65535, got ${parsed.port}` };
    }
  }

  return { valid: true, url: trimmed };
}

/**
 * Probe a server's /health endpoint via HTTP GET.
 * Returns true only if the server responds with 200 OK within the timeout.
 */
export function probeServerHealth(
  host: string,
  port: number,
  timeoutMs = 5_000,
  useHttps = false,
): Promise<boolean> {
  const requestFn = useHttps ? httpsRequest : httpRequest;
  return new Promise<boolean>((resolve) => {
    const req = requestFn(
      {
        hostname: host,
        port,
        path: "/health",
        method: "GET",
        timeout: timeoutMs,
        ...(useHttps ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        // Consume the response body so the socket can be freed
        res.resume();
        resolve(res.statusCode === 200);
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });

    req.on("error", () => {
      resolve(false);
    });

    req.end();
  });
}

/**
 * Generate a random auth token (32 bytes → 64 hex chars).
 * Same format as daemon mode uses.
 */
export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}
