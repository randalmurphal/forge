import { DEFAULT_SERVER_SETTINGS } from "@forgetools/contracts";
import { deepMerge } from "@forgetools/shared/Struct";
import { describe, expect, it } from "vitest";
import {
  applyAppearanceCssVariables,
  buildAppearanceCssVariables,
  resolveAppearanceSettings,
} from "./appearance";

describe("appearance", () => {
  it("deep merges sparse appearance settings with built-in defaults", () => {
    const resolved = resolveAppearanceSettings({
      appearance: deepMerge(DEFAULT_SERVER_SETTINGS.appearance, {
        typography: {
          uiFontFamily: '"IBM Plex Sans", sans-serif',
        },
        dark: {
          ui: {
            background: "#101418",
          },
        },
      }),
    });

    expect(resolved.typography.uiFontFamily).toBe('"IBM Plex Sans", sans-serif');
    expect(resolved.typography.monoFontFamily).toBe(
      DEFAULT_SERVER_SETTINGS.appearance.typography.monoFontFamily,
    );
    expect(resolved.dark.ui.background).toBe("#101418");
    expect(resolved.dark.ui.foreground).toBe(DEFAULT_SERVER_SETTINGS.appearance.dark.ui.foreground);
  });

  it("builds and applies CSS variables for the active appearance theme", () => {
    const settings = {
      appearance: deepMerge(DEFAULT_SERVER_SETTINGS.appearance, {
        typography: {
          uiFontFamily: '"IBM Plex Sans", sans-serif',
          monoFontFamily: '"JetBrains Mono", monospace',
        },
        dark: {
          ui: {
            background: "#101418",
            foreground: "#f5f7fb",
          },
          feature: {
            providerClaude: "#ff9966",
          },
        },
      }),
    };

    const variables = buildAppearanceCssVariables(settings, "dark");
    expect(variables["--font-ui"]).toBe('"IBM Plex Sans", sans-serif');
    expect(variables["--font-mono"]).toBe('"JetBrains Mono", monospace');
    expect(variables["--background"]).toBe("#101418");
    expect(variables["--foreground"]).toBe("#f5f7fb");
    expect(variables["--feature-provider-claude"]).toBe("#ff9966");
  });

  it("applies CSS variables to a DOM element", () => {
    if (typeof document === "undefined") return;

    const settings = {
      appearance: deepMerge(DEFAULT_SERVER_SETTINGS.appearance, {
        typography: {
          uiFontFamily: '"IBM Plex Sans", sans-serif',
          monoFontFamily: '"JetBrains Mono", monospace',
        },
        dark: {
          ui: {
            background: "#101418",
            foreground: "#f5f7fb",
          },
          feature: {
            providerClaude: "#ff9966",
          },
        },
      }),
    };

    const root = document.createElement("div");
    applyAppearanceCssVariables(root, settings, "dark");

    expect(root.style.getPropertyValue("--font-ui")).toBe('"IBM Plex Sans", sans-serif');
    expect(root.style.getPropertyValue("--font-mono")).toBe('"JetBrains Mono", monospace');
    expect(root.style.getPropertyValue("--background")).toBe("#101418");
    expect(root.style.getPropertyValue("--feature-provider-claude")).toBe("#ff9966");
  });
});
