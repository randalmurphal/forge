/**
 * Tool name classification and display helpers.
 *
 * Pure functions that map Claude tool names to canonical item types, request
 * types, and human-readable labels.
 *
 * @module claude/toolClassification
 */
import type { CanonicalItemType, CanonicalRequestType } from "@forgetools/contracts";

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();

  // Agent/subagent tools — exact matches first
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  // Compound agent names (e.g. "dispatch_agent"), but not "useragent" false positives
  if (normalized.includes("agent") && !normalized.includes("useragent")) {
    return "collab_agent_tool_call";
  }

  // Command execution
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }

  // Search tools (before file_change since "grep" etc. shouldn't match file patterns)
  if (
    normalized === "grep" ||
    normalized === "glob" ||
    normalized.includes("search") ||
    normalized.includes("toolsearch")
  ) {
    return "search";
  }

  // File read tools
  if (
    normalized === "read" ||
    normalized.includes("readfile") ||
    normalized.includes("read_file") ||
    normalized.includes("read-file") ||
    normalized === "view"
  ) {
    return "file_read";
  }

  // File change tools
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("notebookedit") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }

  // MCP tools (identified by prefix pattern)
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }

  if (
    normalized.includes("websearch") ||
    normalized.includes("web_search") ||
    normalized.includes("web search")
  ) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  switch (itemType) {
    case "command_execution":
      return "command_execution_approval";
    case "file_change":
      return "file_change_approval";
    case "file_read":
    case "search":
      return "file_read_approval";
    default:
      return "dynamic_tool_call";
  }
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const description =
    typeof input.description === "string" && input.description.trim().length > 0
      ? input.description.trim()
      : undefined;
  if (description) {
    return `${toolName}: ${description.slice(0, 400)}`;
  }

  const prompt =
    typeof input.prompt === "string" && input.prompt.trim().length > 0
      ? input.prompt.trim()
      : undefined;
  if (prompt) {
    return `${toolName}: ${prompt.slice(0, 400)}`;
  }

  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized === "{}") {
    return toolName;
  }
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command";
    case "file_change":
      return "File change";
    case "file_read":
      return "File read";
    case "search":
      return "Search";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}
