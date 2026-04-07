/**
 * Reads Claude OAuth credentials from platform-appropriate storage and provides
 * a cached, auto-refreshing token resolver.
 *
 * - macOS: reads from Keychain ("Claude Code-credentials"), falls back to file
 * - Linux: reads from ~/.claude/.credentials.json
 *
 * The resolved token is injected as CLAUDE_CODE_OAUTH_TOKEN into the env passed
 * to the Claude Agent SDK, bypassing the CLI's internal OAuth flow which may be
 * rejected by the Anthropic API for certain org configurations.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";

import { Data, Effect, Ref } from "effect";

// ── Types ──────────────────────────────────────────────────────────

class OAuthRefreshError extends Data.TaggedError("OAuthRefreshError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface ClaudeOAuthCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number; // unix-ms
  readonly scopes: ReadonlyArray<string>;
  readonly subscriptionType: string | undefined;
  readonly rateLimitTier: string | undefined;
}

interface CredentialFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: ReadonlyArray<string>;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

// ── Constants ──────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const EXPIRY_BUFFER_MS = 300_000; // 5 minutes

function credentialsFilePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

// ── Parsing ────────────────────────────────────────────────────────

function maybeDecodeHex(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    try {
      return Buffer.from(trimmed, "hex").toString("utf-8");
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function parseCredentials(raw: string): ClaudeOAuthCredentials | undefined {
  try {
    const data = JSON.parse(maybeDecodeHex(raw)) as CredentialFile;
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken || !oauth.refreshToken || !oauth.expiresAt) return undefined;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes ?? [],
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
    };
  } catch {
    return undefined;
  }
}

// ── Storage Reads ──────────────────────────────────────────────────

function readFromKeychain(): ClaudeOAuthCredentials | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const account = process.env.USER ?? userInfo().username;
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      { encoding: "utf-8", timeout: 10_000 },
    );
    return parseCredentials(raw);
  } catch {
    return undefined;
  }
}

function readFromFile(): ClaudeOAuthCredentials | undefined {
  try {
    const raw = readFileSync(credentialsFilePath(), "utf-8");
    return parseCredentials(raw);
  } catch {
    return undefined;
  }
}

function readCredentials(): ClaudeOAuthCredentials | undefined {
  // Read file first — it has the latest tokens after any refresh we've done.
  // Fall back to keychain (macOS) only if the file doesn't have valid credentials.
  return readFromFile() ?? readFromKeychain();
}

// ── Token Refresh ──────────────────────────────────────────────────

function isExpiringSoon(creds: ClaudeOAuthCredentials): boolean {
  return Date.now() + EXPIRY_BUFFER_MS >= creds.expiresAt;
}

const refreshToken = (creds: ClaudeOAuthCredentials) =>
  Effect.tryPromise({
    try: async () => {
      const resp = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: creds.refreshToken,
          client_id: OAUTH_CLIENT_ID,
          scope: creds.scopes.join(" "),
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`OAuth refresh failed: ${resp.status} ${body}`);
      }
      const data = (await resp.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope?: string;
      };
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
        scopes: data.scope ? data.scope.split(" ").filter(Boolean) : creds.scopes,
        subscriptionType: creds.subscriptionType,
        rateLimitTier: creds.rateLimitTier,
      } satisfies ClaudeOAuthCredentials;
    },
    catch: (cause) =>
      new OAuthRefreshError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

function saveCredentialsToFile(creds: ClaudeOAuthCredentials): void {
  const filePath = credentialsFilePath();
  try {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      // File doesn't exist or can't be parsed — start fresh.
    }
    existing.claudeAiOauth = {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      scopes: creds.scopes,
      ...(creds.subscriptionType ? { subscriptionType: creds.subscriptionType } : {}),
      ...(creds.rateLimitTier ? { rateLimitTier: creds.rateLimitTier } : {}),
    };
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  } catch {
    // Write-back failure is non-fatal — the token is still valid in memory.
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Create a cached OAuth token resolver. Returns an Effect that yields
 * a fresh access token string, or undefined if no OAuth credentials exist
 * (e.g. user is on API key auth).
 *
 * The resolver reads from storage once, caches the result, and only
 * re-reads/refreshes when the token is about to expire.
 */
export const makeClaudeOAuthTokenResolver = Effect.gen(function* () {
  const cache = yield* Ref.make<ClaudeOAuthCredentials | undefined>(undefined);

  const getToken = Effect.gen(function* () {
    // If env already has the token (e.g. running inside Claude Code), use it.
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }

    const cached = yield* Ref.get(cache);

    if (cached && !isExpiringSoon(cached)) {
      return cached.accessToken;
    }

    const stored = cached ?? readCredentials();
    if (!stored) return undefined;

    // Use the stored token directly if it hasn't expired yet.
    if (!isExpiringSoon(stored)) {
      yield* Ref.set(cache, stored);
      return stored.accessToken;
    }

    // Token is about to expire — refresh it.
    const refreshed = yield* refreshToken(stored).pipe(
      Effect.tap((newCreds) =>
        Effect.sync(() => {
          saveCredentialsToFile(newCreds);
        }),
      ),
      Effect.tapError((err: OAuthRefreshError) =>
        Effect.logWarning(`Claude OAuth token refresh failed: ${err.message}`),
      ),
      Effect.orElseSucceed(() => stored),
    );

    yield* Ref.set(cache, refreshed);
    return refreshed.accessToken;
  });

  return { getToken };
});
