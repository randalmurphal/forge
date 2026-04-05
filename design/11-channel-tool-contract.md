# Channel Tool Contract

## Purpose

This document specifies exactly how child sessions interact with channels — the integration boundary between child sessions (provider interactions) and forge's orchestration engine. This was the critical gap (C1) identified during plan interrogation.

**Terminology note:** In this document, "session" when referring to a channel participant means the CHILD session (the leaf session running a provider). The parent session is the container (workflow or chat session). The channel MCP server is registered on child sessions. `channel_reads` is keyed by `session_id` (the child session).

## The Problem

Agents need to read and write to shared channels (for deliberation, corrections, etc.). But the mechanism for exposing channel operations to agents differs by provider:

- **Claude**: Supports in-process MCP servers via `mcpServers` parameter on `query()`. Forge hosts an MCP server per child session that handles channel tools. Channel MCP tools are listed in `allowedTools` so they execute without user approval prompts.
- **Codex**: Codex supports experimental `dynamicTools`, but we choose turn injection for v1 because dynamicTools are not yet stable. The `ChannelAdapter` interface abstracts over this difference, enabling upgrade to dynamicTools in v2 by swapping the Codex adapter implementation. Channel participation works via turn injection — forge injects channel messages as user turns between child session turns, and parses responses for channel-relevant content.

The deliberation engine must abstract over this difference. From the engine's perspective, child sessions post to and read from channels. How that happens is an adapter concern.

## Architecture

```
                    ┌──────────────────────┐
                    │  Deliberation Engine  │
                    │                      │
                    │  Monitors channels    │
                    │  Manages turn-taking  │
                    │  Detects conclusions  │
                    └──────┬───────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
   ┌──────────▼──────────┐  ┌──────────▼──────────┐
   │  Claude Channel      │  │  Codex Channel       │
   │  Adapter             │  │  Adapter              │
   │                      │  │                       │
   │  MCP server hosts    │  │  Turn injection +     │
   │  post/read/conclude  │  │  response parsing     │
   │  tools               │  │                       │
   └──────────┬───────────┘  └──────────┬────────────┘
              │                         │
   ┌──────────▼──────────┐  ┌──────────▼──────────┐
   │  Claude Agent SDK    │  │  Codex subprocess    │
   │  query() with        │  │  JSON-RPC over       │
   │  mcpServers option   │  │  stdio               │
   └──────────────────────┘  └──────────────────────┘
```

## Claude Integration: MCP Server

### Registration

When starting a Claude child session that participates in a channel, register the MCP server:

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

const channelMcp = createChannelMcpServer(engine, childSession, channel);

const queryOptions = {
  ...baseOptions,
  mcpServers: {
    "forge-channels": { type: "sdk", instance: channelMcp },
  },
  allowedTools: [
    "mcp__forge-channels__post_to_channel",
    "mcp__forge-channels__read_channel",
    "mcp__forge-channels__propose_conclusion",
  ],
};

const runtime = createQuery({ prompt, options: queryOptions });
```

### Tool Definitions

Three tools, matching the `propose_conclusion`-based termination model:

| Tool                 | Purpose                                                      | Side effects                                                            |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `post_to_channel`    | Post a message visible to other participants                 | Persists message, advances sequence, notifies others                    |
| `read_channel`       | Read unread messages                                         | None (read is pure query, cursor advances on child session's next post) |
| `propose_conclusion` | Signal that this child session thinks discussion is complete | Records proposal, checks if all child sessions agree                    |

### Idempotency

The Claude SDK handles replay internally during session resume — replayed tool calls use cached results from conversation history, they don't re-execute. We add our own layer as defense-in-depth using content hashing.

The idempotency key is a deterministic hash of the child session, tool, arguments, and channel sequence:

```typescript
import { createHash } from "crypto";

