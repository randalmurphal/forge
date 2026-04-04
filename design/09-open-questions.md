# Open Questions & Research Needed

Cross-cutting questions that don't belong to a single document. These need answers before or during implementation.

## Architecture Decisions

### A1: Single process or split backend?
**Context:** The backend could be one process (workflow engine + provider sessions + WebSocket) or split (daemon process for orchestration + separate process for provider sessions).

**Single process pros:** Simpler deployment, no IPC, shared memory for state.
**Split process pros:** Provider sessions can crash without taking down orchestration. Daemon can run lightweight while sessions are heavy.

**Current lean:** Single process for v1. Split if we hit stability issues with provider sessions crashing.

### A2: Socket API protocol - same as WebSocket or separate?
**Context:** The WebSocket protocol uses typed push events with monotonic sequence numbers. The socket API for CLI/daemon communication could use the same protocol or a simpler request/response-only protocol.

**Same protocol pros:** One contract, code reuse.
**Separate protocol pros:** CLI doesn't need push events (it's request/response). Simpler implementation for CLI tools.

**Current lean:** Same JSON-RPC format, but CLI uses synchronous request/response while app uses bidirectional (request/response + push events). The protocol supports both modes.

### A3: How much of t3-code's event sourcing to keep?
**Context:** t3-code's event sourcing is well-designed (pure decider/projector). But the events are thread-centric and the runtime is Effect.js. Options:
- Keep the pattern, rewrite events for session model, rewrite runtime in plain TS
- Simplify to traditional CRUD + event log for audit
- Keep full event sourcing with replay/snapshot support

**Current lean:** Keep full event sourcing. The pattern is sound. The rewrite is in the runtime and event definitions, not the pattern itself. Replay capability is valuable for daemon recovery and debugging. **RESOLVED by doc 13:** The aggregate changes from "thread" to "session." Event types use `session.*` prefix.

## Data Model Questions

### D1: Transcript storage
**Options:** SQLite table, separate files (one per agent), hybrid (metadata in SQLite, content in files).

**Considerations:** Transcripts can be megabytes for long agents. SQLite handles this but the database grows. Separate files are easier to manage but harder to query.

**Needs research:** How large do transcripts actually get for typical agent interactions? Profile t3-code's existing database sizes.

### D2: Workflow definition storage
**Options:** YAML files in repo, JSON in SQLite, both with priority (files override database).

**Considerations:** Built-in workflows should be version-controlled. User workflows should be editable in the UI. Both need to coexist.

**Current lean:** Built-in workflows as YAML files bundled with the app. User workflows stored in SQLite, editable via UI. User workflows can override built-in by name.

### D3: Channel message granularity for event sourcing
**Options:** Each channel message is its own event. Or messages are batched per turn. Or channels are outside the event sourcing system entirely.

**Considerations:** Fine-grained events enable precise replay but increase storage. Coarse events are simpler but lose detail.

**Current lean:** Each channel message is an event. The volume is low (deliberation produces tens of messages, not thousands).

## UX Questions

### U1: Session creation flow
**Options:**
- Minimal: text input (describe what you want) + session type/workflow picker
- Guided: multi-step wizard (describe -> pick type -> configure -> confirm)
- Template-based: pick a template that pre-fills everything, just add description

**Considerations:** Most sessions will use the same 2-3 patterns. The creation flow shouldn't be heavy for the common case. Agent sessions (plain chat) should be as lightweight as starting a t3-code thread.

**Current lean:** Minimal input (title + description) with smart defaults. Agent sessions are the default. Workflow sessions require picking a workflow. Chat sessions require picking a pattern. **RESOLVED by doc 13:** Three session types (agent, workflow, chat) with type-appropriate creation flows.

### U2: How to handle multiple projects
**Options:**
- One forge instance per project (like t3-code today)
- Multi-project support with project switcher
- Global session list across all projects

**Considerations:** Users work on multiple repos. Switching between forge instances is friction. But multi-project in one instance adds complexity to worktree management and git operations.

**Current lean:** Multi-project with a project filter in the sidebar. Each project has its own workspace root. Sessions are always scoped to a project.

