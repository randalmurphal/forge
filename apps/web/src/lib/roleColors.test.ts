import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@forgetools/contracts";
import { resolveRoleColor } from "./roleColors";

describe("resolveRoleColor", () => {
  it("returns a consistent color for the same role", () => {
    const color1 = resolveRoleColor("advocate", "dark");
    const color2 = resolveRoleColor("advocate", "dark");
    expect(color1).toBe(color2);
  });

  it("is case-insensitive", () => {
    expect(resolveRoleColor("Advocate", "dark")).toBe(resolveRoleColor("advocate", "dark"));
    expect(resolveRoleColor("ADVOCATE", "light")).toBe(resolveRoleColor("advocate", "light"));
  });

  it("returns different colors for different roles", () => {
    const roles = ["advocate", "interrogator", "scrutinizer", "defender", "refiner"];
    const colors = roles.map((role) => resolveRoleColor(role, "dark"));
    const unique = new Set(colors);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("returns valid hex color strings", () => {
    expect(resolveRoleColor("advocate", "light")).toMatch(/^#[0-9a-f]{6}$/);
    expect(resolveRoleColor("advocate", "dark")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns different values for light and dark themes", () => {
    const light = resolveRoleColor("advocate", "light");
    const dark = resolveRoleColor("advocate", "dark");
    expect(light).not.toBe(dark);
  });

  it("falls back to the built-in palette when the configured palette is empty", () => {
    const expected = resolveRoleColor("advocate", "dark", DEFAULT_SERVER_SETTINGS);
    const color = resolveRoleColor("advocate", "dark", {
      appearance: {
        ...DEFAULT_SERVER_SETTINGS.appearance,
        dark: {
          ...DEFAULT_SERVER_SETTINGS.appearance.dark,
          feature: {
            ...DEFAULT_SERVER_SETTINGS.appearance.dark.feature,
            rolePalette: [],
          },
        },
      },
    });

    expect(color).toBe(expected);
  });
});
