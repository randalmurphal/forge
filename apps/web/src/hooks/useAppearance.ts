import { useLayoutEffect } from "react";
import { useSettings } from "./useSettings";
import { useTheme } from "./useTheme";
import { applyAppearanceCssVariables } from "~/lib/appearance";

export function useAppearance(): void {
  const settings = useSettings((current) => current);
  const { resolvedTheme } = useTheme();

  useLayoutEffect(() => {
    applyAppearanceCssVariables(document.documentElement, settings, resolvedTheme);
  }, [resolvedTheme, settings]);
}
