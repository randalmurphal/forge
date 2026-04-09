import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
} from "./model";
import { ModelSelection } from "./orchestration";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const ClientSettingsSchema = Schema.Struct({
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_PROJECT_SORT_ORDER),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER),
  ),
  timestampFormat: TimestampFormat.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMESTAMP_FORMAT)),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(() => fallback),
  );

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: makeBinaryPathSetting("claude"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const NotificationSettings = Schema.Struct({
  sessionNeedsAttention: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  sessionCompleted: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  deliberationConcluded: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
});
export type NotificationSettings = typeof NotificationSettings.Type;

const CssValueString = TrimmedString.pipe(Schema.withDecodingDefault(() => ""));

export const AppearanceTypographySettings = Schema.Struct({
  uiFontFamily: TrimmedString.pipe(
    Schema.withDecodingDefault(
      () => '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    ),
  ),
  monoFontFamily: TrimmedString.pipe(
    Schema.withDecodingDefault(
      () => '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    ),
  ),
  fontSizeXs: TrimmedString.pipe(Schema.withDecodingDefault(() => "11px")),
  fontSizeSm: TrimmedString.pipe(Schema.withDecodingDefault(() => "12px")),
  fontSizeMd: TrimmedString.pipe(Schema.withDecodingDefault(() => "13px")),
  fontSizeLg: TrimmedString.pipe(Schema.withDecodingDefault(() => "14px")),
  fontSizeXl: TrimmedString.pipe(Schema.withDecodingDefault(() => "16px")),
  lineHeightCompact: Schema.Number.pipe(Schema.withDecodingDefault(() => 1.25)),
  lineHeightNormal: Schema.Number.pipe(Schema.withDecodingDefault(() => 1.45)),
  lineHeightRelaxed: Schema.Number.pipe(Schema.withDecodingDefault(() => 1.6)),
  terminalFontSize: Schema.Number.pipe(Schema.withDecodingDefault(() => 13)),
  terminalLineHeight: Schema.Number.pipe(Schema.withDecodingDefault(() => 1.2)),
});
export type AppearanceTypographySettings = typeof AppearanceTypographySettings.Type;

export const AppearanceUiSettings = Schema.Struct({
  background: CssValueString,
  foreground: CssValueString,
  card: CssValueString,
  cardForeground: CssValueString,
  popover: CssValueString,
  popoverForeground: CssValueString,
  primary: CssValueString,
  primaryForeground: CssValueString,
  secondary: CssValueString,
  secondaryForeground: CssValueString,
  muted: CssValueString,
  mutedForeground: CssValueString,
  accent: CssValueString,
  accentForeground: CssValueString,
  border: CssValueString,
  input: CssValueString,
  ring: CssValueString,
  info: CssValueString,
  infoForeground: CssValueString,
  success: CssValueString,
  successForeground: CssValueString,
  warning: CssValueString,
  warningForeground: CssValueString,
  destructive: CssValueString,
  destructiveForeground: CssValueString,
});
export type AppearanceUiSettings = typeof AppearanceUiSettings.Type;

export const AppearanceWorkbenchSettings = Schema.Struct({
  panel: CssValueString,
  panelElevated: CssValueString,
  panelActive: CssValueString,
  panelInset: CssValueString,
  listHover: CssValueString,
  listActive: CssValueString,
  listMutedBadge: CssValueString,
});
export type AppearanceWorkbenchSettings = typeof AppearanceWorkbenchSettings.Type;

export const AppearanceSidebarSettings = Schema.Struct({
  background: CssValueString,
  foreground: CssValueString,
  border: CssValueString,
  accent: CssValueString,
  accentForeground: CssValueString,
});
export type AppearanceSidebarSettings = typeof AppearanceSidebarSettings.Type;

export const AppearanceDiffSettings = Schema.Struct({
  context: CssValueString,
  hover: CssValueString,
  separator: CssValueString,
  addition: CssValueString,
  additionEmphasis: CssValueString,
  deletion: CssValueString,
  deletionEmphasis: CssValueString,
});
export type AppearanceDiffSettings = typeof AppearanceDiffSettings.Type;

export const AppearanceTerminalAnsiSettings = Schema.Struct({
  black: CssValueString,
  red: CssValueString,
  green: CssValueString,
  yellow: CssValueString,
  blue: CssValueString,
  magenta: CssValueString,
  cyan: CssValueString,
  white: CssValueString,
  brightBlack: CssValueString,
  brightRed: CssValueString,
  brightGreen: CssValueString,
  brightYellow: CssValueString,
  brightBlue: CssValueString,
  brightMagenta: CssValueString,
  brightCyan: CssValueString,
  brightWhite: CssValueString,
});
export type AppearanceTerminalAnsiSettings = typeof AppearanceTerminalAnsiSettings.Type;

export const AppearanceTerminalSettings = Schema.Struct({
  background: CssValueString,
  foreground: CssValueString,
  cursor: CssValueString,
  selectionBackground: CssValueString,
  scrollbarSliderBackground: CssValueString,
  scrollbarSliderHoverBackground: CssValueString,
  scrollbarSliderActiveBackground: CssValueString,
  ansi: AppearanceTerminalAnsiSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type AppearanceTerminalSettings = typeof AppearanceTerminalSettings.Type;

export const AppearanceFeatureSettings = Schema.Struct({
  providerClaude: CssValueString,
  discussionGlobal: CssValueString,
  discussionProject: CssValueString,
  phaseSingleAgent: CssValueString,
  phaseMultiAgent: CssValueString,
  phaseAutomated: CssValueString,
  phaseHuman: CssValueString,
  phaseRunning: CssValueString,
  phaseCompleted: CssValueString,
  phaseFailed: CssValueString,
  phasePending: CssValueString,
  phaseSkipped: CssValueString,
  rolePalette: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(() => [
      "#2563eb",
      "#059669",
      "#ea580c",
      "#7c3aed",
      "#e11d48",
      "#0d9488",
      "#d97706",
      "#4f46e5",
    ]),
  ),
});
export type AppearanceFeatureSettings = typeof AppearanceFeatureSettings.Type;

export const AppearanceThemeSettings = Schema.Struct({
  ui: AppearanceUiSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  workbench: AppearanceWorkbenchSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  sidebar: AppearanceSidebarSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  diff: AppearanceDiffSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  terminal: AppearanceTerminalSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  feature: AppearanceFeatureSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type AppearanceThemeSettings = typeof AppearanceThemeSettings.Type;

export const AppearanceSettings = Schema.Struct({
  version: Schema.Number.pipe(Schema.withDecodingDefault(() => 1)),
  typography: AppearanceTypographySettings.pipe(Schema.withDecodingDefault(() => ({}))),
  light: AppearanceThemeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  dark: AppearanceThemeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type AppearanceSettings = typeof AppearanceSettings.Type;

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  version: 1,
  typography: {
    uiFontFamily: '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    monoFontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    fontSizeXs: "11px",
    fontSizeSm: "12px",
    fontSizeMd: "13px",
    fontSizeLg: "14px",
    fontSizeXl: "16px",
    lineHeightCompact: 1.25,
    lineHeightNormal: 1.45,
    lineHeightRelaxed: 1.6,
    terminalFontSize: 13,
    terminalLineHeight: 1.2,
  },
  light: {
    ui: {
      background: "var(--color-white)",
      foreground: "var(--color-neutral-800)",
      card: "var(--color-white)",
      cardForeground: "var(--color-neutral-800)",
      popover: "var(--color-white)",
      popoverForeground: "var(--color-neutral-800)",
      primary: "oklch(0.488 0.217 264)",
      primaryForeground: "var(--color-white)",
      secondary: "color-mix(in srgb, var(--color-black) 4%, transparent)",
      secondaryForeground: "var(--color-neutral-800)",
      muted: "color-mix(in srgb, var(--color-black) 4%, transparent)",
      mutedForeground: "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-black))",
      accent: "color-mix(in srgb, var(--color-black) 4%, transparent)",
      accentForeground: "var(--color-neutral-800)",
      border: "color-mix(in srgb, var(--color-black) 8%, transparent)",
      input: "color-mix(in srgb, var(--color-black) 10%, transparent)",
      ring: "oklch(0.488 0.217 264)",
      info: "var(--color-blue-500)",
      infoForeground: "var(--color-blue-700)",
      success: "var(--color-emerald-500)",
      successForeground: "var(--color-emerald-700)",
      warning: "var(--color-amber-500)",
      warningForeground: "var(--color-amber-700)",
      destructive: "var(--color-red-500)",
      destructiveForeground: "var(--color-red-700)",
    },
    workbench: {
      panel: "#151518",
      panelElevated: "#1c1c20",
      panelActive: "#1c1c20",
      panelInset: "color-mix(in srgb, var(--color-black) 4%, transparent)",
      listHover: "#1c1c20",
      listActive: "#1c1c20",
      listMutedBadge: "color-mix(in srgb, var(--color-neutral-500) 10%, transparent)",
    },
    sidebar: {
      background: "color-mix(in srgb, var(--color-neutral-50) 92%, var(--color-white))",
      foreground: "var(--color-neutral-800)",
      border: "color-mix(in srgb, var(--color-black) 8%, transparent)",
      accent: "color-mix(in srgb, var(--color-black) 4%, transparent)",
      accentForeground: "var(--color-neutral-800)",
    },
    diff: {
      context: "color-mix(in srgb, var(--color-white) 97%, var(--color-neutral-800))",
      hover: "color-mix(in srgb, var(--color-white) 94%, var(--color-neutral-800))",
      separator: "color-mix(in srgb, var(--color-white) 95%, var(--color-neutral-800))",
      addition: "color-mix(in srgb, var(--color-white) 92%, var(--color-emerald-500))",
      additionEmphasis: "color-mix(in srgb, var(--color-white) 80%, var(--color-emerald-500))",
      deletion: "color-mix(in srgb, var(--color-white) 92%, var(--color-red-500))",
      deletionEmphasis: "color-mix(in srgb, var(--color-white) 80%, var(--color-red-500))",
    },
    terminal: {
      background: "rgb(255, 255, 255)",
      foreground: "rgb(28, 33, 41)",
      cursor: "rgb(38, 56, 78)",
      selectionBackground: "rgba(37, 63, 99, 0.2)",
      scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
      scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
      scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
      ansi: {
        black: "rgb(44, 53, 66)",
        red: "rgb(191, 70, 87)",
        green: "rgb(60, 126, 86)",
        yellow: "rgb(146, 112, 35)",
        blue: "rgb(72, 102, 163)",
        magenta: "rgb(132, 86, 149)",
        cyan: "rgb(53, 127, 141)",
        white: "rgb(210, 215, 223)",
        brightBlack: "rgb(112, 123, 140)",
        brightRed: "rgb(212, 95, 112)",
        brightGreen: "rgb(85, 148, 111)",
        brightYellow: "rgb(173, 133, 45)",
        brightBlue: "rgb(91, 124, 194)",
        brightMagenta: "rgb(153, 107, 172)",
        brightCyan: "rgb(70, 149, 164)",
        brightWhite: "rgb(236, 240, 246)",
      },
    },
    feature: {
      providerClaude: "#d97757",
      discussionGlobal: "#3b82f6",
      discussionProject: "#f59e0b",
      phaseSingleAgent: "#0ea5e9",
      phaseMultiAgent: "#f59e0b",
      phaseAutomated: "#10b981",
      phaseHuman: "#8b5cf6",
      phaseRunning: "#0ea5e9",
      phaseCompleted: "#10b981",
      phaseFailed: "#f43f5e",
      phasePending: "#71717a",
      phaseSkipped: "#f59e0b",
      rolePalette: [
        "#2563eb",
        "#059669",
        "#ea580c",
        "#7c3aed",
        "#e11d48",
        "#0d9488",
        "#d97706",
        "#4f46e5",
      ],
    },
  },
  dark: {
    ui: {
      background: "color-mix(in srgb, var(--color-neutral-950) 95%, var(--color-white))",
      foreground: "var(--color-neutral-100)",
      card: "color-mix(in srgb, var(--color-neutral-950) 93%, var(--color-white))",
      cardForeground: "var(--color-neutral-100)",
      popover: "color-mix(in srgb, var(--color-neutral-950) 93%, var(--color-white))",
      popoverForeground: "var(--color-neutral-100)",
      primary: "oklch(0.588 0.217 264)",
      primaryForeground: "var(--color-white)",
      secondary: "color-mix(in srgb, var(--color-white) 4%, transparent)",
      secondaryForeground: "var(--color-neutral-100)",
      muted: "color-mix(in srgb, var(--color-white) 4%, transparent)",
      mutedForeground: "color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-white))",
      accent: "color-mix(in srgb, var(--color-white) 4%, transparent)",
      accentForeground: "var(--color-neutral-100)",
      border: "color-mix(in srgb, var(--color-white) 6%, transparent)",
      input: "color-mix(in srgb, var(--color-white) 8%, transparent)",
      ring: "oklch(0.588 0.217 264)",
      info: "var(--color-blue-500)",
      infoForeground: "var(--color-blue-400)",
      success: "var(--color-emerald-500)",
      successForeground: "var(--color-emerald-400)",
      warning: "var(--color-amber-500)",
      warningForeground: "var(--color-amber-400)",
      destructive: "color-mix(in srgb, var(--color-red-500) 90%, var(--color-white))",
      destructiveForeground: "var(--color-red-400)",
    },
    workbench: {
      panel: "#151518",
      panelElevated: "#1c1c20",
      panelActive: "#1c1c20",
      panelInset: "color-mix(in srgb, var(--color-white) 4%, transparent)",
      listHover: "#1c1c20",
      listActive: "#1c1c20",
      listMutedBadge: "color-mix(in srgb, var(--color-white) 10%, transparent)",
    },
    sidebar: {
      background: "color-mix(in srgb, var(--color-neutral-950) 96%, var(--color-white))",
      foreground: "var(--color-neutral-100)",
      border: "color-mix(in srgb, var(--color-white) 6%, transparent)",
      accent: "color-mix(in srgb, var(--color-white) 4%, transparent)",
      accentForeground: "var(--color-neutral-100)",
    },
    diff: {
      context: "color-mix(in srgb, var(--color-neutral-950) 97%, var(--color-white))",
      hover: "color-mix(in srgb, var(--color-neutral-950) 94%, var(--color-white))",
      separator: "color-mix(in srgb, var(--color-neutral-950) 95%, var(--color-white))",
      addition: "color-mix(in srgb, var(--color-neutral-950) 92%, var(--color-emerald-500))",
      additionEmphasis:
        "color-mix(in srgb, var(--color-neutral-950) 80%, var(--color-emerald-500))",
      deletion: "color-mix(in srgb, var(--color-neutral-950) 92%, var(--color-red-500))",
      deletionEmphasis: "color-mix(in srgb, var(--color-neutral-950) 80%, var(--color-red-500))",
    },
    terminal: {
      background: "rgb(14, 18, 24)",
      foreground: "rgb(237, 241, 247)",
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      ansi: {
        black: "rgb(24, 30, 38)",
        red: "rgb(255, 122, 142)",
        green: "rgb(134, 231, 149)",
        yellow: "rgb(244, 205, 114)",
        blue: "rgb(137, 190, 255)",
        magenta: "rgb(208, 176, 255)",
        cyan: "rgb(124, 232, 237)",
        white: "rgb(210, 218, 230)",
        brightBlack: "rgb(110, 120, 136)",
        brightRed: "rgb(255, 168, 180)",
        brightGreen: "rgb(176, 245, 186)",
        brightYellow: "rgb(255, 224, 149)",
        brightBlue: "rgb(174, 210, 255)",
        brightMagenta: "rgb(229, 203, 255)",
        brightCyan: "rgb(167, 244, 247)",
        brightWhite: "rgb(244, 247, 252)",
      },
    },
    feature: {
      providerClaude: "#d97757",
      discussionGlobal: "#60a5fa",
      discussionProject: "#fbbf24",
      phaseSingleAgent: "#0ea5e9",
      phaseMultiAgent: "#f59e0b",
      phaseAutomated: "#10b981",
      phaseHuman: "#8b5cf6",
      phaseRunning: "#0ea5e9",
      phaseCompleted: "#10b981",
      phaseFailed: "#f43f5e",
      phasePending: "#a1a1aa",
      phaseSkipped: "#f59e0b",
      rolePalette: [
        "#60a5fa",
        "#34d399",
        "#fb923c",
        "#a78bfa",
        "#fb7185",
        "#2dd4bf",
        "#fbbf24",
        "#818cf8",
      ],
    },
  },
};

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(() => "local" as const satisfies ThreadEnvMode),
  ),
  worktreeBranchPrefix: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(() => "forge")),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      provider: "codex" as const,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
    })),
  ),

  // Provider specific settings
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(() => ({}))),
  notifications: NotificationSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  appearance: AppearanceSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

