# Agent Integration

## The Core Problem

Forge manages agents (Claude Code, Codex) within sessions. But these agents are complex systems with their own tools, context management, and interaction patterns. The integration isn't just "start a process and read its output." It's: how does forge provide structure, inject context, intercept actions, and enable communication without breaking the agent's native capabilities?

In the sessions-first model, everything is a session. Child sessions replace what was previously the `agents` table. A child session is a leaf session running a provider. Child sessions are started within parent sessions (for agent sessions) or within phase_runs (for workflow sessions).

## Provider Integration Models

### Claude Code via Agent SDK

The `@anthropic-ai/claude-agent-sdk` provides programmatic control over Claude Code sessions. t3-code already uses this.

**What the SDK gives us:**

- Start a session with system prompt, tools, context
- Send turns (user messages) and receive streaming responses
- Intercept tool calls (approve, modify, or handle them ourselves)
- Inject context between turns
- Track token usage

**What forge adds on top:**

- Phase-specific system prompts (implement, review, deliberation role prompts)
- Channel tool injection (read_channel, post_to_channel tools for multi-agent)
- Correction injection (human guidance appears as high-priority context on next turn)
- Quality gate integration (run checks after child session signals completion)
- Child session persistence (resume from transcript on restart)

**How correction injection works with Claude:**

```typescript
// When human posts a correction to the guidance channel:
async injectCorrection(childSession: ClaudeSession, correction: string): Promise<void> {
  // On the next turn, prepend correction as a system-level instruction
  childSession.addContext({
    role: "user",
    content: `[CORRECTION FROM HUMAN - ADDRESS THIS FIRST]\n${correction}`,
  })
}
```

The correction appears as a high-priority message that the agent sees before continuing its work. It's not a tool call, it's not a system prompt change - it's a turn injection that the agent treats as the user redirecting their work.

**Note on correction latency:** Corrections are delivered between turns only. For long-running child session turns (10+ minutes of tool calls), the correction waits with no feedback. The UI should show 'Correction queued — will be delivered on next turn.' Codex API may support `turn/steer` (not yet used in current codebase; feasibility unverified) for mid-turn injection, which could reduce latency. This is a v2 enhancement.

### Codex via Subprocess

Codex runs as a separate process (`codex app-server`), communicating via JSON-RPC over stdio. t3-code wraps this in `CodexAppServerManager`.

**What the subprocess gives us:**

- Session create/resume
- Turn submission
- Event streaming (tool calls, file changes, reasoning)
- Approval request/response

**What forge adds:**

- Same phase-specific prompts
- Correction injection (via turn submission with correction context)
- Quality gate integration
- Channel participation (Codex uses file-based or stdio-based communication for channels)

**Codex channel participation challenge:**
Codex doesn't have the same tool injection flexibility as Claude SDK. Options:

1. **File-based channels**: Child session reads/writes a known file path. Forge watches the file.
2. **Turn injection**: Forge injects channel messages as user turns between child session work.
3. **Codex tool API**: If Codex supports custom tools, use the same pattern as Claude.

Option 2 is most reliable. Between child session turns, forge sends a turn that includes new channel messages. The agent sees them and responds.

## Channel Tools for Multi-Agent

When an agent participates in a deliberation, it needs tools to interact with the shared channel.

```typescript
// Tools injected into child sessions for multi-agent phases
const channelTools = [
  {
    name: "post_to_channel",
    description:
      "Post a message to the shared deliberation channel. Other agents and the human can see this.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Your message to post" },
      },
      required: ["message"],
    },
  },
  {
    name: "read_channel",
    description: "Read unread messages from the shared channel.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "propose_conclusion",
    description:
      "Propose that the deliberation has reached a conclusion. The other participant must agree for the deliberation to end.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Your summary of the conclusion" },
      },
      required: ["summary"],
    },
  },
];
```

When the child session calls `post_to_channel`, forge intercepts the tool call:

1. Persists the message to the channel in SQLite
2. Returns success to the calling child session
3. Notifies the other child session(s) that new messages are available
4. Pushes the message to the frontend via WebSocket

When the child session calls `read_channel`, forge:

1. Queries messages after the child session's read cursor position. Returns them as the tool result. **Does NOT advance the cursor.** The cursor advances implicitly when the child session posts (on `channel.message-posted` event) or proposes conclusion (on `channel.conclusion-proposed` event). For Codex, the cursor advances at injection time. This makes `read_channel` idempotent. See [11-channel-tool-contract.md](./11-channel-tool-contract.md) for the canonical read-cursor invariant.

This is the HerdingLlamas pattern, but managed by forge instead of by CLI commands.

## Context Management

### Phase Prompts

Each workflow phase has a prompt template. Variables are substituted at runtime.

```typescript
interface PromptTemplate {
  system: string; // role, constraints, methodology
  initial: string; // first user message to kick off the phase
  variables: string[]; // what gets substituted: {{SESSION_DESCRIPTION}}, {{PREVIOUS_FINDINGS}}, etc.
}
```

**Variable sources:**