function idempotencyKey(
  sessionId: string,
  toolName: string,
  args: unknown,
  channelSeq: number,
): string {
  const input = `${sessionId}:${toolName}:${JSON.stringify(args)}:${channelSeq}`;
  return createHash("sha256").update(input).digest("hex");
}
```

In tool handlers:

```typescript
async handler({ message }) {
  const currentSeq = await engine.getChannelMaxSequence(channel.id);
  const key = idempotencyKey(childSession.id, "post_to_channel", { message }, currentSeq);

  const cached = await engine.getToolCallResult(childSession.provider, childSession.id, key);
  if (cached) return cached;

  const result = await engine.postToChannel(childSession.id, channel.id, message);
  await engine.cacheToolCallResult(childSession.provider, childSession.id, key, result);
  return result;
}
```

**`read_channel` idempotency**: Read does not advance the cursor. The cursor advances implicitly when the child session posts (the engine sets `last_read_sequence` to the current max when processing a post). This means:

- Replayed `read_channel` with same cursor → same messages → idempotent
- No separate ack needed
- No double-advance risk

**`post_to_channel` idempotency**: The content hash includes the current channel sequence, so identical messages posted at different points in the conversation produce different keys. A replayed post with the same content at the same sequence returns the cached result without inserting a duplicate.

### MCP Tool Permission Model

Channel MCP tools are listed in `allowedTools` so they execute without user approval prompts. This is correct — channel tools are forge's own domain. The `canUseTool` callback still fires for all OTHER tools not in `allowedTools`.

This means:

- Channel tools execute immediately — no approval latency for deliberation flow
- Error handling and observability must be in the tool handler itself (no approval callback to hook into)
- Non-channel tools (file edits, command execution, etc.) still go through normal approval
- The MCP server IS the integration boundary for channel operations

## Codex Integration: Turn Injection

### How It Works

Codex can't receive custom tools. Instead, the engine manages channel communication through the turn lifecycle:

```
1. Codex child session completes a turn
2. Engine checks: are there unread channel messages for this child session?
3. If yes: inject a synthetic user turn containing the new messages
4. Codex responds to the injected turn
5. Engine parses the response for:
   a. Content intended as a channel post → extract, persist to channel
   b. "PROPOSE CONCLUSION" signal → record conclusion proposal
6. Notify other participants
7. Wait for the other child session's response
```

### Turn Injection Format

```typescript
function formatChannelInjection(messages: ChannelMessage[]): string {
  const header =
    "═══ CHANNEL UPDATE ═══\n" +
    "New messages from other participants in the shared deliberation channel.\n" +
    "Read them carefully, then respond.\n\n";

  const body = messages.map((m) => `── ${m.fromRole || m.fromType} ──\n${m.content}`).join("\n\n");

  const footer =
    "\n\n═══ END CHANNEL UPDATE ═══\n\n" +
    "Instructions:\n" +
    "- Respond to the messages above with your analysis.\n" +
    "- Your entire response will be posted to the channel.\n" +
    "- If you believe the discussion has reached a conclusion, " +
    "begin your response with PROPOSE_CONCLUSION followed by a summary.";

  return header + body + footer;
}
```

### Response Parsing

```typescript
function parseCodexChannelResponse(response: string): {
  isConclusion: boolean;
  content: string;
} {
  const conclusionPrefix = "PROPOSE_CONCLUSION";
  if (response.trimStart().startsWith(conclusionPrefix)) {
    return {
      isConclusion: true,
      content: response.trimStart().slice(conclusionPrefix.length).trim(),
    };
  }
  return { isConclusion: false, content: response };
}
```

This parsing is scoped and deterministic — it's checking for an exact prefix, not classifying free text. The agent is explicitly instructed to use this prefix. If it doesn't, the response is treated as a regular channel post.

### PROPOSE_CONCLUSION Nudge

If Codex doesn't use the `PROPOSE_CONCLUSION` prefix for N consecutive turns AND the other child session has already proposed conclusion, inject a reminder nudge:

```
═══ REMINDER ═══
The other participant has proposed concluding the discussion.
If you agree, begin your next response with PROPOSE_CONCLUSION followed by your summary.
If you disagree, explain why and continue the discussion.
═══ END REMINDER ═══
```

This prevents Codex from silently ignoring the conclusion protocol and stalling the deliberation indefinitely.

### Correction Injection Latency

Codex supports `turn/steer` for mid-turn message injection, which could provide lower-latency corrections than waiting for the next turn. This is a v2 enhancement — v1 delivers corrections between turns only.

### Implicit Read Cursor

For Codex, the engine manages the read cursor entirely. When injecting messages, the engine:

1. Queries messages after the child session's `last_read_sequence`
2. Injects them as a turn
3. Advances the cursor to the latest message sequence

The cursor advance happens at injection time, not at response time. This is safe because:

- The engine controls when injection happens
- The Codex child session can't independently read the channel
- If the daemon crashes after injection but before response, the cursor is already advanced, and the response is lost — but the engine detects the orphaned turn and re-injects on recovery

### Orphaned Turn Detection

When the engine crashes after injecting messages but before receiving Codex's response, the response is lost. The `injectionState` field in `DeliberationState` tracks this:

```typescript
injectionState?: {
  sessionId: SessionId;
  injectedAtSequence: number;
  turnCorrelationId?: string;
  status: 'injected' | 'response-received' | 'persisted';
}
```

On recovery: if `injectionState.status === 'injected'`, the response was lost. Re-inject from that sequence. Use the Codex turn correlation ID as idempotency key for channel posts to prevent duplicates if the response was actually received but not persisted.

## Channel Adapter Interface

The deliberation engine interacts with channels through an adapter that hides provider differences:

```typescript
interface ChannelAdapter {
  // Post a message from this child session to the channel
  postMessage(sessionId: SessionId, content: string): Promise<MessageId>;

