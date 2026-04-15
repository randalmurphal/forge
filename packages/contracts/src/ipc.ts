import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitStatusInput,
  GitStatusResult,
  GitWorkingTreeDiffInput,
  GitWorkingTreeDiffResult,
} from "./git";
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type {
  ServerConfig,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingResult,
} from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type { ThreadId } from "./baseSchemas";
import type { ServerUpsertKeybindingInput } from "./server";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetCommandOutputInput,
  OrchestrationGetCommandOutputResult,
  ForgeEvent,
  OrchestrationClientSnapshot,
  OrchestrationGetSubagentActivityFeedInput,
  OrchestrationGetSubagentActivityFeedResult,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetFullThreadAgentDiffInput,
  OrchestrationGetFullThreadAgentDiffResult,
  OrchestrationThreadDetailSnapshot,
  OrchestrationGetTurnAgentDiffInput,
  OrchestrationGetTurnAgentDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationReadModel,
} from "./orchestration";
import { EditorId } from "./editor";
import { ServerSettings, ServerSettingsPatch } from "./settings";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export interface WslDistroInfo {
  readonly name: string;
  readonly isDefault: boolean;
  readonly state: string;
  readonly version: number;
}

export interface WslForgeCheckResult {
  readonly path?: string;
  readonly error?: string;
}

export interface ConnectionConfig {
  readonly mode: "local" | "wsl" | "external";
  readonly wslDistro?: string;
  readonly wslForgePath?: string;
  readonly wslPort?: number;
  readonly wslAuthToken?: string;
  readonly externalWsUrl?: string;
  readonly externalLabel?: string;
}

export interface ConnectionTestResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  // Connection management
  getConnectionConfig: () => Promise<ConnectionConfig | null>;
  testConnection: (wsUrl: string) => Promise<ConnectionTestResult>;
  saveConnection: (config: ConnectionConfig) => Promise<void>;
  clearConnection: () => Promise<void>;
  // WSL integration
  getWslDistros: () => Promise<WslDistroInfo[]>;
  checkWslForge: (distro: string) => Promise<WslForgeCheckResult>;
  // WSL editor support
  openInEditor: (target: string, editor: EditorId) => Promise<boolean>;
  getAvailableEditors: () => Promise<EditorId[] | null>;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    getWorkingTreeDiff: (input: GitWorkingTreeDiffInput) => Promise<GitWorkingTreeDiffResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    refreshProviders: () => Promise<ServerProviderUpdatedPayload>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    getClientSnapshot: () => Promise<OrchestrationClientSnapshot>;
    getThreadDetail: (input: { threadId: ThreadId }) => Promise<OrchestrationThreadDetailSnapshot>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    getCommandOutput: (
      input: OrchestrationGetCommandOutputInput,
    ) => Promise<OrchestrationGetCommandOutputResult>;
    getSubagentActivityFeed: (
      input: OrchestrationGetSubagentActivityFeedInput,
    ) => Promise<OrchestrationGetSubagentActivityFeedResult>;
    getTurnAgentDiff: (
      input: OrchestrationGetTurnAgentDiffInput,
    ) => Promise<OrchestrationGetTurnAgentDiffResult>;
    getFullThreadAgentDiff: (
      input: OrchestrationGetFullThreadAgentDiffInput,
    ) => Promise<OrchestrationGetFullThreadAgentDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<ForgeEvent[]>;
    onDomainEvent: (callback: (event: ForgeEvent) => void) => () => void;
  };
}
