import {
  DEFAULT_APPEARANCE_SETTINGS,
  type ProviderKind,
  type ServerSettings,
} from "@forgetools/contracts";
import { deepMerge } from "@forgetools/shared/Struct";

export type ResolvedAppearanceTheme = "light" | "dark";

export function resolveAppearanceSettings(settings: Pick<ServerSettings, "appearance">) {
  return deepMerge(DEFAULT_APPEARANCE_SETTINGS, settings.appearance);
}

export function resolveAppearanceThemeSettings(
  settings: Pick<ServerSettings, "appearance">,
  theme: ResolvedAppearanceTheme,
) {
  return resolveAppearanceSettings(settings)[theme];
}

export function buildAppearanceCssVariables(
  settings: Pick<ServerSettings, "appearance">,
  theme: ResolvedAppearanceTheme,
): Record<string, string> {
  const appearance = resolveAppearanceSettings(settings);
  const appearanceTheme = appearance[theme];

  return {
    "--font-ui": appearance.typography.uiFontFamily,
    "--font-mono": appearance.typography.monoFontFamily,
    "--font-size-xs": appearance.typography.fontSizeXs,
    "--font-size-sm": appearance.typography.fontSizeSm,
    "--font-size-md": appearance.typography.fontSizeMd,
    "--font-size-lg": appearance.typography.fontSizeLg,
    "--font-size-xl": appearance.typography.fontSizeXl,
    "--line-height-compact": String(appearance.typography.lineHeightCompact),
    "--line-height-normal": String(appearance.typography.lineHeightNormal),
    "--line-height-relaxed": String(appearance.typography.lineHeightRelaxed),
    "--terminal-font-size": String(appearance.typography.terminalFontSize),
    "--terminal-line-height": String(appearance.typography.terminalLineHeight),
    "--background": appearanceTheme.ui.background,
    "--foreground": appearanceTheme.ui.foreground,
    "--card": appearanceTheme.ui.card,
    "--card-foreground": appearanceTheme.ui.cardForeground,
    "--popover": appearanceTheme.ui.popover,
    "--popover-foreground": appearanceTheme.ui.popoverForeground,
    "--primary": appearanceTheme.ui.primary,
    "--primary-foreground": appearanceTheme.ui.primaryForeground,
    "--secondary": appearanceTheme.ui.secondary,
    "--secondary-foreground": appearanceTheme.ui.secondaryForeground,
    "--muted": appearanceTheme.ui.muted,
    "--muted-foreground": appearanceTheme.ui.mutedForeground,
    "--accent": appearanceTheme.ui.accent,
    "--accent-foreground": appearanceTheme.ui.accentForeground,
    "--destructive": appearanceTheme.ui.destructive,
    "--destructive-foreground": appearanceTheme.ui.destructiveForeground,
    "--border": appearanceTheme.ui.border,
    "--input": appearanceTheme.ui.input,
    "--ring": appearanceTheme.ui.ring,
    "--info": appearanceTheme.ui.info,
    "--info-foreground": appearanceTheme.ui.infoForeground,
    "--success": appearanceTheme.ui.success,
    "--success-foreground": appearanceTheme.ui.successForeground,
    "--warning": appearanceTheme.ui.warning,
    "--warning-foreground": appearanceTheme.ui.warningForeground,
    "--sidebar": appearanceTheme.sidebar.background,
    "--sidebar-foreground": appearanceTheme.sidebar.foreground,
    "--sidebar-border": appearanceTheme.sidebar.border,
    "--sidebar-accent": appearanceTheme.sidebar.accent,
    "--sidebar-accent-foreground": appearanceTheme.sidebar.accentForeground,
    "--panel": appearanceTheme.workbench.panel,
    "--panel-elevated": appearanceTheme.workbench.panelElevated,
    "--panel-active": appearanceTheme.workbench.panelActive,
    "--panel-inset": appearanceTheme.workbench.panelInset,
    "--list-hover": appearanceTheme.workbench.listHover,
    "--list-active": appearanceTheme.workbench.listActive,
    "--list-muted-badge": appearanceTheme.workbench.listMutedBadge,
    "--diff-context": appearanceTheme.diff.context,
    "--diff-hover": appearanceTheme.diff.hover,
    "--diff-separator": appearanceTheme.diff.separator,
    "--diff-addition": appearanceTheme.diff.addition,
    "--diff-addition-emphasis": appearanceTheme.diff.additionEmphasis,
    "--diff-deletion": appearanceTheme.diff.deletion,
    "--diff-deletion-emphasis": appearanceTheme.diff.deletionEmphasis,
    "--feature-provider-claude": appearanceTheme.feature.providerClaude,
    "--feature-discussion-global": appearanceTheme.feature.discussionGlobal,
    "--feature-discussion-project": appearanceTheme.feature.discussionProject,
    "--feature-phase-single-agent": appearanceTheme.feature.phaseSingleAgent,
    "--feature-phase-multi-agent": appearanceTheme.feature.phaseMultiAgent,
    "--feature-phase-automated": appearanceTheme.feature.phaseAutomated,
    "--feature-phase-human": appearanceTheme.feature.phaseHuman,
    "--feature-phase-running": appearanceTheme.feature.phaseRunning,
    "--feature-phase-completed": appearanceTheme.feature.phaseCompleted,
    "--feature-phase-failed": appearanceTheme.feature.phaseFailed,
    "--feature-phase-pending": appearanceTheme.feature.phasePending,
    "--feature-phase-skipped": appearanceTheme.feature.phaseSkipped,
    "--terminal-background": appearanceTheme.terminal.background,
    "--terminal-foreground": appearanceTheme.terminal.foreground,
    "--terminal-cursor": appearanceTheme.terminal.cursor,
    "--terminal-selection-background": appearanceTheme.terminal.selectionBackground,
    "--terminal-scrollbar-slider-background": appearanceTheme.terminal.scrollbarSliderBackground,
    "--terminal-scrollbar-slider-hover-background":
      appearanceTheme.terminal.scrollbarSliderHoverBackground,
    "--terminal-scrollbar-slider-active-background":
      appearanceTheme.terminal.scrollbarSliderActiveBackground,
    "--terminal-ansi-black": appearanceTheme.terminal.ansi.black,
    "--terminal-ansi-red": appearanceTheme.terminal.ansi.red,
    "--terminal-ansi-green": appearanceTheme.terminal.ansi.green,
    "--terminal-ansi-yellow": appearanceTheme.terminal.ansi.yellow,
    "--terminal-ansi-blue": appearanceTheme.terminal.ansi.blue,
    "--terminal-ansi-magenta": appearanceTheme.terminal.ansi.magenta,
    "--terminal-ansi-cyan": appearanceTheme.terminal.ansi.cyan,
    "--terminal-ansi-white": appearanceTheme.terminal.ansi.white,
    "--terminal-ansi-bright-black": appearanceTheme.terminal.ansi.brightBlack,
    "--terminal-ansi-bright-red": appearanceTheme.terminal.ansi.brightRed,
    "--terminal-ansi-bright-green": appearanceTheme.terminal.ansi.brightGreen,
    "--terminal-ansi-bright-yellow": appearanceTheme.terminal.ansi.brightYellow,
    "--terminal-ansi-bright-blue": appearanceTheme.terminal.ansi.brightBlue,
    "--terminal-ansi-bright-magenta": appearanceTheme.terminal.ansi.brightMagenta,
    "--terminal-ansi-bright-cyan": appearanceTheme.terminal.ansi.brightCyan,
    "--terminal-ansi-bright-white": appearanceTheme.terminal.ansi.brightWhite,
  };
}