  // Get unread messages for this child session
  getUnread(sessionId: SessionId): Promise<ChannelMessage[]>;

  // Propose conclusion from this child session
  proposeConclusion(sessionId: SessionId, summary: string): Promise<void>;

  // Check if the child session can interact with channels natively (MCP) or needs injection
  readonly transportMode: "native" | "injection";
}

// Claude: native (MCP tools handle it)
// Codex: injection (engine manages turn injection/parsing)
```

For Claude child sessions, `postMessage` / `getUnread` / `proposeConclusion` are no-ops on the adapter level — the child session calls the MCP tools directly and the tool handlers dispatch to the engine.

For Codex child sessions, the adapter drives the injection cycle.

## Canonical Read-Cursor Invariant

Exactly three operations mutate `channel_reads.last_read_sequence`:

1. **`channel.message-posted` event (projector)**: When the projector processes this event, it sets `last_read_sequence = sequence` for the posting child session. Posting implies you've read everything up to that point.

2. **`channel.conclusion-proposed` event (projector)**: Same — proposing conclusion implies full read.

3. **Codex injection (engine-managed)**: When the engine injects channel messages into a Codex child session's turn, it advances the cursor. This is a direct DB write, not event-sourced. The injected sequence is recoverable from `deliberation_state_json.injectionState`.

The `channel.messages-read` event is AUDIT ONLY. It records that a read happened for traceability. The projector does NOT mutate `channel_reads` when processing this event. On event replay, cursor state reconstructs deterministically from message-posted and conclusion-proposed events only.

Doc 06 references this contract for the canonical read-cursor invariant.

## Deliberation Liveness State

Persisted in `phase_runs.deliberation_state_json`:

```typescript
interface DeliberationState {
  channelId: ChannelId;
  strategy: "ping-pong";

  // Turn tracking
  currentSpeaker: SessionId | null;
  turnCount: number;
  maxTurns: number;

  // Conclusion tracking
  conclusionProposals: Record<SessionId, string>; // sessionId (child) → summary
  concluded: boolean;

  // Liveness tracking
  lastPostTimestamp: Record<SessionId, string>; // ISO datetime
  nudgeCount: Record<SessionId, number>;
  maxNudges: number; // default 3
  stallTimeoutMs: number; // default 120000 (2 min)

  // Recovery
  phase: "deliberating"; // ping-pong turn-taking within a channeled phase

