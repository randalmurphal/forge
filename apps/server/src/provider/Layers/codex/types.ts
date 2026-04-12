/**
 * Codex adapter types, interfaces, and constants.
 *
 * Extracted from CodexAdapter.ts for reuse across the codex/ module tree.
 *
 * @module codex/types
 */
import type { CodexAppServerManager } from "../../../codexAppServerManager.ts";
import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";

export const PROVIDER = "codex" as const;

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: (
    services?: import("effect").ServiceMap.ServiceMap<never>,
  ) => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

export const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