const DECODED_DEFAULT_SERVER_SETTINGS = Schema.decodeSync(ServerSettings)({});

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  ...DECODED_DEFAULT_SERVER_SETTINGS,
  appearance: DEFAULT_APPEARANCE_SETTINGS,
};

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const CodexModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(CodexModelOptions.fields.reasoningEffort),
  fastMode: Schema.optionalKey(CodexModelOptions.fields.fastMode),
});

const ClaudeModelOptionsPatch = Schema.Struct({
  thinking: Schema.optionalKey(ClaudeModelOptions.fields.thinking),
  effort: Schema.optionalKey(ClaudeModelOptions.fields.effort),
  fastMode: Schema.optionalKey(ClaudeModelOptions.fields.fastMode),
  contextWindow: Schema.optionalKey(ClaudeModelOptions.fields.contextWindow),
});

const ModelSelectionPatch = Schema.Union([
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("codex")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CodexModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("claudeAgent")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ClaudeModelOptionsPatch),
  }),
]);

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const AppearanceUiSettingsPatch = Schema.Struct({
  background: Schema.optionalKey(Schema.String),
  foreground: Schema.optionalKey(Schema.String),
  card: Schema.optionalKey(Schema.String),
  cardForeground: Schema.optionalKey(Schema.String),
  popover: Schema.optionalKey(Schema.String),
  popoverForeground: Schema.optionalKey(Schema.String),
  primary: Schema.optionalKey(Schema.String),
  primaryForeground: Schema.optionalKey(Schema.String),
  secondary: Schema.optionalKey(Schema.String),
  secondaryForeground: Schema.optionalKey(Schema.String),
  muted: Schema.optionalKey(Schema.String),
  mutedForeground: Schema.optionalKey(Schema.String),
  accent: Schema.optionalKey(Schema.String),
  accentForeground: Schema.optionalKey(Schema.String),
  border: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.String),
  ring: Schema.optionalKey(Schema.String),
  info: Schema.optionalKey(Schema.String),
  infoForeground: Schema.optionalKey(Schema.String),
  success: Schema.optionalKey(Schema.String),
  successForeground: Schema.optionalKey(Schema.String),
  warning: Schema.optionalKey(Schema.String),
  warningForeground: Schema.optionalKey(Schema.String),
  destructive: Schema.optionalKey(Schema.String),
  destructiveForeground: Schema.optionalKey(Schema.String),
});

