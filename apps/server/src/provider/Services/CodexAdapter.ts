/**
 * CodexAdapter - Codex implementation of the generic provider adapter contract.
 *
 * This service owns Codex app-server process / JSON-RPC semantics and emits
 * Codex provider events. It does not perform cross-provider routing, shared
 * event fan-out, or checkpoint orchestration.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "codex"` context.
 *
 * @module CodexAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DynamicToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export type DynamicToolCallHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ content: string; success: boolean }>;

/**
 * CodexAdapterShape - Service API for the Codex provider adapter.
 */
export interface CodexAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "codex";
  readonly registerDynamicTools: (
    threadId: string,
    tools: DynamicToolRegistration[],
    handler: DynamicToolCallHandler,
  ) => void;
}

/**
 * CodexAdapter - Service tag for Codex provider adapter operations.
 */
export class CodexAdapter extends ServiceMap.Service<CodexAdapter, CodexAdapterShape>()(
  "forge/provider/Services/CodexAdapter",
) {}
