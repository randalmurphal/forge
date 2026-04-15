import { createHash } from "node:crypto";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  ChannelId,
  ChannelMessageId,
  CommandId,
  PositiveInt,
  ThreadId,
} from "@forgetools/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { z } from "zod/v4";

import { catchToErrorResult, stringifyResult, type McpTextResult } from "../../mcp/mcpHelpers.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ChannelServiceChannelNotFoundError } from "../Errors.ts";
import { ChannelService } from "../Services/ChannelService.ts";

const TOOL_CALL_PROVIDER = "claudeAgent";
const DEFAULT_SERVER_NAME = "forge-channels";
const decodePositiveInt = Schema.decodeSync(PositiveInt);

export interface McpChannelServerInput {
  readonly channelId: ChannelId;
  readonly participantThreadId: ThreadId;
  readonly participantRole?: string;
  readonly serverName?: string;
}

export interface ChannelMcpToolHandlers {
  readonly postToChannel: (input: { readonly message: string }) => Promise<McpTextResult>;
  readonly readChannel: (input?: { readonly limit?: number | undefined }) => Promise<McpTextResult>;
  readonly proposeConclusion: (input: { readonly summary: string }) => Promise<McpTextResult>;
}

export interface McpChannelServerRuntime {
  readonly config: ReturnType<typeof createSdkMcpServer>;
  readonly handlers: ChannelMcpToolHandlers;
}

function nowIso(): string {
  return new Date().toISOString();
}

function idempotencyKey(
  sessionId: ThreadId,
  toolName: string,
  args: unknown,
  channelSequence: number,
): string {
  return createHash("sha256")
    .update(`${sessionId}:${toolName}:${JSON.stringify(args)}:${channelSequence}`)
    .digest("hex");
}