  // Codex injection tracking (see "Orphaned Turn Detection")
  injectionState?: {
    sessionId: SessionId;
    injectedAtSequence: number;
    turnCorrelationId?: string;
    status: "injected" | "response-received" | "persisted";
  };
}
```

### Recovery After Restart

```typescript
async function recoverDeliberation(phaseRun: PhaseRun, state: DeliberationState): Promise<void> {
  // 1. Check which child sessions are alive
  const childSessions = await db.query(
    "SELECT * FROM sessions WHERE parent_session_id = ? AND phase_run_id = ?",
    phaseRun.session_id,
    phaseRun.id,
  );

  for (const child of childSessions) {
    if (child.status === "failed" || child.status === "completed") {
      // Child session died. Restart it with channel context.
      await restartChildSessionWithChannelContext(child, state.channelId);
    }
  }

  // 2. Determine whose turn it is
  if (state.currentSpeaker) {
    const speaker = childSessions.find((s) => s.session_id === state.currentSpeaker);
    if (speaker && speaker.status === "active") {
      // Speaker is alive but may have stalled. Check last post time.
      const lastPost = state.lastPostTimestamp[state.currentSpeaker];
      if (lastPost && Date.now() - new Date(lastPost).getTime() > state.stallTimeoutMs) {
        // Stalled. Send nudge if under limit.
        if ((state.nudgeCount[state.currentSpeaker] || 0) < state.maxNudges) {
          await nudgeChildSession(speaker);
          state.nudgeCount[state.currentSpeaker] =
            (state.nudgeCount[state.currentSpeaker] || 0) + 1;
        } else {
          // Max nudges exceeded. Force conclusion or notify human.
          await notifyHuman(phaseRun.session_id, "Child session stalled during deliberation");
        }
      }
      // Otherwise: speaker is active, wait for them to post.
    }
  }

  // 3. Persist updated state
  await db.run(
    "UPDATE phase_runs SET deliberation_state_json = ? WHERE phase_run_id = ?",
    JSON.stringify(state),
    phaseRun.id,
  );
}
```

### Claude Nudge Limitation

Claude Agent SDK does not support host-initiated message injection into a running session. The SDK's `query()` returns an async iterable — the host reads from it but cannot push to it mid-stream.

This means: if a Claude child session stalls during deliberation (stops calling `read_channel` or `post_to_channel`), the engine CANNOT nudge it directly. The nudge only takes effect when the Claude child session next calls `read_channel` — the response includes any pending nudge text.

**Consequence for deliberation:** If Claude stops calling channel tools entirely (the agent decides to do local work instead of engaging), the engine has no way to interrupt it. The only recourse is:

1. Wait for the agent to naturally call a channel tool
2. Wait for max turns / timeout
3. Human intervention (pause the child session or cancel the session)

This is an asymmetry with Codex, where the engine can inject a turn at any time. The design accepts this limitation for v1. v2 could explore the Claude SDK's potential future support for mid-session message injection.

For nudge implementation: queue the nudge text. When the child session next calls `read_channel`, return the nudge as part of the result. If it calls `post_to_channel` instead (skipping read), the engine can include a note in the next `read_channel` result or rely on the other child session's response to redirect.

## Guidance Channel (Human Corrections)

The guidance channel is simpler than deliberation. No MCP tools needed. No turn injection parsing.

```
1. Human posts correction via UI (WebSocket request → engine → channel_messages)
2. Engine checks: is there an active child session for this session?
3. If yes: set a flag on the child session's prompt queue
4. On the child session's next turn start:
   - Claude: inject correction as a high-priority user message via prompt queue
   - Codex: inject correction as a synthetic user turn
5. Correction appears in the child session's context as:
   "[CORRECTION FROM HUMAN - PRIORITIZE THIS]\n{content}"
```

The guidance channel has one participant (human) posting, and one or more child sessions reading. There's no turn-taking, no conclusion, no liveness tracking. It's a one-way correction stream.

## Command/Event Naming Convention

Commands and events use distinct tense to prevent naming collisions. Commands are imperative (what to do), events are past-tense (what happened).

**InteractiveRequest commands** (imperative):

```typescript
type InteractiveRequestCommands =
  | {
      type: "request.open";
      requestId: RequestId;
      sessionId: SessionId;
      childSessionId?: SessionId;
      requestType: InteractiveRequestType;
      payload: unknown;
    }
  | { type: "request.resolve"; requestId: RequestId; resolvedWith: unknown }
  | { type: "request.mark-stale"; requestId: RequestId; reason: string };
```

**InteractiveRequest events** (past-tense):

```typescript
type InteractiveRequestEvents =
  | {
      type: "request.opened";
      requestId: RequestId;
      sessionId: SessionId;
      requestType: InteractiveRequestType;
    }
  | { type: "request.resolved"; requestId: RequestId }
  | { type: "request.stale"; requestId: RequestId; reason: string };
```

This pattern applies to all command/event pairs in the system. Commands express intent; events record outcomes. If a command type string reads as past-tense, it's wrong — rename it to imperative.

## Open Questions (Resolved)

These were open in earlier docs and are now resolved:

| Question                                   | Resolution                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| How does a child session "read" a channel? | Claude: MCP tool. Codex: turn injection.                                                                           |
| What triggers cursor advancement?          | Implicit on next post (Claude) or at injection time (Codex).                                                       |
| How do we ensure idempotency on replay?    | SDK handles replay from conversation history; defense-in-depth via content-hash keys in `tool_call_results`.       |
| Does the engine parse free text?           | Only for Codex `PROPOSE_CONCLUSION` prefix — deterministic, not heuristic. Deliberation gating is tool-call-based. |
| Where is deliberation state stored?        | `phase_runs.deliberation_state_json` in SQLite.                                                                    |

## Related Documents

- [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) — SQL table definitions
- [08-deliberation.md](./08-deliberation.md) — Deliberation patterns and workflows
- [06-agent-integration.md](./06-agent-integration.md) — Provider session lifecycle
