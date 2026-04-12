import { ThreadId } from "@forgetools/contracts";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_SESSION_ERROR_MATCHERS,
  CODEX_SESSION_ERROR_MATCHERS,
  toMessage,
  toRequestError,
  toSessionError,
} from "./adapterUtils.ts";
import { ProviderAdapterRequestError } from "./Errors.ts";

const THREAD_ID = ThreadId.makeUnsafe("test-thread-id");

// ── toMessage ──────────────────────────────────────────────────────────

describe("toMessage", () => {
  it("returns the Error message when cause is an Error with a non-empty message", () => {
    expect(toMessage(new Error("something broke"), "default")).toBe("something broke");
  });

  it("returns the fallback when cause is an Error with an empty message", () => {
    expect(toMessage(new Error(""), "default")).toBe("default");
  });

  it("returns the fallback when cause is not an Error", () => {
    expect(toMessage({ message: "not an Error" }, "default")).toBe("default");
  });

  it("returns the fallback when cause is a string", () => {
    expect(toMessage("some string cause", "default")).toBe("default");
  });

  it("returns the fallback when cause is null", () => {
    expect(toMessage(null, "default")).toBe("default");
  });

  it("returns the fallback when cause is undefined", () => {
    expect(toMessage(undefined, "default")).toBe("default");
  });
});

// ── toSessionError with CLAUDE_SESSION_ERROR_MATCHERS ──────────────────

describe("toSessionError (Claude matchers)", () => {
  const matchers = CLAUDE_SESSION_ERROR_MATCHERS;

  it("returns SessionNotFoundError for 'unknown session'", () => {
    const cause = new Error("unknown session abc-123");
    const result = toSessionError("claudeAgent", THREAD_ID, cause, matchers);

    expect(result?._tag).toBe("ProviderAdapterSessionNotFoundError");
    expect(result!.provider).toBe("claudeAgent");
    expect(result!.threadId).toBe(THREAD_ID);
  });

  it("returns SessionNotFoundError for 'not found'", () => {
    const cause = new Error("session not found");
    const result = toSessionError("claudeAgent", THREAD_ID, cause, matchers);

    expect(result?._tag).toBe("ProviderAdapterSessionNotFoundError");
  });

  it("returns SessionClosedError for 'closed'", () => {
    const cause = new Error("session is closed");
    const result = toSessionError("claudeAgent", THREAD_ID, cause, matchers);

    expect(result?._tag).toBe("ProviderAdapterSessionClosedError");
    expect(result!.provider).toBe("claudeAgent");
    expect(result!.threadId).toBe(THREAD_ID);
  });

  it("returns undefined for an unrelated error message", () => {
    const cause = new Error("connection timeout");
    const result = toSessionError("claudeAgent", THREAD_ID, cause, matchers);

    expect(result).toBeUndefined();
  });

  it("returns undefined for a non-Error cause", () => {
    const result = toSessionError("claudeAgent", THREAD_ID, "just a string", matchers);

    expect(result).toBeUndefined();
  });

  it("matches case-insensitively", () => {
    const cause = new Error("UNKNOWN SESSION xyz");
    const result = toSessionError("claudeAgent", THREAD_ID, cause, matchers);

    expect(result?._tag).toBe("ProviderAdapterSessionNotFoundError");
  });
});

// ── toSessionError with CODEX_SESSION_ERROR_MATCHERS ───────────────────

describe("toSessionError (Codex matchers)", () => {
  const matchers = CODEX_SESSION_ERROR_MATCHERS;

  it("returns SessionNotFoundError for 'unknown session'", () => {
    const cause = new Error("unknown session abc-123");
    const result = toSessionError("codex", THREAD_ID, cause, matchers);

    expect(result?._tag).toBe("ProviderAdapterSessionNotFoundError");
    expect(result!.provider).toBe("codex");
  });

  it("returns SessionNotFoundError for 'unknown provider session'", () => {
    const cause = new Error("unknown provider session for thread");
    const result = toSessionError("codex", THREAD_ID, cause, matchers);

    expect(result?._tag).toBe("ProviderAdapterSessionNotFoundError");
  });

  it("returns SessionClosedError for 'session is closed'", () => {
    const cause = new Error("session is closed");
    const result = toSessionError("codex", THREAD_ID, cause, matchers);

    expect(result?._tag).toBe("ProviderAdapterSessionClosedError");
    expect(result!.provider).toBe("codex");
  });

  it("does NOT match bare 'closed' without 'session is' prefix", () => {
    const cause = new Error("connection closed unexpectedly");
    const result = toSessionError("codex", THREAD_ID, cause, matchers);

    expect(result).toBeUndefined();
  });

  it("does NOT match 'not found' without 'unknown session' prefix", () => {
    const cause = new Error("resource not found");
    const result = toSessionError("codex", THREAD_ID, cause, matchers);

    expect(result).toBeUndefined();
  });

  it("returns undefined for an unrelated error message", () => {
    const cause = new Error("connection timeout");
    const result = toSessionError("codex", THREAD_ID, cause, matchers);

    expect(result).toBeUndefined();
  });

  it("returns undefined for a non-Error cause", () => {
    const result = toSessionError("codex", THREAD_ID, 42, matchers);

    expect(result).toBeUndefined();
  });
});

// ── toRequestError ─────────────────────────────────────────────────────

describe("toRequestError", () => {
  it("returns a session error when the cause matches a session pattern", () => {
    const cause = new Error("unknown session abc-123");
    const result = toRequestError(
      "codex",
      THREAD_ID,
      "sendTurn",
      cause,
      CODEX_SESSION_ERROR_MATCHERS,
    );

    expect(result?._tag).toBe("ProviderAdapterSessionNotFoundError");
  });

  it("returns ProviderAdapterRequestError for non-session errors", () => {
    const cause = new Error("connection refused");
    const result = toRequestError(
      "codex",
      THREAD_ID,
      "sendTurn",
      cause,
      CODEX_SESSION_ERROR_MATCHERS,
    );

    expect(result._tag).toBe("ProviderAdapterRequestError");
    const requestError = result as ProviderAdapterRequestError;
    expect(requestError.provider).toBe("codex");
    expect(requestError.method).toBe("sendTurn");
    expect(requestError.detail).toBe("connection refused");
  });

  it("uses method-derived fallback detail when cause is not an Error", () => {
    const result = toRequestError(
      "codex",
      THREAD_ID,
      "getHistory",
      null,
      CODEX_SESSION_ERROR_MATCHERS,
    );

    expect(result._tag).toBe("ProviderAdapterRequestError");
    expect((result as ProviderAdapterRequestError).detail).toBe("getHistory failed");
  });

  it("passes the provider string through correctly", () => {
    const result = toRequestError(
      "claudeAgent",
      THREAD_ID,
      "resume",
      new Error("boom"),
      CLAUDE_SESSION_ERROR_MATCHERS,
    );

    expect(result._tag).toBe("ProviderAdapterRequestError");
    expect(result.provider).toBe("claudeAgent");
  });

  it("returns SessionClosedError when cause matches a closed pattern", () => {
    const cause = new Error("the session is closed already");
    const result = toRequestError(
      "codex",
      THREAD_ID,
      "sendTurn",
      cause,
      CODEX_SESSION_ERROR_MATCHERS,
    );

    expect(result?._tag).toBe("ProviderAdapterSessionClosedError");
  });
});