const AppearanceWorkbenchSettingsPatch = Schema.Struct({
  panel: Schema.optionalKey(Schema.String),
  panelElevated: Schema.optionalKey(Schema.String),
  panelActive: Schema.optionalKey(Schema.String),
  panelInset: Schema.optionalKey(Schema.String),
  listHover: Schema.optionalKey(Schema.String),
  listActive: Schema.optionalKey(Schema.String),
  listMutedBadge: Schema.optionalKey(Schema.String),
});

const AppearanceSidebarSettingsPatch = Schema.Struct({
  background: Schema.optionalKey(Schema.String),
  foreground: Schema.optionalKey(Schema.String),
  border: Schema.optionalKey(Schema.String),
  accent: Schema.optionalKey(Schema.String),
  accentForeground: Schema.optionalKey(Schema.String),
});

const AppearanceDiffSettingsPatch = Schema.Struct({
  context: Schema.optionalKey(Schema.String),
  hover: Schema.optionalKey(Schema.String),
  separator: Schema.optionalKey(Schema.String),
  addition: Schema.optionalKey(Schema.String),
  additionEmphasis: Schema.optionalKey(Schema.String),
  deletion: Schema.optionalKey(Schema.String),
  deletionEmphasis: Schema.optionalKey(Schema.String),
});