- `{{SESSION_DESCRIPTION}}` - from the session
- `{{SESSION_TITLE}}` - from session title
- `{{PREVIOUS_FINDINGS}}` - from previous phase's channel/output
- `{{ITERATION_CONTEXT}}` - accumulated context from previous loop iterations
- `{{QUALITY_CHECK_RESULTS}}` - what failed last time (for retry iterations)
- `{{CORRECTION_HISTORY}}` - corrections human has posted for this session (for awareness)
- `{{CODEBASE_CONTEXT}}` - relevant files, recent changes (auto-gathered)

### Iteration context accumulation

When a build loop retries, the agent needs to know what happened in previous iterations. This is ralph-loops' key insight.

```typescript
async function buildIterationContext(sessionId: SessionId, phaseRuns: PhaseRun[]): Promise<string> {
  const sections = [];
  for (const [i, run] of phaseRuns.entries()) {
    const output = await db.query(
      "SELECT content FROM phase_outputs WHERE phase_run_id = ? AND output_key = ?",
      run.id,
      "output",
    );
    const corrections = await db.query(
      "SELECT content FROM phase_outputs WHERE phase_run_id = ? AND output_key = ?",
      run.id,
      "corrections",
    );
    const qualityChecks = run.quality_checks_json ? JSON.parse(run.quality_checks_json) : [];

    sections.push(`## Iteration ${i + 1}
### What was attempted
${output?.content || "No output recorded"}
### Quality check results
${qualityChecks.map((q: any) => `- ${q.name}: ${q.passed ? "PASS" : "FAIL"} ${q.output || ""}`).join("\n")}
### Corrections received
${corrections?.content || "None"}`);
  }
  return sections.join("\n---\n");
}
```

This context gets injected as `{{ITERATION_CONTEXT}}` in the phase prompt. The agent sees what was tried, what failed, what the human corrected. It doesn't start fresh.

## Child Session Lifecycle

### Start

```
1. Session starts workflow phase (or agent session starts directly)
2. Engine selects provider based on phase config
3. Engine builds prompt from template + variables
4. Engine calls provider adapter: startChildSession(prompt, tools, config)
5. Provider adapter:
   - Claude: creates SDK session with prompt + custom tools
   - Codex: spawns app-server subprocess, sends create request
6. Child session record created in sessions table
7. Frontend notified via push event
```

### Running

```
8. Child session works (tool calls, file edits, reasoning)
9. Provider adapter streams events to engine
10. Engine persists transcript entries
11. Engine pushes events to frontend
12. If human posts correction:
    a. Engine persists to guidance channel
    b. Engine injects into child session context (on next turn)
    c. Agent sees correction, adjusts
13. If child session calls channel tool (multi-agent):
    a. Engine intercepts tool call
    b. Engine persists message to channel
    c. Engine notifies other child sessions
    d. Engine pushes to frontend
```

### Completion

```
14. Child session signals completion (or max turns reached)
15. Engine evaluates gate:
    - Auto: check conditions
    - Quality-check: run scripts
    - Human: pause and notify
16. Gate result determines next action:
    - Continue: advance to next phase
    - Retry: loop back with accumulated context
    - Fail: mark session failed
17. Child session marked completed
18. Frontend notified
```

### Recovery

If the app crashes or restarts mid-session:

### Provider Recovery Matrix

**Claude (Agent SDK):**

- **Resume method**: Pass stored session ID as `resume` parameter on `query()`. Works if server-side session is still alive (empirically observed ~1 hour TTL; NOT officially documented and may change). The fallback (context summary) is the normative recovery path. Resume is an optimization — the system must be correct when resume fails.
- **Fallback**: Start fresh child session with context summary (session description + iteration context + last N transcript entries + pending corrections). Not full transcript replay — too expensive for long sessions.
- **What's lost on crash**: In-flight streaming response, pending tool call results, ephemeral state not captured in tool calls/files.
- **User-visible degradation**: "Child session interrupted. Resuming with context summary. Recent work may be repeated."

**Codex (app-server subprocess):**

- **Resume method**: Restart subprocess, call `thread/resume` with stored thread ID from the child session's `resume_cursor_json`. Thread conversation history is server-managed by Codex.
- **Fallback**: If thread doesn't exist (Codex state lost), start fresh with context summary.
- **What's lost on crash**: In-flight turn response, unsent tool call results.
- **User-visible degradation**: "Codex child session resumed" or "Codex child session restarted with context summary."

## Provider Capability Matrix