export function applyAppearanceCssVariables(
  root: HTMLElement,
  settings: Pick<ServerSettings, "appearance">,
  theme: ResolvedAppearanceTheme,
) {
  const variables = buildAppearanceCssVariables(settings, theme);
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
}

export function resolveProviderAccentColor(
  settings: Pick<ServerSettings, "appearance">,
  theme: ResolvedAppearanceTheme,
  provider: ProviderKind,
  fallbackClassName: string,
): string {
  if (provider === "claudeAgent") {
    return resolveAppearanceThemeSettings(settings, theme).feature.providerClaude;
  }
  return fallbackClassName;
}

export function resolveDiscussionScopeColor(
  settings: Pick<ServerSettings, "appearance">,
  theme: ResolvedAppearanceTheme,
  scope: "global" | "project",
): string {
  return scope === "global"
    ? resolveAppearanceThemeSettings(settings, theme).feature.discussionGlobal
    : resolveAppearanceThemeSettings(settings, theme).feature.discussionProject;
}

export function resolvePhaseFeatureColor(
  settings: Pick<ServerSettings, "appearance">,
  theme: ResolvedAppearanceTheme,
  phase:
    | "single-agent"
    | "multi-agent"
    | "automated"
    | "human"
    | "running"
    | "completed"
    | "failed"
    | "pending"
    | "skipped",
): string {
  const feature = resolveAppearanceThemeSettings(settings, theme).feature;
  switch (phase) {
    case "single-agent":
      return feature.phaseSingleAgent;
    case "multi-agent":
      return feature.phaseMultiAgent;
    case "automated":
      return feature.phaseAutomated;
    case "human":
      return feature.phaseHuman;
    case "running":
      return feature.phaseRunning;
    case "completed":
      return feature.phaseCompleted;
    case "failed":
      return feature.phaseFailed;
    case "pending":
      return feature.phasePending;
    case "skipped":
      return feature.phaseSkipped;
  }
}

export function resolveRolePalette(
  settings: Pick<ServerSettings, "appearance">,
  theme: ResolvedAppearanceTheme,
): readonly string[] {
  const palette = resolveAppearanceThemeSettings(settings, theme).feature.rolePalette;
  return palette.length > 0 ? palette : DEFAULT_APPEARANCE_SETTINGS[theme].feature.rolePalette;
}

export function resolveTerminalThemeSettings(
  settings: Pick<ServerSettings, "appearance">,
  theme: ResolvedAppearanceTheme,
) {
  return resolveAppearanceThemeSettings(settings, theme).terminal;
}

export function buildToneBadgeStyle(color: string): Record<string, string> {
  return {
    borderColor: `color-mix(in srgb, ${color} 25%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
    color,
  };
}

export function buildToneSurfaceStyle(
  color: string,
  options?: {
    readonly borderPercent?: number;
    readonly backgroundPercent?: number;
    readonly textColor?: string;
  },
): Record<string, string> {
  const borderPercent = options?.borderPercent ?? 20;
  const backgroundPercent = options?.backgroundPercent ?? 8;
  return {
    borderColor: `color-mix(in srgb, ${color} ${borderPercent}%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${color} ${backgroundPercent}%, transparent)`,
    color: options?.textColor ?? color,
  };
}
