import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

import { resolveForgeCliCommand } from "../mcp/cliEntrypoint.ts";
import { catchToErrorResult, textResult } from "../mcp/mcpHelpers.ts";

export interface DesignMcpServerInput {
  readonly serverName?: string;
  readonly onRenderDesign: (input: {
    readonly html: string;
    readonly title: string;
    readonly description?: string;
  }) => Promise<{ readonly artifactId: string; readonly status: string }>;
  readonly onPresentOptions: (input: {
    readonly prompt: string;
    readonly options: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly html: string;
    }>;
  }) => Promise<{ readonly chosen: string; readonly title: string }>;
}

const DEFAULT_SERVER_NAME = "forge-design";
const DESIGN_MCP_SUBCOMMAND = "design-mcp";

export function makeDesignMcpServer(input: DesignMcpServerInput) {
  return createSdkMcpServer({
    name: input.serverName ?? DEFAULT_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        "render_design",
        "Render a complete, self-contained HTML/CSS/JS design mockup in the user's preview panel. The HTML must be a full document with <!DOCTYPE html>, <html>, <head>, and <body> tags. Include all CSS inline or via CDN links. Include all JavaScript inline or via CDN script tags. The document must be viewable standalone in a browser.",
        {
          html: z.string().min(1).describe("Complete self-contained HTML document"),
          title: z.string().min(1).describe("Short descriptive title for this design"),
          description: z.string().optional().describe("Design rationale and what this represents"),
        },
        async (args) => {
          try {
            const renderInput = {
              html: args.html,
              title: args.title,
              ...(args.description !== undefined ? { description: args.description } : {}),
            };
            const result = await input.onRenderDesign(renderInput);
            return textResult({
              content: JSON.stringify({
                status: result.status,
                artifactId: result.artifactId,
              }),
              success: true,
            });
          } catch (cause) {
            return catchToErrorResult(cause, "Failed to render design.");
          }
        },
      ),
      tool(
        "present_options",
        "Present multiple design options for the user to choose between. Each option is a complete HTML document rendered in the preview panel. The tool call will block until the user makes a selection. Use this when the design direction is unclear and you want the user to pick between distinct approaches.",
        {
          prompt: z.string().min(1).describe("What you're asking the user to decide"),
          options: z
            .array(
              z.object({
                id: z.string().min(1).describe("Short identifier like 'a', 'b', 'c'"),
                title: z.string().min(1).describe("Option name, e.g. 'Minimal & Clean'"),
                description: z.string().min(1).describe("What makes this option distinct"),
                html: z
                  .string()
                  .min(1)
                  .describe("Complete self-contained HTML document for this option"),
              }),
            )
            .min(2)
            .describe("At least 2 design options"),
        },
        async (args) => {
          try {
            const result = await input.onPresentOptions(args);
            return textResult({
              content: JSON.stringify({ chosen: result.chosen, title: result.title }),
              success: true,
            });
          } catch (cause) {
            return catchToErrorResult(cause, "Failed to present design options.");
          }
        },
      ),
    ],
  });
}

export function makeDesignCodexMcpServerConfig(input: {
  readonly bridgeUrl: string;
  readonly bridgeToken: string;
  readonly bridgeAuthToken?: string;
  readonly serverName?: string;
}) {
  const serverName = input.serverName ?? DEFAULT_SERVER_NAME;
  const command = resolveForgeCliCommand(DESIGN_MCP_SUBCOMMAND);

  return {
    command: command.command,
    args: [...command.args],
    env: {
      FORGE_DESIGN_BRIDGE_URL: input.bridgeUrl,
      FORGE_DESIGN_BRIDGE_TOKEN: input.bridgeToken,
      FORGE_DESIGN_SERVER_NAME: serverName,
      ...(input.bridgeAuthToken === undefined
        ? {}
        : { FORGE_DESIGN_BRIDGE_AUTH_TOKEN: input.bridgeAuthToken }),
    },
    tools: {
      render_design: {
        approval_mode: "prompt",
      },
      present_options: {
        approval_mode: "prompt",
      },
    },
  } as const;
}