const AppearanceTerminalAnsiSettingsPatch = Schema.Struct({
  black: Schema.optionalKey(Schema.String),
  red: Schema.optionalKey(Schema.String),
  green: Schema.optionalKey(Schema.String),
  yellow: Schema.optionalKey(Schema.String),
  blue: Schema.optionalKey(Schema.String),
  magenta: Schema.optionalKey(Schema.String),
  cyan: Schema.optionalKey(Schema.String),
  white: Schema.optionalKey(Schema.String),
  brightBlack: Schema.optionalKey(Schema.String),
  brightRed: Schema.optionalKey(Schema.String),
  brightGreen: Schema.optionalKey(Schema.String),
  brightYellow: Schema.optionalKey(Schema.String),
  brightBlue: Schema.optionalKey(Schema.String),
  brightMagenta: Schema.optionalKey(Schema.String),
  brightCyan: Schema.optionalKey(Schema.String),
  brightWhite: Schema.optionalKey(Schema.String),
});

const AppearanceTerminalSettingsPatch = Schema.Struct({
  background: Schema.optionalKey(Schema.String),
  foreground: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
  selectionBackground: Schema.optionalKey(Schema.String),
  scrollbarSliderBackground: Schema.optionalKey(Schema.String),
  scrollbarSliderHoverBackground: Schema.optionalKey(Schema.String),
  scrollbarSliderActiveBackground: Schema.optionalKey(Schema.String),
  ansi: Schema.optionalKey(AppearanceTerminalAnsiSettingsPatch),
});