### U3: Diff viewer integration
**Options:**
- Inline in session view (collapsible)
- Dedicated diff panel (like t3-code's DiffPanel)
- Open in external editor (VS Code, etc.)
- All of the above

**Current lean:** Inline collapsible for small diffs, expandable panel for full review. "Open in editor" button for complex diffs. Don't try to replace a real diff tool.

## Technical Questions

### T1: Claude Agent SDK agent resume
**Question:** Does the Claude Agent SDK support resuming an agent from a checkpoint or transcript? Or must you start fresh and replay messages?

**Why it matters:** Daemon mode needs agent recovery after crashes. If we can resume, recovery is fast. If we must replay, it's expensive (re-sending the entire transcript as context).

**Needs research:** Read Agent SDK docs and test session lifecycle.

### T2: Codex tool injection
**Question:** Can Codex app-server accept custom tool definitions that the host process handles? Or are tools fixed by the Codex runtime?

**Why it matters:** Channel tools (post_to_channel, read_channel) need to be intercepted by forge. If Codex doesn't support custom tools, we need a workaround (file-based communication, turn injection).

**Needs research:** Read Codex app-server docs, test with custom tool definitions.

### T3: Electron notification click-through
**Question:** When an OS notification is clicked, can Electron reliably open and navigate to a specific session?

**Why it matters:** Core UX for fire-and-forget. "Click notification -> see what needs attention" must work.

**Needs research:** Test Electron's notification API + protocol handler registration across macOS, Linux, Windows.

### T4: Git worktree cleanup
**Question:** How do we reliably clean up git worktrees for completed/failed sessions? What if the worktree has uncommitted changes?

**Why it matters:** Worktrees accumulate. Each one is a full working copy. Need reliable cleanup that doesn't lose user data.

**Approach:** On session completion, check for uncommitted changes. If clean, delete worktree. If dirty, warn user and keep. Periodic cleanup of worktrees for sessions that completed > N days ago.

### T5: Effect.js removal order
**Question:** What's the right order to remove Effect.js? Contracts first (Schema -> Zod), then shared, then server? Or server first?

**Why it matters:** Effect.js is used everywhere. Changing contracts first means everything downstream breaks until updated. Changing server first means contracts still use @effect/schema.

**RESOLVED:** Shared utilities first (DrainableWorker, KeyedCoalescingWorker, TTLCache), then contracts (Schema -> Zod), then server bottom-up. See [03-effect-removal.md](./03-effect-removal.md).

## Ideas Not Yet Placed

### I1: Agent recording and replay
Record full agent interactions for debugging and training. Replay an agent to see exactly what it did, what tools it called, what it produced. Useful for understanding why a session failed or why a deliberation went a certain way.

### I2: Workflow analytics
Track success rates by workflow type, average iterations in build loops, common quality check failures, deliberation convergence patterns. Use this data to improve workflow templates and prompts over time.

### I3: Community workflow templates
A registry of workflow templates that users can browse and install. "This build-loop template for React apps has a 90% success rate." Stretch goal but valuable if the platform gets traction.

### I4: Integration with issue trackers
Create sessions from GitHub issues, Linear tickets, Jira cards. Sync status back. The session description comes from the issue, the workflow is selected based on labels or issue type.

### I5: Cost optimization
Track which workflow patterns are cost-effective vs. wasteful. Suggest cheaper alternatives when appropriate ("this session could use implement instead of plan-then-implement, saving ~$15").

### I6: Agent memory across sessions
When a session completes, extract learnings (patterns discovered, mistakes made, corrections applied) and make them available to future sessions in the same project. "In this codebase, always run `npm run build` before tests because of the code generation step."

## Carry-Forward Matrix

Existing t3-code product features and their forge disposition.

| Feature | t3-code State | Forge Decision | Rationale |
|---------|--------------|----------------|-----------|
| Git stacked actions (commit→push→PR) | GitManager.ts, 4-phase GitStackedAction | **CARRY** | Core workflow finalization. Maps to orc's CompletionAction. Add as post-phase action in doc 04. Session-scoped. |
| PR preparation (AI-generated title/description) | preparePullRequestThread in GitManager | **CARRY** | Needed for build-loop finalize phase. |
| composerDraftStore (draft/attachments/model/terminal-context) | 2215 lines, schema v3, localStorage persistence | **CARRY draft concept, DEFER attachments to v2** | Session creation and correction use plain text for v1. Image attachments and terminal-context capture are v2. Per-session draft persistence (title, description, model) carries. |
| Terminal groups (split terminals, max 4) | terminalStateStore.ts, ThreadTerminalGroup | **DEFER to v2** | Simple tab model for v1. Groups add complexity without justification until terminal story matures. |
| Project scripts UI (add/edit/delete/keybind) | projectScripts.ts, ProjectScriptsControl.tsx | **CARRY partially** | Bootstrap (runOnWorktreeCreate) and quality checks already in design. Full scripts CRUD is incremental. |
| Proposed plans UI (view/edit/export/implement) | OrchestrationProposedPlan | **CARRY as phase output viewer** | In forge, this IS the phase_outputs viewer for plan/deliberation phases in workflow sessions. View markdown, edit before feeding to next phase, export. Add to doc 05. |
| Message-level undo/revert | thread.checkpoint.revert, integration-tested | **CARRY** | Event type exists (session.checkpoint-reverted). Specify per-agent revert contract in doc 10. |
| Model selection UI (per-provider, sticky) | composerDraftStore, modelSelection | **CARRY** | Users need model override per session/phase. Sticky selection from draft store applies to session creation. |
| Approval policies (4-tier policy, 3-tier sandbox, acceptForSession) | ProviderApprovalPolicy, ProviderSandboxMode | **CARRY infrastructure, DEFER granular UI** | interactive_requests carries typed payloads. Provider mapping preserves the policy layer. Per-project policy config is v2. |
| Diff viewer (checkpoint-based, per-turn) | CheckpointDiffQuery, DiffPanel.tsx | **CARRY** | Maps to per-agent diffs within phases. Existing diff infrastructure reusable. |
| Semantic branch renaming | ProviderCommandReactor, resolveAvailableBranchName | **CARRY** | Auto-rename forge/{session_id} to forge/feat/{semantic-name} on first turn. Branch availability check at rename time. |

## Related Documents

All design documents reference this file for cross-cutting concerns.