export const makeChannelMcpToolHandlers = Effect.fn("makeChannelMcpToolHandlers")(function* (
  input: McpChannelServerInput,
) {
  const channelService = yield* ChannelService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  const services = yield* Effect.services();

  const run = Effect.runPromiseWith(services);
  const postChannelMessage = channelService.postMessage;

  const getChannel = Effect.fn("McpChannelServer.getChannel")(function* () {
    const readModel = yield* orchestrationEngine.getRuntimeReadModel();
    const channel = readModel.channels.find((candidate) => candidate.id === input.channelId);
    if (!channel) {
      return yield* new ChannelServiceChannelNotFoundError({
        channelId: input.channelId,
      });
    }
    return {
      readModel,
      channel,
    } as const;
  });

  const getChannelStreamVersion = Effect.fn("McpChannelServer.getChannelStreamVersion")(
    function* () {
      const rows = yield* sql<{ readonly streamVersion: number | null }>`
      SELECT MAX(stream_version) AS "streamVersion"
      FROM orchestration_events
      WHERE aggregate_kind = 'channel'
        AND stream_id = ${input.channelId}
    `;

      return rows[0]?.streamVersion ?? -1;
    },
  );

  const getCachedToolResult = Effect.fn("McpChannelServer.getCachedToolResult")(function* (
    toolName: string,
    callId: string,
  ) {
    const rows = yield* sql<{ readonly resultJson: string }>`
      SELECT result_json AS "resultJson"
      FROM tool_call_results
      WHERE provider = ${TOOL_CALL_PROVIDER}
        AND thread_id = ${input.participantThreadId}
        AND call_id = ${callId}
        AND tool_name = ${toolName}
      LIMIT 1
    `;

    const row = rows[0];
    if (!row) {
      return null;
    }

    return JSON.parse(row.resultJson) as McpTextResult;
  });

  const storeToolResult = Effect.fn("McpChannelServer.storeToolResult")(function* (
    toolName: string,
    callId: string,
    result: McpTextResult,
  ) {
    yield* sql`
      INSERT INTO tool_call_results (
        provider,
        thread_id,
        call_id,
        tool_name,
        result_json,
        created_at
      )
      VALUES (
        ${TOOL_CALL_PROVIDER},
        ${input.participantThreadId},
        ${callId},
        ${toolName},
        ${JSON.stringify(result)},
        ${nowIso()}
      )
      ON CONFLICT (provider, thread_id, call_id)
      DO NOTHING
    `;
  });

  const resolveParticipantThreadIds = Effect.fn("McpChannelServer.resolveParticipantThreadIds")(
    function* () {
      const { readModel, channel } = yield* getChannel();
      const currentThread = readModel.threads.find(
        (thread) => thread.id === input.participantThreadId,
      );
      const phaseRunId = channel.phaseRunId ?? currentThread?.phaseRunId ?? null;
      const participantIds = new Set<string>();

      for (const thread of readModel.threads) {
        const sameParent = thread.parentThreadId === channel.threadId;
        const includedByParent = readModel.threads
          .find((candidate) => candidate.id === channel.threadId)
          ?.childThreadIds.includes(thread.id);
        if (!sameParent && !includedByParent) {
          continue;
        }
        if (thread.deletedAt !== null) {
          continue;
        }
        if (phaseRunId !== null && thread.phaseRunId !== phaseRunId) {
          continue;
        }
        participantIds.add(thread.id);
      }

      participantIds.add(input.participantThreadId);
      return Array.from(participantIds)
        .map((threadId) => ThreadId.makeUnsafe(threadId))
        .toSorted();
    },
  );

  const getConclusionProposals = Effect.fn("McpChannelServer.getConclusionProposals")(function* () {
    const rows = yield* sql<{
      readonly threadId: string;
      readonly summary: string;
    }>`
      SELECT
        json_extract(payload_json, '$.threadId') AS "threadId",
        json_extract(payload_json, '$.summary') AS "summary"
      FROM orchestration_events
      WHERE aggregate_kind = 'channel'
        AND stream_id = ${input.channelId}
        AND event_type = 'channel.conclusion-proposed'
      ORDER BY sequence ASC
    `;

    const proposals = new Map<ThreadId, string>();
    for (const row of rows) {
      proposals.set(ThreadId.makeUnsafe(row.threadId), row.summary);
    }
    return proposals;
  });

  const withIdempotentResult = async (
    toolName: string,
    args: unknown,
    runTool: (callId: string) => Promise<McpTextResult>,
  ): Promise<McpTextResult> => {
    const channelStreamVersion = await run(getChannelStreamVersion());
    const callId = idempotencyKey(input.participantThreadId, toolName, args, channelStreamVersion);
    const cached = await run(getCachedToolResult(toolName, callId));
    if (cached !== null) {
      return cached;
    }

    const result = await runTool(callId);
    await run(storeToolResult(toolName, callId, result));
    return result;
  };

  const handlers: ChannelMcpToolHandlers = {
    postToChannel: async ({ message }) => {
      try {
        return await withIdempotentResult("post_to_channel", { message }, async (callId) => {
          const createdAt = nowIso();
          const persistedMessage = await run(
            postChannelMessage({
              channelId: input.channelId,
              fromType: "agent",
              fromId: input.participantThreadId,
              ...(input.participantRole === undefined ? {} : { fromRole: input.participantRole }),
              content: message,
              cursorThreadId: input.participantThreadId,
              messageId: ChannelMessageId.makeUnsafe(`channel-message:${callId}`),
              commandId: CommandId.makeUnsafe(`channel:mcp:post:${callId}`),
              createdAt,
            }),
          );

          return stringifyResult({
            messageId: persistedMessage.id,
            sequence: persistedMessage.sequence,
          });
        });
      } catch (cause) {
        return catchToErrorResult(cause, "Channel MCP tool failed.");
      }
    },

    readChannel: async ({ limit } = {}) => {
      try {
        const cursor = await run(
          channelService.getCursor({
            channelId: input.channelId,
            sessionId: input.participantThreadId,
          }),
        );

        const normalizedLimit = limit === undefined ? undefined : decodePositiveInt(limit);
        return await withIdempotentResult(
          "read_channel",
          {
            cursor,
            limit: normalizedLimit,
          },
          async () => {
            const messages = await run(
              channelService.getMessages({
                channelId: input.channelId,
                afterSequence: cursor,
                ...(normalizedLimit === undefined ? {} : { limit: normalizedLimit }),
              }),
            );

            return stringifyResult({
              afterSequence: cursor,
              messages,
            });
          },
        );
      } catch (cause) {
        return catchToErrorResult(cause, "Channel MCP tool failed.");
      }
    },

    proposeConclusion: async ({ summary }) => {
      try {
        return await withIdempotentResult(
          "propose_conclusion",
          {
            summary,
          },
          async (callId) => {
            const createdAt = nowIso();
            await run(
              orchestrationEngine.dispatch({
                type: "channel.conclude",
                commandId: CommandId.makeUnsafe(`channel:mcp:conclude:${callId}`),
                channelId: input.channelId,
                threadId: input.participantThreadId,
                summary,
                createdAt,
              } as unknown as Parameters<typeof orchestrationEngine.dispatch>[0]),
            );

            const [participantThreadIds, conclusionProposals] = await Promise.all([
              run(resolveParticipantThreadIds()),
              run(getConclusionProposals()),
            ]);
            const concluded = participantThreadIds.every((threadId) =>
              conclusionProposals.has(threadId),
            );

            return stringifyResult({
              proposed: true,
              concluded,
              participantThreadIds,
              conclusionProposals: Object.fromEntries(conclusionProposals),
            });
          },
        );
      } catch (cause) {
        return catchToErrorResult(cause, "Channel MCP tool failed.");
      }
    },
  };

  return handlers;
});

export const makeMcpChannelServer = Effect.fn("makeMcpChannelServer")(function* (
  input: McpChannelServerInput,
) {
  const handlers = yield* makeChannelMcpToolHandlers(input);

  const config = createSdkMcpServer({
    name: input.serverName ?? DEFAULT_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        "post_to_channel",
        "Post a message to the shared channel for the other participants.",
        {
          message: z.string().min(1),
        },
        (args) => handlers.postToChannel(args),
      ),
      tool(
        "read_channel",
        "Read unread messages from the shared channel without advancing the read cursor.",
        {
          limit: z.number().int().positive().max(1000).optional(),
        },
        (args) => handlers.readChannel(args),
      ),
      tool(
        "propose_conclusion",
        "Propose concluding the current deliberation and check whether all participants agree.",
        {
          summary: z.string().min(1),
        },
        (args) => handlers.proposeConclusion(args),
      ),
    ],
  });

  return {
    config,
    handlers,
  } satisfies McpChannelServerRuntime;
});