const AppearanceFeatureSettingsPatch = Schema.Struct({
  providerClaude: Schema.optionalKey(Schema.String),
  discussionGlobal: Schema.optionalKey(Schema.String),
  discussionProject: Schema.optionalKey(Schema.String),
  phaseSingleAgent: Schema.optionalKey(Schema.String),
  phaseMultiAgent: Schema.optionalKey(Schema.String),
  phaseAutomated: Schema.optionalKey(Schema.String),
  phaseHuman: Schema.optionalKey(Schema.String),
  phaseRunning: Schema.optionalKey(Schema.String),
  phaseCompleted: Schema.optionalKey(Schema.String),
  phaseFailed: Schema.optionalKey(Schema.String),
  phasePending: Schema.optionalKey(Schema.String),
  phaseSkipped: Schema.optionalKey(Schema.String),
  rolePalette: Schema.optionalKey(Schema.Array(Schema.String)),
});

const AppearanceThemeSettingsPatch = Schema.Struct({
  ui: Schema.optionalKey(AppearanceUiSettingsPatch),
  workbench: Schema.optionalKey(AppearanceWorkbenchSettingsPatch),
  sidebar: Schema.optionalKey(AppearanceSidebarSettingsPatch),
  diff: Schema.optionalKey(AppearanceDiffSettingsPatch),
  terminal: Schema.optionalKey(AppearanceTerminalSettingsPatch),
  feature: Schema.optionalKey(AppearanceFeatureSettingsPatch),
});

