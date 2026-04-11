import { describe, expect, it } from "vitest";

import { isIgnorableDevServerSocketError } from "./devServerSocketErrors";

describe("isIgnorableDevServerSocketError", () => {
  it("accepts connection reset errors", () => {
    expect(isIgnorableDevServerSocketError({ code: "ECONNRESET" })).toBe(true);
    expect(isIgnorableDevServerSocketError({ code: "ECONNABORTED" })).toBe(true);
  });

  it("rejects other values", () => {
    expect(isIgnorableDevServerSocketError({ code: "EPIPE" })).toBe(false);
    expect(isIgnorableDevServerSocketError(new Error("boom"))).toBe(false);
    expect(isIgnorableDevServerSocketError(null)).toBe(false);
  });
});
