import { describe, expect, it } from "vitest";

import {
  asArray,
  asBoolean,
  asFiniteNumber,
  asRecord,
  asString,
  asTrimmedString,
  truncateDetail,
} from "./narrowing";

describe("asRecord", () => {
  it("returns plain objects as-is", () => {
    const obj = { a: 1, b: "two" };
    expect(asRecord(obj)).toBe(obj);
  });

  it("returns nested objects", () => {
    const obj = { inner: { deep: true } };
    expect(asRecord(obj)).toBe(obj);
  });

  it("returns empty objects", () => {
    const obj = {};
    expect(asRecord(obj)).toBe(obj);
  });

  it("rejects arrays", () => {
    expect(asRecord([1, 2, 3])).toBeUndefined();
    expect(asRecord([])).toBeUndefined();
  });

  it("rejects null", () => {
    expect(asRecord(null)).toBeUndefined();
  });

  it("rejects undefined", () => {
    expect(asRecord(undefined)).toBeUndefined();
  });

  it("rejects primitives", () => {
    expect(asRecord("string")).toBeUndefined();
    expect(asRecord(42)).toBeUndefined();
    expect(asRecord(true)).toBeUndefined();
  });
});

describe("asString", () => {
  it("returns strings as-is", () => {
    expect(asString("hello")).toBe("hello");
  });

  it("returns empty strings (not rejected)", () => {
    expect(asString("")).toBe("");
  });

  it("rejects non-strings", () => {
    expect(asString(42)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString(true)).toBeUndefined();
    expect(asString({})).toBeUndefined();
    expect(asString([])).toBeUndefined();
  });
});

describe("asTrimmedString", () => {
  it("returns non-empty trimmed strings", () => {
    expect(asTrimmedString("hello")).toBe("hello");
  });

  it("trims surrounding whitespace from the returned value", () => {
    expect(asTrimmedString("  hello  ")).toBe("hello");
    expect(asTrimmedString("\thello\n")).toBe("hello");
  });

  it("rejects whitespace-only strings", () => {
    expect(asTrimmedString("   ")).toBeUndefined();
    expect(asTrimmedString("\t\n")).toBeUndefined();
  });

  it("rejects empty strings", () => {
    expect(asTrimmedString("")).toBeUndefined();
  });

  it("rejects non-strings", () => {
    expect(asTrimmedString(42)).toBeUndefined();
    expect(asTrimmedString(null)).toBeUndefined();
    expect(asTrimmedString(undefined)).toBeUndefined();
    expect(asTrimmedString({})).toBeUndefined();
  });
});

describe("asFiniteNumber", () => {
  it("returns finite numbers", () => {
    expect(asFiniteNumber(42)).toBe(42);
    expect(asFiniteNumber(3.14)).toBe(3.14);
  });

  it("returns zero", () => {
    expect(asFiniteNumber(0)).toBe(0);
  });

  it("returns negative numbers", () => {
    expect(asFiniteNumber(-1)).toBe(-1);
    expect(asFiniteNumber(-99.5)).toBe(-99.5);
  });

  it("rejects NaN", () => {
    expect(asFiniteNumber(NaN)).toBeUndefined();
  });

  it("rejects Infinity", () => {
    expect(asFiniteNumber(Infinity)).toBeUndefined();
  });

  it("rejects -Infinity", () => {
    expect(asFiniteNumber(-Infinity)).toBeUndefined();
  });

  it("rejects non-numbers", () => {
    expect(asFiniteNumber("42")).toBeUndefined();
    expect(asFiniteNumber(null)).toBeUndefined();
    expect(asFiniteNumber(undefined)).toBeUndefined();
    expect(asFiniteNumber(true)).toBeUndefined();
  });
});

describe("asArray", () => {
  it("returns arrays as-is", () => {
    const arr = [1, 2, 3];
    expect(asArray(arr)).toBe(arr);
  });

  it("returns empty arrays", () => {
    const arr: unknown[] = [];
    expect(asArray(arr)).toBe(arr);
  });

  it("rejects non-arrays", () => {
    expect(asArray("string")).toBeUndefined();
    expect(asArray(42)).toBeUndefined();
    expect(asArray(null)).toBeUndefined();
    expect(asArray(undefined)).toBeUndefined();
    expect(asArray(true)).toBeUndefined();
  });

  it("rejects objects", () => {
    expect(asArray({})).toBeUndefined();
    expect(asArray({ length: 0 })).toBeUndefined();
  });
});

describe("asBoolean", () => {
  it("returns true", () => {
    expect(asBoolean(true)).toBe(true);
  });

  it("returns false", () => {
    expect(asBoolean(false)).toBe(false);
  });

  it("rejects non-booleans", () => {
    expect(asBoolean("true")).toBeUndefined();
    expect(asBoolean(0)).toBeUndefined();
    expect(asBoolean(1)).toBeUndefined();
    expect(asBoolean(null)).toBeUndefined();
    expect(asBoolean(undefined)).toBeUndefined();
  });

  it("rejects truthy/falsy non-booleans", () => {
    expect(asBoolean("")).toBeUndefined();
    expect(asBoolean("hello")).toBeUndefined();
    expect(asBoolean([])).toBeUndefined();
    expect(asBoolean({})).toBeUndefined();
  });
});

describe("truncateDetail", () => {
  it("returns strings within the default limit as-is", () => {
    const short = "a short string";
    expect(truncateDetail(short)).toBe(short);
  });

  it("truncates strings exceeding the default limit", () => {
    const long = "x".repeat(200);
    const result = truncateDetail(long);
    expect(result).toHaveLength(180);
    expect(result.endsWith("...")).toBe(true);
    expect(result).toBe("x".repeat(177) + "...");
  });

  it("respects a custom maxLength parameter", () => {
    const result = truncateDetail("abcdefghij", 7);
    expect(result).toBe("abcd...");
    expect(result).toHaveLength(7);
  });

  it("does not truncate when length equals maxLength", () => {
    expect(truncateDetail("abcde", 5)).toBe("abcde");
  });

  it("truncates when length equals maxLength + 1", () => {
    const result = truncateDetail("abcdef", 5);
    expect(result).toBe("ab...");
    expect(result).toHaveLength(5);
  });
});