| Capability         | Claude (Agent SDK)                                                                      | Codex (app-server)                                    | Forge integration                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| User questions     | AskUserQuestion tool with structured questions (header, question, options, multiSelect) | item/tool/requestUserInput                            | interactive_request (type: user-input). Structured question format carries forward.               |
| Model switch       | In-session via setModel()                                                               | Per-turn override (becomes default for later turns)   | Allow per-turn model override. No session restart needed.                                         |
| Subagents          | task.started/progress/completed events, synthetic turns for background responses        | collabAgentToolCall, parent/child thread tracking     | v1: passthrough (surface in transcript as nested activity). v2: map to forge child session model. |
| Session resume     | Session ID parameter on query() (~1hr server-side TTL)                                  | thread/resume by thread ID                            | Resume cursor stored in sessions.resume_cursor_json                                               |
| Rollback           | N/A (context summary is the fallback)                                                   | thread/rollback by turn count                         | Primary mechanism for Codex checkpoint revert                                                     |
| Collaboration mode | N/A                                                                                     | plan/default with per-mode developer_instructions     | Maps to interaction mode per workflow phase                                                       |
| Approval policy    | canUseTool callback with PermissionResult                                               | approvalPolicy: untrusted/on-failure/on-request/never | Mapped from session.runtime_mode (supervised -> on-request, autonomous -> never)                  |
| Sandbox mode       | No native sandbox (enforced via canUseTool approval/deny)                               | sandbox: read-only/workspace-write/danger-full-access | Mapped from phase config sandboxMode                                                              |
| acceptForSession   | In-memory via updatedPermissions in canUseTool return                                   | N/A                                                   | Ephemeral. Dies with provider child session. Not persisted.                                       |
| File change diffs  | N/A                                                                                     | turn/diff/updated, fileChange items with diffs        | Consumed by CheckpointReactor for checkpoint creation                                             |

| Structured approvals | 9 CanonicalRequestTypes (file_read, file_change, command_execution, etc.) | Request methods per type | interactive_request.payload includes requestType for typed UI |

### Subagent Decision (v1/v2)

v1: Subagent events from both providers are treated as passthrough. Claude's subagent events (task.started/progress/completed in Claude's native event model) and Codex's collabAgentToolCall are surfaced in the child session transcript as nested activities. The UI shows them as indented blocks within the main conversation. Token usage is tracked on the parent child session (not separated).

v2: Map provider subagents to forge's child session model. A subagent becomes a nested child session within the same phase_run. This enables: separate token tracking, separate transcript, and potential human interaction with individual subagents.

## Challenges

### Tool Call Interception Boundaries

Forge needs to intercept some tool calls (channel tools) but let others through (file edits, command execution). The interception logic needs to be:

- Fast (agent is waiting for the tool result)
- Reliable (don't accidentally swallow a tool call)
- Transparent (the agent doesn't know its tool calls are being intercepted)

For Claude SDK: the approval mechanism naturally provides this. Forge can approve/handle each tool call.
For Codex: approval requests come via JSON-RPC events. Same pattern, different protocol.

### Reliability in Using Channel Tools

Agents sometimes ignore tools or use them incorrectly. For deliberation to work, child sessions MUST use channel tools. Strategies:

- Strong system prompts that emphasize tool usage
- Nudge mechanism: if child session hasn't posted in N turns, inject a reminder
- Timeout: if child session goes silent for too long, assume it's stuck and notify human

### Provider capability differences

Claude and Codex have different capabilities:

- Claude: better at long reasoning, better tool following
- Codex: faster, different tool model, may handle code changes differently

For multi-agent deliberation, provider differences can be a feature (different perspectives) or a bug (different reliability). Need to test which combinations work well.

### Token Budget Management

Long-running child sessions burn tokens. Build loops with multiple iterations can get expensive. Need:

- Token usage tracking per child session, per phase, per session
- Budget limits (configurable per session or workflow)
- Warning when approaching budget
- Automatic pause when budget exceeded

t3-code tracks token usage. Forge inherits and extends with budget controls.

### Workspace Isolation

Each session should run in an isolated git worktree. This prevents:

- Child sessions in different sessions stepping on each other's changes
- Merge conflicts during parallel execution
- Lost work if a session fails

t3-code supports worktrees. Forge makes them mandatory for workflow sessions (not optional). Agent sessions create a fresh worktree (per doc 13's worktree lifecycle). Local mode and worktree adoption from t3-code are intentionally dropped.

## Open Questions

1. **Should agents know they're in a workflow?** Should the system prompt tell the agent "you're in the implement phase of a build-loop workflow, iteration 2 of 5"? Pro: agent can be more strategic. Con: agents might try to game the workflow (claim completion early, skip quality checks).

2. **How do we handle agents that refuse corrections?** Sometimes an agent will acknowledge a correction but not actually change behavior. Need a mechanism to detect this (compare post-correction output to pre-correction patterns) and escalate.

3. **Should forge manage the agent's tool set?** Should forge control which tools the agent has access to per phase? (e.g., no file write during review phase, no web search during implement phase). This could prevent certain failure modes but limits agent capability.

4. **How do we handle agent-initiated questions?** Sometimes an agent needs to ask the human a clarifying question (not a correction, but "should I use approach A or B?"). This should trigger a gate-like pause. How does the agent signal this? Special tool call? Pattern in output?

## Related Documents

- [01-architecture.md](./01-architecture.md) - Where agents fit in the system
- [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) - Sessions-first data model
- [04-workflow-engine.md](./04-workflow-engine.md) - How workflow sessions are orchestrated
- [08-deliberation.md](./08-deliberation.md) - Multi-agent patterns