const AppearanceTypographySettingsPatch = Schema.Struct({
  uiFontFamily: Schema.optionalKey(Schema.String),
  monoFontFamily: Schema.optionalKey(Schema.String),
  fontSizeXs: Schema.optionalKey(Schema.String),
  fontSizeSm: Schema.optionalKey(Schema.String),
  fontSizeMd: Schema.optionalKey(Schema.String),
  fontSizeLg: Schema.optionalKey(Schema.String),
  fontSizeXl: Schema.optionalKey(Schema.String),
  lineHeightCompact: Schema.optionalKey(Schema.Number),
  lineHeightNormal: Schema.optionalKey(Schema.Number),
  lineHeightRelaxed: Schema.optionalKey(Schema.Number),
  terminalFontSize: Schema.optionalKey(Schema.Number),
  terminalLineHeight: Schema.optionalKey(Schema.Number),
});

const AppearanceSettingsPatch = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  typography: Schema.optionalKey(AppearanceTypographySettingsPatch),
  light: Schema.optionalKey(AppearanceThemeSettingsPatch),
  dark: Schema.optionalKey(AppearanceThemeSettingsPatch),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  worktreeBranchPrefix: Schema.optionalKey(TrimmedNonEmptyString),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  notifications: Schema.optionalKey(
    Schema.Struct({
      sessionNeedsAttention: Schema.optionalKey(Schema.Boolean),
      sessionCompleted: Schema.optionalKey(Schema.Boolean),
      deliberationConcluded: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
    }),
  ),
  appearance: Schema.optionalKey(AppearanceSettingsPatch),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
