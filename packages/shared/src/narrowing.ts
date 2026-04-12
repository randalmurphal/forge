/**
 * Canonical type-narrowing utilities for safely extracting typed values
 * from `unknown` data (e.g. JSON payloads from provider APIs).
 */

/**
 * Narrow an unknown value to a plain object (excluding arrays and null).
 * Returns `undefined` if the value is not a plain object.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Narrow an unknown value to a string.
 * Returns `undefined` if the value is not a string.
 * Does NOT reject empty strings — use `asTrimmedString` for that.
 */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Narrow an unknown value to a non-empty trimmed string.
 * Returns `undefined` if the value is not a string or is empty after trimming.
 */
export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Narrow an unknown value to a finite number.
 * Returns `undefined` if the value is not a finite number.
 */
export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Narrow an unknown value to an array.
 * Returns `undefined` if the value is not an array.
 */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Narrow an unknown value to a boolean.
 * Returns `undefined` if the value is not a boolean.
 */
export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Truncate a string to a maximum length, appending "..." if truncated.
 * The total output length (including "...") will not exceed `maxLength`.
 */
export function truncateDetail(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
