# Sessions-First Redesign

## Why This Change

The previous design had Tasks as the primary entity with Sessions inside them. But "tasks" are unnecessary indirection. What you actually interact with are:

1. **Agent sessions** — a Claude Code or Codex conversation (what t3-code does today, keep the UI)
2. **Workflow sessions** — orchestrated multi-phase work (implement, build-loop, plan-then-implement)
3. **Chat sessions** — standalone deliberations (HerdingLlamas patterns)

There is no "task" layer between the user and the work. You start a session. The session's workflow (or lack of one) determines what it looks like and how it behaves. The sidebar shows sessions, not tasks.

### User-Facing vs Internal

The three session types (agent, workflow, chat) are INTERNAL implementation types. The user never selects a "type." They start a session and optionally pick a workflow. The system determines the type:
- No workflow selected → type: "agent" (direct chat)
- Workflow selected that has phases → type: "workflow"
- Workflow selected that is a deliberation pattern → type: "chat"

From the user's perspective, they're all just "sessions" with different workflows attached. The sidebar shows them all in one list. The workflow determines the behavior, UI, and output format.

## The Model

### Session (The Only Entity)

Everything in forge is a session. A standalone chat with Claude is a session. A workflow is a session whose phases spawn child sessions. A deliberation is a session with two child sessions that communicate through a channel. Each phase's provider interaction in a workflow is a child session you can click into and interact with like any other session.

```typescript
interface Session {
  id: SessionId
  projectId: ProjectId
  parentSessionId: SessionId | null   // NULL for top-level, FK for children
  phaseRunId: PhaseRunId | null       // which phase this child belongs to (workflow children)
  type: "agent" | "workflow" | "chat"
  title: string
  description: string
  status: SessionStatus
  // Role (for child sessions in multi-agent phases or deliberation)
  role: string | null                  // "scrutinizer", "advocate", etc.
  // Provider (for leaf sessions that interact with a provider)
  provider: string | null              // "claude" | "codex" — NULL for container sessions
  model: ModelSelection | null
  // Workspace
  branch: string | null
  worktreePath: string | null
  runtimeMode: "supervised" | "autonomous"
  bootstrapStatus: string | null
  // Workflow (for type: workflow)
  workflowId: string | null
  workflowSnapshot: string | null
  currentPhaseId: string | null
  // Chat (for type: chat)
  patternId: string | null
  // Metadata
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

type SessionStatus =
  | "created"          // defined but not started
  | "running"          // actively working
  | "needs-attention"  // gate, approval, correction needed, error
  | "paused"           // human paused
  | "completed"        // done
  | "failed"           // unrecoverable
  | "cancelled"        // user stopped
```

**Session hierarchy:**
- **Standalone agent session**: top-level, no parent, no children. type="agent", provider set. This IS the t3-code thread.
- **Workflow session**: top-level container. type="workflow", provider NULL. Children are the phase sessions.
  - **Phase child session**: parent is the workflow session. type="agent", provider set, phaseRunId set, role may be set. Full chat UI.
- **Chat session**: top-level container. type="chat", provider NULL. Two children.
  - **Deliberation child session**: parent is the chat session. type="agent", provider set, role set (e.g., "advocate", "interrogator"). Full chat UI.

Every leaf session (provider != NULL) has: messages, activities, checkpoints, terminal, proposed plans — the full t3-code chat experience. Every container session (provider == NULL) has: phase_runs (if workflow), channels, child sessions.

### How Each Session Type Works

#### Agent Sessions (type: "agent", provider set)

This IS t3-code's thread, renamed. The UI is identical to t3-code's chat view. One conversation with one provider. Messages, activities, checkpoints, terminal, proposed plans — all the existing functionality carries forward unchanged.

A standalone agent session is top-level (parentSessionId = NULL). A phase session or deliberation participant is a child session (parentSessionId set).

```
Agent Session (leaf)
  ├── messages[]           (the conversation — user + assistant turns)
  ├── activities[]         (tool calls, approvals, work log)
  ├── checkpoints[]        (per-turn git snapshots)
  ├── terminals[]          (associated terminal sessions)
  └── proposed plans       (provider-suggested plans)
```

An agent session has NO phases, NO workflow, NO channels. It's a direct conversation. The compose input, approval buttons, diff viewer, terminal drawer — all stay exactly as they are in t3-code.

For agent sessions (both standalone and child), the existing t3-code projection tables carry forward with session-scoped naming:
- `projection_session_messages` (was `projection_thread_messages`)
- `projection_session_activities` (was `projection_thread_activities`)
- `projection_session_state` (was `projection_thread_sessions`)
- `projection_turns`
- `projection_pending_approvals` → `interactive_requests` (already unified)

These are event-sourced projections rebuilt from session lifecycle events on leaf sessions. Agent sessions use the SAME projection pipeline as t3-code threads, just renamed.

```sql
-- NOTE: attachments_json columns and attachments? parameters throughout the schema
-- are included for forward compatibility but are NOT implemented in v1. They exist
-- so the schema doesn't need migration when attachments ship in v2. v1 implementations
-- should accept but ignore attachment data.

CREATE TABLE projection_session_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  is_streaming INTEGER NOT NULL DEFAULT 0,
  attachments_json TEXT,              -- v2: not implemented in v1 (see note above)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_proj_messages_session ON projection_session_messages(session_id, created_at);

CREATE TABLE projection_session_activities (
  activity_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  tone TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_proj_activities_session ON projection_session_activities(session_id, created_at);

CREATE TABLE projection_session_state (
  session_id TEXT PRIMARY KEY,
  provider_status TEXT NOT NULL,
  provider_name TEXT,
  active_turn_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE projection_turns (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  pending_message_id TEXT,
  assistant_message_id TEXT,
  state TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  checkpoint_turn_count INTEGER,
  checkpoint_ref TEXT,
  checkpoint_status TEXT,
  checkpoint_files_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(session_id, turn_id),
  UNIQUE(session_id, checkpoint_turn_count)
);
```

**Corrections for agent sessions:** For standalone agent sessions (type='agent', parentSessionId = NULL), corrections are simply the next user message — there is no guidance channel. The user types in the compose input, it becomes a new turn. This matches t3-code's existing behavior exactly. Guidance channels only exist for workflow sessions. For standalone agent sessions, `session.correct` dispatched via the socket API is mapped to `session.send-turn` — it becomes the next user message in the conversation. There is no guidance channel for standalone agent sessions. The correction IS the next turn.

#### Workflow Sessions (type: "workflow", provider NULL)

An orchestrated sequence of phases. The session view shows phase progress at the top, with the current phase's child session output below (similar to the previous task model but the session IS the entity).

```
Workflow Session (container)
  ├── workflow definition    (frozen at creation)
  ├── phase_runs[]           (execution record per phase)
  │     ├── child sessions[] (provider interactions for this phase — each a full session with chat UI)
  │     │     ├── transcript (messages within this child session)
  │     │     └── checkpoints
  │     ├── channel          (for multi-agent phases)
  │     ├── phase_outputs    (synthesis, review findings, etc.)
  │     └── quality_checks
  ├── guidance_channel       (human corrections, spans all phases)
  └── outputs/outcomes       (displayed inline in the session view)
```

The main panel for a workflow session shows:
- Phase progress bar at top (which phase, which iteration)
- Current child session output (streaming, same renderer as agent sessions)
- Gate results, quality check output (inline between phases)
- Correction input (posts to guidance channel)
- Phase outputs (plan, synthesis, findings — rendered as markdown with edit/export)

#### Chat Sessions (type: "chat", provider NULL)

A standalone deliberation. Two child sessions with a shared channel. The UI is the channel view from the previous design.

```
Chat Session (container)
  ├── pattern                (debate, interrogate, explore, code-review, refine-prompt)
  ├── child sessions[2]      (two leaf sessions, one per role)
  ├── deliberation_channel   (shared communication)
  ├── deliberation_state     (turn tracking, liveness, conclusion)
  └── synthesis              (optional, generated after conclusion)
```

The main panel shows the deliberation channel (color-coded messages by role), intervention input, and synthesis output after conclusion.

For chat sessions, deliberation_state_json is stored directly on the sessions table (not in metadata_json). For workflow multi-agent phases, it remains on phase_runs.deliberation_state_json. Both locations use the identical DeliberationState schema.

### What Happened to "Tasks"

They're gone. Here's the mapping:

| Previous concept | Sessions-first equivalent |
|-----------------|--------------------------|
| Task | Session (type depends on what you're doing) |
| Task.workflowId | Session.workflowId (only for workflow sessions) |
| Task.status | Session.status |
| Task.worktreePath | Session.worktreePath |
| Phase runs | Phase runs within workflow sessions |
| Provider sessions within tasks | Child sessions within phases (workflow) or direct provider state (agent) |
| Guidance channel on task | Guidance channel on workflow session |
| Scratch task for chat | Chat session (no scratch indirection needed) |
| Task dependencies | Session dependencies (via session_dependencies table) |
| Task groups | Session groups (optional, lightweight) |

### What Happened to "Initiatives"

Not needed. If you want to group sessions, create a session group. If you want dependencies, add session_dependencies. The lightweight grouping model stays, just renamed.

## Schema

### Index Strategy

All documented query paths should have supporting indexes. The indexes defined in this schema cover the primary query patterns. Before implementation, perform a systematic review: for each documented read path (resolveInputFrom, guidance attribution, transcript retrieval, session.getChildren, etc.), verify that a supporting index exists. Add composite indexes where predicate + ordering columns are not covered by existing indexes.

```sql
-- Event store (the source of truth for all event-sourced state)
-- Schema preserved from t3-code Migration 001, aggregate_kind updated
CREATE TABLE orchestration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_kind TEXT NOT NULL,      -- 'project' | 'session'
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  command_id TEXT,
  causation_event_id TEXT,
  correlation_id TEXT,
  actor_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE INDEX idx_events_stream ON orchestration_events(aggregate_kind, stream_id, stream_version);
CREATE INDEX idx_events_command ON orchestration_events(command_id);

-- Command receipt deduplication
CREATE TABLE orchestration_command_receipts (
  command_id TEXT PRIMARY KEY,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  result_sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);

-- Projector cursor tracking (how far each projector has replayed)
CREATE TABLE projection_state (
  projector TEXT PRIMARY KEY,
  last_applied_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- Projects (mostly unchanged from t3-code)
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  default_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Sessions: the only entity
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  parent_session_id TEXT REFERENCES sessions(session_id),  -- NULL for top-level
  phase_run_id TEXT REFERENCES phase_runs(phase_run_id),   -- which phase (workflow children)
  type TEXT NOT NULL,                -- agent | workflow | chat
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'created',
    -- created | running | needs-attention | paused | completed | failed | cancelled
  role TEXT,                          -- for child sessions: advocate, interrogator, scrutinizer, etc.
  -- Provider (leaf sessions only)
  provider TEXT,                      -- claude | codex — NULL for container sessions
  model_json TEXT,                   -- ModelSelection
  runtime_mode TEXT NOT NULL DEFAULT 'autonomous',
  bootstrap_status TEXT,             -- NULL | queued | running | completed | failed | skipped
  -- Workspace
  branch TEXT,
  worktree_path TEXT,
  -- Workflow-specific (container)
  workflow_id TEXT,
  workflow_snapshot_json TEXT,
  current_phase_id TEXT,
  -- Chat-specific (container)
  pattern_id TEXT,
  deliberation_state_json TEXT,      -- for chat sessions: liveness, turns, conclusions
  -- Provider state (leaf sessions)
  token_usage_json TEXT NOT NULL DEFAULT '{"input":0,"output":0}',
  resume_cursor_json TEXT,
  runtime_payload_json TEXT,
  -- Metadata
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  completed_at TEXT,
  transcript_archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX idx_sessions_phase_run ON sessions(phase_run_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_type ON sessions(type);

-- Branch claim enforcement: only one active session per branch
CREATE UNIQUE INDEX idx_sessions_branch_claim
  ON sessions(branch)
  WHERE branch IS NOT NULL
    AND status NOT IN ('completed', 'cancelled', 'failed')
    AND archived_at IS NULL;
```

Bootstrap status is set by the session projector from bootstrap events. `skipped` is set when the user resolves a `bootstrap-failed` request with `action='skip'`. No direct writes — fully event-driven.

`model_json` stores a JSON-serialized `ModelSelection`. `provider: auto` in workflow YAML resolves to: `session.model_json` (if set) -> `project.default_model` -> error. Provider is always explicit in the ModelSelection, never inferred from model name.

```sql
-- Workflows: reusable templates (could also be YAML files, but DB for user-created)
CREATE TABLE workflows (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  phases_json TEXT NOT NULL,       -- JSON array of WorkflowPhase definitions
  built_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_workflows_name_builtin ON workflows(name, built_in);
```

**Workflow invariants:**
- Phase names MUST be unique within a workflow. Validated at creation/load time.
- Workflows are IMMUTABLE once a session starts. Modifying a workflow definition does not affect running sessions.
- On session creation, `workflow_snapshot_json` is written to the session record capturing the workflow's `phases_json` at that point in time. This makes the binding durable across workflow updates.

### Workflow Repository Contract

V1 uses DB-only after materialization:
1. Built-in workflows ship as YAML files bundled with the app
2. On startup, engine reads all YAML files and UPSERTS into `workflows` table with `built_in = 1`
3. User-created workflows are inserted directly with `built_in = 0`
4. The `workflows` table is the sole runtime source — no dual-source resolution
5. If a user workflow has the same name as a built-in, the user workflow wins (queries filter by `built_in = 0` first)
6. On session creation, the workflow's current phases_json is snapshot into `sessions.workflow_snapshot_json`

```sql
-- Phase runs (workflow sessions only)
CREATE TABLE phase_runs (
  phase_run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  workflow_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  phase_name TEXT NOT NULL,
  phase_type TEXT NOT NULL,          -- single-agent | multi-agent | automated | human
  sandbox_mode TEXT,                 -- read-only | workspace-write | danger-full-access
  iteration INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
    -- pending | running | completed | failed | skipped
  gate_result_json TEXT,
  quality_checks_json TEXT,
  deliberation_state_json TEXT,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_phase_runs_session ON phase_runs(session_id);
CREATE INDEX idx_phase_runs_resolve ON phase_runs(session_id, phase_name, status);

-- Channels
CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  phase_run_id TEXT REFERENCES phase_runs(phase_run_id),
  type TEXT NOT NULL,                -- guidance | deliberation | review | system
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_channels_session ON channels(session_id);

-- Channel messages (unchanged from previous)
CREATE TABLE channel_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id),
  sequence INTEGER NOT NULL,
  from_type TEXT NOT NULL,           -- human | agent | system
  from_id TEXT NOT NULL,
  from_role TEXT,
  content TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(channel_id, sequence)
);
CREATE INDEX idx_channel_messages_channel ON channel_messages(channel_id, sequence);
CREATE INDEX idx_channel_messages_time ON channel_messages(channel_id, created_at);

-- Channel read cursors
CREATE TABLE channel_reads (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),  -- the participating child session
  last_read_sequence INTEGER NOT NULL DEFAULT -1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(channel_id, session_id)
);

-- Phase outputs (workflow sessions)
CREATE TABLE phase_outputs (
  phase_run_id TEXT NOT NULL REFERENCES phase_runs(phase_run_id),
  output_key TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  metadata_json TEXT,                -- stores original_content before user edits
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(phase_run_id, output_key)
);

-- Chat session synthesis (generated after deliberation concludes)
CREATE TABLE session_synthesis (
  session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
  content TEXT NOT NULL,
  generated_by_session_id TEXT REFERENCES sessions(session_id),  -- the child session that generated the synthesis
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tool call idempotency
CREATE TABLE tool_call_results (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,           -- the leaf session
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(provider, session_id, call_id)
);

-- Interactive requests (session-scoped)
CREATE TABLE interactive_requests (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),  -- top-level or leaf session
  child_session_id TEXT REFERENCES sessions(session_id),     -- the leaf session (if applicable)
  phase_run_id TEXT REFERENCES phase_runs(phase_run_id),
  type TEXT NOT NULL,
    -- approval | user-input | gate | correction-needed | bootstrap-failed
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL,
  resolved_with_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  stale_reason TEXT
);
CREATE INDEX idx_requests_session ON interactive_requests(session_id);
CREATE INDEX idx_requests_status ON interactive_requests(status);

-- Transcript entries
CREATE TABLE transcript_entries (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),  -- the leaf session
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  is_streaming INTEGER NOT NULL DEFAULT 0,
  tool_calls_json TEXT,
  tool_result_json TEXT,
  attachments_json TEXT,              -- v2: not implemented in v1 (see attachments note above)
  token_count INTEGER,
  turn_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);
CREATE INDEX idx_transcript_session_seq ON transcript_entries(session_id, sequence);

-- Checkpoint refs
CREATE TABLE checkpoint_refs (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),  -- the leaf session
  turn_count INTEGER NOT NULL,
  ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'captured',
  baseline_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, turn_count)
);

-- Checkpoint diffs
CREATE TABLE checkpoint_diff_blobs (
  session_id TEXT NOT NULL,           -- the leaf session
  from_turn_count INTEGER NOT NULL,
  to_turn_count INTEGER NOT NULL,
  diff TEXT NOT NULL,
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, from_turn_count, to_turn_count)
);

-- Session dependencies
CREATE TABLE session_dependencies (
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  depends_on_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, depends_on_session_id),
  CHECK(session_id != depends_on_session_id)
);
CREATE INDEX idx_session_deps_blocked ON session_dependencies(depends_on_session_id);

-- Session groups (lightweight)
CREATE TABLE session_groups (
  group_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE session_group_members (
  group_id TEXT NOT NULL REFERENCES session_groups(group_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(group_id, session_id)
);

-- Session links
-- For session-to-session edges (promoted-from, promoted-to, related): linked_session_id is populated.
-- For external links (pr, issue, ci-run): external_* fields are populated instead.
CREATE TABLE session_links (
  link_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  linked_session_id TEXT REFERENCES sessions(session_id),
  link_type TEXT NOT NULL,           -- pr | issue | ci-run | promoted-from | promoted-to | related
  external_id TEXT,
  external_url TEXT,
  external_status TEXT,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_session_links_session ON session_links(session_id);
CREATE INDEX idx_session_links_linked ON session_links(linked_session_id);

-- Partial unique indexes for SQLite NULL handling
CREATE UNIQUE INDEX idx_session_links_unique_internal
  ON session_links(session_id, link_type, linked_session_id)
  WHERE linked_session_id IS NOT NULL;
CREATE UNIQUE INDEX idx_session_links_unique_external
  ON session_links(session_id, link_type, external_id)
  WHERE external_id IS NOT NULL;
-- At least one target must be specified
-- CHECK(linked_session_id IS NOT NULL OR external_id IS NOT NULL)

-- Phase run provenance (analytics)
CREATE TABLE phase_run_provenance (
  phase_run_id TEXT PRIMARY KEY REFERENCES phase_runs(phase_run_id),
  prompt_template_id TEXT,
  prompt_template_source TEXT,
  prompt_template_hash TEXT,
  prompt_context_hash TEXT,
  model_used TEXT,
  knowledge_snapshot_ids TEXT,
  created_at TEXT NOT NULL
);

-- Phase run outcomes (analytics)
CREATE TABLE phase_run_outcomes (
  phase_run_id TEXT PRIMARY KEY REFERENCES phase_runs(phase_run_id),
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Project knowledge
CREATE TABLE project_knowledge (
  knowledge_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  kind TEXT NOT NULL,                -- pattern | correction | environment | convention
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_session_id TEXT REFERENCES sessions(session_id),
  confidence TEXT NOT NULL DEFAULT 'suggested',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_knowledge_project ON project_knowledge(project_id);

-- Attention signals
CREATE TABLE attention_signals (
  signal_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  session_id TEXT REFERENCES sessions(session_id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  summary TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  snoozed_until TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_signals_status ON attention_signals(status);
CREATE INDEX idx_signals_project ON attention_signals(project_id);
```

### Ownership Hierarchy

```
Project
  └── Session (top-level, owns worktree_path, branch)
        └── PhaseRun (owns phase execution state, deliberation state)
              └── Child Session (leaf, operates within parent's worktree, owns transcript + checkpoints)
```

- **Top-level session** owns workspace isolation: `worktree_path` and `branch` live on the top-level session. All child sessions within a workflow share the same worktree.
- **PhaseRun** owns coordination: phase status, gate results, deliberation state.
- **Child session (leaf)** owns execution: provider interaction, transcript, token usage, resume state. Checkpoints are namespaced: `refs/forge/checkpoints/{session_id}/turn/{n}` where session_id is the leaf session.

For multi-agent phases: two child sessions in the same phase run share the parent session's worktree. They communicate via channels, not file edits (deliberation phases discuss, they don't both write code simultaneously).

## State Ownership Matrix

Not all tables are event-sourced projections. Forge uses a hybrid model where some tables are rebuilt from events and others are directly managed.

| Table | Ownership | Rebuilt from events? | Direct writes? | Notes |
|-------|-----------|---------------------|----------------|-------|
| `orchestration_events` | Event store | N/A (IS the source) | Append-only | Source of truth for all event-sourced state |
| `projects` | Event-sourced projection | Yes | No | Rebuilt from project.* events |
| `sessions` | Hybrid | Yes (status, phase progression from events) | Yes (resume_cursor_json, runtime_payload_json, transcript_archived by adapters/jobs) | Projector handles lifecycle events. Provider adapters direct-write resume state. Archival job direct-writes transcript_archived. completed_at set by projector from session.completed events. |
| `phase_runs` | Hybrid | Yes | Yes (deliberation_state_json only) | Projector builds from session.phase-* events. deliberation_state_json is direct-written by the deliberation engine and by recovery. On event replay, it is reconstructed from channel/session events. |
| `channels` | Event-sourced projection | Yes | No | Rebuilt from channel.* events |
| `channel_messages` | Event-sourced projection | Yes | No | Rebuilt from channel.message-posted events |
| `channel_reads` | Hybrid | Partially | Yes | Projector updates on message-posted/conclusion-proposed; engine writes directly for Codex injection. Keyed by (channel_id, session_id) where session_id is the participating child session. |
| `interactive_requests` | Hybrid | Yes for creation | Yes | Recovery marks stale directly; resolution may be event-driven or direct |
| `tool_call_results` | Direct (cache) | No | Yes | Idempotency cache, not derived from events |
| `transcript_entries` | Direct (append-only log) | No | Yes | Written by provider adapters during leaf session execution |
| `checkpoint_refs` | Hybrid | Partially (from checkpoint events) | Yes | placeholder -> captured status update by CheckpointReactor |
| `checkpoint_diff_blobs` | Direct (cache) | No | Yes | Computed by CheckpointReactor, not derived from events |
| `phase_outputs` | Event-sourced projection | Yes | No | Materialized by projector from session.phase-completed event payload |
| `workflows` | Direct (config) | No | Yes | Materialized from YAML on startup, user-created via UI |
| `session_dependencies` | Event-sourced projection | Yes | No | Rebuilt from session.dependency-* events |
| `session_groups` | Direct | No | Yes | Lightweight grouping, not event-sourced |
| `session_group_members` | Direct | No | Yes | Lightweight grouping, not event-sourced |
| `session_links` | Event-sourced | Yes | No | Links are domain state. Written via session.link-added/removed events. |
| `phase_run_provenance` | Direct (analytics) | No | Yes | Written at phase start |
| `phase_run_outcomes` | Direct (analytics) | No | Yes | Written at phase completion |
| `project_knowledge` | Direct | No | Yes | Knowledge base, not event-sourced |
| `session_synthesis` | Event-sourced projection | Yes | No | Materialized by projector from session.synthesis-completed event payload |
| `attention_signals` | Direct | No | Yes | Attention system |
| `projection_session_messages` | Event-sourced projection | Yes | No | Leaf session messages, rebuilt from session.message-sent events |
| `projection_session_activities` | Event-sourced projection | Yes | No | Leaf session activities, rebuilt from session lifecycle events |
| `projection_session_state` | Event-sourced projection | Yes | No | Leaf session provider state |
| `projection_turns` | Event-sourced projection | Yes | No | Agent session turn tracking |

**Implementation rule:** Event-sourced tables MUST only be written by the projector (except for hybrid tables' documented direct-write paths). Direct tables are written by the component that owns them. On startup, event-sourced tables are rebuilt from the event store; direct tables persist across restarts.

**Migration rule:** Event-sourced projection tables can be dropped and rebuilt from events. Direct tables cannot — they need traditional schema migrations.

## Execution Model

Commands are state transitions only. The decider emits events; the engine persists and projects them. This takes milliseconds. The global command queue is NEVER blocked by long-running work.

All long-running work is launched by background reactors that subscribe to domain events:

| Trigger event | Reactor | Action | Completion event |
|--------------|---------|--------|-----------------|
| session.created (with workflow/bootstrap) | BootstrapReactor | Runs worktree bootstrap script | session.bootstrap-completed / session.bootstrap-failed |
| session.turn-requested | ProviderCommandReactor | Starts the child session's provider turn via SDK/subprocess | session.turn-completed (via ProviderRuntimeIngestion) |
| session.quality-check-started | QualityCheckReactor | Runs quality check commands | session.quality-check-completed |
| session.phase-started (automated) | AutomatedPhaseReactor | Runs scripts | session.phase-completed |
| channel.concluded | SynthesisReactor | Runs synthesis for chat sessions | session.synthesis-completed |

The workflow engine (doc 04) describes LOGICAL flow. Each step is an event->react->event cycle, not a synchronous procedure. "Spawn one child session, wait for completion" means: emit session.turn-requested, then the ProviderCommandReactor starts the child session's provider turn asynchronously, and session.turn-completed arrives later as a new event.

### Reactor Completion Pattern

When a reactor completes long-running work, it dispatches a completion command back to the engine. This command carries the output data in its payload. The decider validates and emits a completion event. The projector materializes the output.

This means: **phase_outputs, session_synthesis, and quality check results are EVENT-DERIVED, not direct-written.** The output content travels through the event system:

1. Reactor finishes work (e.g., synthesis completes)
2. Reactor dispatches: `session.complete-phase { sessionId, phaseRunId, outputs: [{ key: 'synthesis', content: '...' }] }`
3. Engine appends `session.phase-completed` event with output payload
4. Projector materializes `phase_outputs` row from the event payload

This eliminates the hybrid-write atomicity problem. No transaction coordination between reactors and the engine. The event IS the source of truth for output content.

### Reactor Idempotency

Every reactor-emitted completion command uses a DETERMINISTIC commandId derived from a stable work item identity:

| Reactor | commandId derivation | Prevents |
|---------|---------------------|----------|
| BootstrapReactor | `bootstrap:{sessionId}:{attempt}` | Duplicate bootstrap completion after restart |
| ProviderCommandReactor | `turn:{sessionId}:{turnCorrelationId}` | Duplicate turn completion (sessionId is the leaf session) |
| QualityCheckReactor | `qc:{phaseRunId}:{checkKey}` | Duplicate quality check results |
| AutomatedPhaseReactor | `auto-phase:{phaseRunId}` | Duplicate automated phase completion |
| SynthesisReactor | `synthesis:{sessionId}` | Duplicate synthesis |
| Codex conclusion parser | `conclusion:{sessionId}:{turnCorrelationId}` | Duplicate conclusion from Codex response replay (sessionId is the leaf session) |

The engine's existing command receipt system checks these deterministic IDs. If a receipt already exists for a commandId, the command is a no-op. This makes all reactor completions retry-safe across daemon restarts.

## Consistency Model

### Transaction Boundaries

Direct-write + event-append pairs MUST use a single SQLite transaction to prevent crash-window inconsistencies:

1. **phase_outputs are event-derived.** Output content travels in the session.phase-completed event payload. The projector materializes the phase_outputs row. No direct write, no transaction coordination needed.

2. **interactive_request resolution**: The request.resolved event append AND the interactive_requests row update happen in the same transaction.

3. **transcript_entries**: These are append-only and deliberately NOT transactional with events. If the daemon crashes after appending transcript entries but before the corresponding session.message-sent event, the transcript has extra entries. This is acceptable — transcript entries are the raw log, and extra entries are harmless. On session resume, the provider picks up from its last known state, which may re-emit some work.

### Startup Ordering (detailed)

1. Open database, run migrations
2. Rebuild event-sourced projection tables from orchestration_events (using projection_state cursors)
3. Run hybrid table reconcilers:
   - interactive_requests: mark pending provider-dependent requests as stale (provider callbacks are gone)
   - channel_reads: no reconciliation needed (Codex cursor being behind causes harmless duplicate injection)
   - phase_runs.deliberation_state_json: check child session liveness, prepare recovery
4. Resume: session recovery dispatches through normal command path (FIFO)

### Crash-Window Behavior Per Hybrid Table

| Table | Crash window | Behavior | Severity |
|-------|-------------|----------|----------|
| phase_outputs | Event-derived (projector writes from event payload) | Standard event-sourced | Safe |
| interactive_requests | Resolution direct-write | Transaction with event | Safe |
| transcript_entries | Ahead of event stream | Extra entries are harmless | Acceptable degradation |
| channel_reads | Codex cursor ahead of events | Duplicate injection on recovery | Acceptable degradation |
| phase_runs.deliberation_state_json | Direct-write by engine | Reconstructed from channel/session events | Acceptable degradation |
| sessions (resume_cursor_json, runtime_payload_json) | Direct-write by provider adapter on leaf sessions | Resume cursor is used for recovery — correct behavior. Stale payload is harmless. | Safe |
| sessions (transcript_archived) | Set by archival job on leaf sessions | Archival job MUST set transcript_archived=1 BEFORE deleting transcript rows (same transaction). If flag set but rows not deleted: brief duplicate storage, acceptable. If rows deleted but flag not set: data appears missing — prevented by transaction ordering. | Safe with tx ordering |
| checkpoint_refs | Placeholder→captured status update | Re-capture on recovery produces duplicate. Use INSERT OR REPLACE for idempotent checkpoint writes. | Safe with INSERT OR REPLACE |

Note: sessions.completed_at is set by the projector from session.completed events. It is NOT a direct write — it was incorrectly classified. The projector reads the event timestamp and sets completed_at.

## Phase Output Writer Contract

The phase runner (a reactor) dispatches a completion command carrying output content in the payload. The decider validates and emits the completion event. The projector extracts output content from the event and writes to phase_outputs. This is standard event-sourced projection — phase_outputs is rebuilt from events on replay.

| Phase Type | output_key | Content | Source |
|-----------|-----------|---------|--------|
| `single-agent` | `output` | Final assistant message from the child session | Last assistant transcript_entry |
| `single-agent` | `corrections` | JSON array of guidance channel messages received during this phase run | channel_messages where channel.type = 'guidance' |
| `multi-agent` | `channel` | Formatted channel transcript (all messages) | channel_messages for the phase's deliberation channel |
| `multi-agent` | `synthesis` | Synthesis session's final output (if synthesis sub-phase exists) | Last assistant transcript_entry from synthesis child session |
| `multi-agent` (no channel) | `output:{role}` | Final assistant message from each child session | Last assistant transcript_entry per child session, keyed by role |
| `automated` | `output` | Quality check results as JSON | Collected from check execution |
| `human` | `output` | Human's approval message or correction text | From resolved interactive_request |

`buildIterationContext()` reads from `phase_outputs` (keyed by phase_run_id + output_key) and guidance channel messages, NOT from non-existent `run.summary` or `run.corrections` fields.

### Output Modes

| Mode | When used | What's stored in phase_outputs | What renders in timeline |
|------|-----------|-------------------------------|------------------------|
| Schema | Agent definition has output schema | Full JSON in content, output_key='output' | summary field rendered as markdown |
| Channel | Deliberation phase with channel | Formatted channel transcript, output_key='channel' | Channel messages rendered as chat |
| Conversation | Default, no schema or channel | Agent's final message, output_key='output' | Message rendered as markdown |

Quality check results between phases are stored separately in phase_runs.quality_checks_json and rendered inline in the workflow timeline.

### Phase Output Editing

Phase output editing dispatches a `session.phase-output-edited` command/event. The projector updates the phase_outputs row. The original content is preserved in the event history (the edit event carries both old and new content).

### Guidance Channel Phase Attribution

The guidance channel is session-scoped (one per workflow session, spanning all phases). But phase outputs need corrections scoped to specific phase_runs. Attribution rule:

A guidance channel message belongs to the phase_run that was ACTIVE when the message was posted. The `channel_messages` table does not have a `phase_run_id` column (guidance messages are session-scoped). Instead, the phase runner determines attribution at phase completion by filtering guidance messages by timestamp:

```sql
-- Corrections for this phase_run = guidance messages posted during this phase_run's execution
SELECT * FROM channel_messages cm
JOIN channels c ON cm.channel_id = c.channel_id
WHERE c.session_id = ? AND c.type = 'guidance'
  AND cm.created_at >= ? -- phase_run.started_at
  AND cm.created_at <= ? -- phase_run.completed_at (or now() if still running)
ORDER BY cm.sequence
```

This avoids adding phase_run_id to the channel_messages table while still allowing per-phase correction attribution for the `corrections` output_key.

## Phase Output Resolution (`inputFrom`)

Workflow phases declare `inputFrom` references that bind to the `phase_outputs` table. At phase start, the engine resolves each reference to concrete content.

```typescript
interface InputFromReference {
  phaseName: string;
  target: string;   // 'channel' | 'synthesis' | 'output' | 'output:{role}'
}

async function resolveInputFrom(ref: InputFromReference, sessionId: SessionId): Promise<string> {
  const output = await db.query(
    `SELECT po.content FROM phase_outputs po
     JOIN phase_runs pr ON po.phase_run_id = pr.phase_run_id
     WHERE pr.session_id = ? AND pr.phase_name = ? AND po.output_key = ?
     AND pr.status = 'completed'
     ORDER BY pr.iteration DESC LIMIT 1`,
    sessionId, ref.phaseName, ref.target
  );
  if (!output) throw new Error(`No output '${ref.target}' from phase '${ref.phaseName}'`);
  return output.content;
}
```

Resolution always picks the most recent completed iteration of the named phase. This handles retries naturally: if a phase is re-run, the latest output wins. The `source_type` on the output record is informational (for debugging and UI display), not used in resolution logic.

`inputFrom` references can include role-specific keys using colon syntax: `independent-review.output:scrutinizer`. The resolver splits on the first colon to extract the `output_key`.

**Promotion (`inputFrom: promoted-from.channel`):** When a chat session is promoted to a workflow session, the workflow's first phase can reference `inputFrom: promoted-from.channel`. The engine follows `session_links` (link_type = 'promoted-from') to find the source chat session, then reads that session's deliberation channel content as the input. This bridges the chat-to-workflow transition without copying data.

## Channel Routing

User-facing APIs use two distinct operations for posting to channels:

- `session.correct { sessionId, content }` — Convenience command. Engine resolves to the workflow session's guidance channel and dispatches `channel.post-message`. Used for human corrections.
- `channel.post-message { channelId, fromType, fromId, content }` — Direct channel post. Used when the human intervenes in a specific deliberation channel. The frontend knows the channelId from the deliberation view state.

CLI mapping:
- `forge correct <session-id> 'message'` -> session.correct
- `forge intervene <channel-id> 'message'` -> channel.post-message

## Socket API → Command Mapping

The socket API is the public contract for CLI and app clients. Each socket method maps to one or more decider commands with parameter enrichment:

| Socket Method | Enrichment | Decider Command |
|--------------|------------|-----------------|
| `session.create({ title, type, workflow?, projectPath })` | Generate sessionId, resolve projectId from path, resolve default model | `session.create { sessionId, projectId, sessionType, title, description, workflowId?, model? }` |
| `session.correct({ sessionId, content })` | Resolve guidance channelId for this session | `session.correct { sessionId, content }` → engine resolves to `channel.post-message { channelId, ... }` |
| `session.pause({ sessionId })` | None | `session.pause { sessionId }` |
| `session.resume({ sessionId })` | None | `session.resume { sessionId }` |
| `session.cancel({ sessionId })` | None | `session.cancel { sessionId }` |
| `gate.approve({ sessionId, phaseRunId })` | Resolve requestId | `request.resolve { requestId, resolvedWith: { decision: 'approve' } }` |
| `gate.reject({ sessionId, phaseRunId, reason })` | Resolve requestId | `request.resolve { requestId, resolvedWith: { decision: 'reject', reason } }` |
| `request.resolve({ requestId, resolvedWith })` | None | `request.resolve { requestId, resolvedWith }` |
| `session.getTranscript({ sessionId, limit?, offset? })` | None | Direct DB query (not a command) — works for any leaf session |
| `session.getChildren({ sessionId })` | None | Direct DB query (not a command) — returns child sessions |
| `channel.getMessages({ channelId, limit?, offset? })` | None | Direct DB query (not a command) |
| `channel.intervene({ channelId, content })` | None | `channel.post-message { channelId, fromType: 'human', content }` |
| `session.sendTurn({ sessionId, content, attachments? })` | None — sessionId IS the leaf session | `session.send-turn { sessionId, content, attachments? }` |
| `phaseOutput.update({ phaseRunId, outputKey, content })` | None | `session.edit-phase-output { sessionId, phaseRunId, outputKey, content }` |

CLI commands map to socket methods:
- `forge create ...` → `session.create`
- `forge correct <id> 'msg'` → `session.correct`
- `forge answer <request-id> --input '...'` → `request.resolve`
- `forge bootstrap-retry <id>` → find pending bootstrap-failed request → `request.resolve { requestId, resolvedWith: { action: 'retry' } }`
- `forge bootstrap-skip <id>` → find pending bootstrap-failed request → `request.resolve { requestId, resolvedWith: { action: 'skip' } }`

## Sidebar: Session Tree

Sessions form a tree. Top-level sessions appear in the sidebar. Expanding a container session reveals its children.

```
▼ Auth refactor (workflow, phase 2/4)
  ✓ implement (claude, completed)       ← click: full chat view
  ◌ review                               ← click: channel view
    ├ Scrutinizer (claude, posting)      ← click: full chat view
    └ Defender (codex, reading)          ← click: full chat view
  ○ fix (pending)
  ○ finalize (pending)

▼ Review PR #42 (chat, turn 8/20)       ← click: channel view
  ◌ Advocate (claude, active)            ← click: full chat view
  ◌ Interrogator (codex, active)         ← click: full chat view

● Fix login (claude, running)            ← click: full chat view
```

Every leaf session (with a provider) renders using the SAME chat view component — messages, tool calls, approvals, diffs, terminal. Container sessions render their orchestration view (workflow progress or deliberation channel). The chat view is the atomic building block; everything else composes on top of it.

No separate "Tasks" and "Chats" sections. They're all sessions, differentiated by their type badge and behavior. Workflow sessions show phase progress. Agent sessions show conversation status. Chat sessions show deliberation status.

## What Changes from Previous Design

| Aspect | Previous (task-centric) | New (sessions-first) |
|--------|------------------------|---------------------|
| Primary entity | Task (contains sessions) | Session (IS the entity) |
| Sidebar shows | Tasks and Chats separately | Sessions (all types together) |
| Agent conversations | Task -> single session | Agent session (direct, like t3-code thread) |
| Workflows | Task with workflow -> phase runs -> sessions | Workflow session -> phase runs -> child sessions |
| Deliberations | Chat = scratch task + __scratch__ workflow | Chat session (no indirection) |
| t3-code UI | Adapted to task model | Kept largely intact for agent sessions |
| Promotion (chat -> implement) | Create new task, archive scratch | Create new workflow session, link to chat session |
| Dependencies | task_dependencies | session_dependencies |
| Event aggregate | "task" | "session" |

## What Stays the Same

- Workflow engine (phases, gates, quality checks, loops) — attaches to workflow sessions
- Channel system (guidance, deliberation, review, system) — unchanged
- Deliberation patterns (interrogate, code-review, explore, etc.) — unchanged
- MCP channel tools (Claude) / turn injection (Codex) — unchanged
- Event sourcing pattern — aggregate changes from "task" to "session"
- All provider integration — unchanged
- Checkpoint/revert system — unchanged

## Greenfield Implementation Required

These features are DESIGNED in the docs but require NEW implementation — they do not exist in the current t3-code codebase:

- **Daemon mode** (doc 07): Process singleton, flock + PID + socket discovery, background execution
- **Socket API** (doc 07): Unix domain socket transport, JSON-RPC protocol, CLI client
- **Desktop lifecycle change**: App close → daemon continues (currently: app close → backend killed)
- **OS notifications**: terminal-notifier (macOS), notify-send (Linux) — no notification code exists today
- **Protocol handler**: forge:// deep links, Electron setAsDefaultProtocolClient
- **Product identity**: ~/.forge, com.forgetools.forge, FORGE_* env vars (currently: ~/.t3, com.t3tools.t3code, T3CODE_*)
- **Worktree bootstrap** (server-side): Currently runs client-side in ChatView.tsx

## Event Types

```typescript
type ForgeEventType =
  // Project
  | "project.created"
  | "project.meta-updated"
  | "project.deleted"
  // Session lifecycle (applies to both top-level and child sessions)
  | "session.created"
  | "session.meta-updated"
  | "session.status-changed"
  | "session.completed"
  | "session.failed"
  | "session.cancelled"
  | "session.archived"
  | "session.unarchived"
  | "session.restarted"
  | "session.dependencies-satisfied"
  | "session.dependency-added"
  | "session.dependency-removed"
  | "session.link-added"
  | "session.link-removed"
  | "session.synthesis-completed"
  // Bootstrap lifecycle
  | "session.bootstrap-queued"
  | "session.bootstrap-started"
  | "session.bootstrap-completed"
  | "session.bootstrap-failed"
  | "session.bootstrap-skipped"
  // Phase execution (workflow sessions only)
  | "session.phase-started"
  | "session.phase-completed"
  | "session.phase-failed"
  | "session.phase-skipped"
  | "session.phase-output-edited"
  // Provider turn lifecycle (leaf sessions — both standalone and child)
  | "session.turn-requested"
  | "session.turn-started"
  | "session.turn-completed"
  | "session.turn-restarted"
  | "session.message-sent"
  // Channels
  | "channel.created"
  | "channel.message-posted"
  | "channel.messages-read"
  | "channel.conclusion-proposed"
  | "channel.concluded"
  | "channel.closed"
  // Interactive requests
  | "request.opened"
  | "request.resolved"
  | "request.stale"
  // Quality checks
  | "session.quality-check-started"
  | "session.quality-check-completed"
  // Corrections
  | "session.correction-queued"      // human posted correction, waiting for next turn
  | "session.correction-delivered"   // correction injected into provider context on turn start
  // Checkpoints
  | "session.checkpoint-captured"
  | "session.checkpoint-diff-completed"
  | "session.checkpoint-reverted"
```

Bootstrap events drive the sessions projector to update bootstrap_status. session.bootstrap-skipped is emitted when a bootstrap-failed interactive request is resolved with action='skip'. The BootstrapReactor watches request.resolved events for bootstrap-failed requests and dispatches the appropriate bootstrap completion event.

When a human posts a correction via session.correct, the engine emits session.correction-queued. When the session's next turn starts and the correction is injected into context, the engine emits session.correction-delivered. The frontend uses these to show 'Correction queued — will be delivered on next turn' → 'Correction delivered' transitions.

## Session Aggregate Command Surface

The decider requires an exhaustive typed command union. This is the input to the decider function.

```typescript
type SessionCommands =
  | { type: 'session.create'; sessionId: SessionId; projectId: ProjectId; parentSessionId?: SessionId; phaseRunId?: PhaseRunId; sessionType: 'agent' | 'workflow' | 'chat'; title: string; description: string; workflowId?: WorkflowId; patternId?: string; runtimeMode: RuntimeMode; model?: ModelSelection; provider?: ProviderKind; role?: string; branchOverride?: string; requiresWorktree?: boolean }
  | { type: 'session.correct'; sessionId: SessionId; content: string }  // convenience: resolves guidance channel, dispatches channel.post-message
  | { type: 'session.pause'; sessionId: SessionId }
  | { type: 'session.resume'; sessionId: SessionId }           // user resumes a paused session
  | { type: 'session.recover'; sessionId: SessionId }          // engine auto-resumes after crash (different preconditions)
  | { type: 'session.cancel'; sessionId: SessionId; reason?: string }
  | { type: 'session.archive'; sessionId: SessionId }
  | { type: 'session.unarchive'; sessionId: SessionId }
  | { type: 'session.restart'; sessionId: SessionId; fromPhaseId?: PhaseId }
  | { type: 'session.meta-update'; sessionId: SessionId; updates: Partial<{ title: string; description: string; branch: string; worktreePath: string }> }
  | { type: 'session.start-phase'; sessionId: SessionId; phaseId: PhaseId; iteration: number }
  | { type: 'session.complete-phase'; sessionId: SessionId; phaseRunId: PhaseRunId; gateResult?: GateResult }
  | { type: 'session.fail-phase'; sessionId: SessionId; phaseRunId: PhaseRunId; error: string }
  | { type: 'session.restart-turn'; sessionId: SessionId }     // sessionId is the leaf session
  | { type: 'session.send-message'; sessionId: SessionId; messageId: MessageId; role: string; content: string }  // sessionId is the leaf session
  | { type: 'session.checkpoint-revert'; sessionId: SessionId; turnCount: number }  // sessionId is the leaf session
  | { type: 'session.quality-check-start'; sessionId: SessionId; phaseRunId: PhaseRunId; checks: QualityCheckReference[] }
  | { type: 'session.quality-check-complete'; sessionId: SessionId; phaseRunId: PhaseRunId; results: QualityCheckResult[] }
  | { type: 'session.add-dependency'; sessionId: SessionId; dependsOnSessionId: SessionId }
  | { type: 'session.remove-dependency'; sessionId: SessionId; dependsOnSessionId: SessionId }
  | { type: 'session.add-link'; sessionId: SessionId; linkType: LinkType; linkedSessionId?: SessionId; externalId?: string; externalUrl?: string }
  | { type: 'session.remove-link'; sessionId: SessionId; linkId: LinkId }
  | { type: 'session.promote'; sourceSessionId: SessionId; targetWorkflowId: WorkflowId; title?: string; description?: string }
  | { type: 'session.send-turn'; sessionId: SessionId; content: string; attachments?: unknown[] }  // sessionId is the leaf session
  // NOTE: attachments? is accepted but ignored in v1 (forward compatibility — see attachments note in schema section)
  | { type: 'session.edit-phase-output'; sessionId: SessionId; phaseRunId: PhaseRunId; outputKey: string; content: string }

`session.promote` is a composite command. The decider emits multiple events atomically: `session.created` (new workflow session), `session.link-added` (promoted-from on new, promoted-to on source), `session.archived` (source chat session). All events are in the same command transaction.

For retry safety, the socket layer derives targetSessionId deterministically from clientRequestId: `targetSessionId = UUIDv5(clientRequestId, FORGE_NAMESPACE)`. On retry with the same clientRequestId, the same targetSessionId produces the same commandId, so the receipt returns early. The socket layer knows the target ID without reading the receipt payload.

### Branch Reservation on Create

The decider validates branch availability at command time (serialized in the command queue, no race). session.created event includes the branch claim. The projector writes branch to the sessions table immediately. The branch claim exists from session creation, NOT after bootstrap.

BootstrapReactor later creates the worktree for the already-claimed branch and sets worktree_path via session.meta-update. If bootstrap fails, the branch claim persists — the session enters needs-attention, human can retry/skip/cancel. Cancellation releases the claim (sets branch to NULL or status to cancelled).

Branch availability check runs in the decider against the ForgeReadModel: is this branch claimed by another active session (status NOT IN completed, cancelled, failed AND archived_at IS NULL)? If yes, reject with error.

type ChannelCommands =
  | { type: "channel.create"; channelId: ChannelId; sessionId: SessionId; channelType: ChannelType; phaseRunId?: PhaseRunId }
  | { type: "channel.post-message"; channelId: ChannelId; messageId: MessageId; fromType: ParticipantType; fromId: string; fromRole?: string; content: string }
  | { type: "channel.read-messages"; channelId: ChannelId; sessionId: SessionId; upToSequence: number }  // sessionId is the participating child session
  | { type: "channel.conclude"; channelId: ChannelId; sessionId: SessionId; summary: string }  // sessionId is the participating child session
  | { type: "channel.close"; channelId: ChannelId }

type InteractiveRequestCommands =
  | { type: "request.open"; requestId: RequestId; sessionId: SessionId; childSessionId?: SessionId; requestType: InteractiveRequestType; payload: unknown }
  | { type: "request.resolve"; requestId: RequestId; resolvedWith: unknown }
  | { type: "request.mark-stale"; requestId: RequestId; reason: string }

type ForgeCommands = SessionCommands | ChannelCommands | InteractiveRequestCommands

// session.resume requires status='paused'. session.recover requires status='running'
// (the session was running when daemon crashed). The decider enforces these preconditions.

// Provider selection is structured, not inferred from model name prefix.
interface ModelSelection {
  provider: 'claude' | 'codex';
  model: string;              // e.g., 'claude-sonnet-4-5', 'gpt-5.4'
  effort?: string;            // provider-specific reasoning effort
}
```

The decider function signature: `function decide(command: ForgeCommands, readModel: ForgeReadModel): Result<ForgeEvent[], Error>`.

```typescript
interface ForgeReadModel {
  snapshotSequence: number;
  projects: Array<{ projectId: string; title: string; workspaceRoot: string; defaultModel?: ModelSelection }>;
  sessions: Array<{ sessionId: string; projectId: string; parentSessionId?: string; phaseRunId?: string; type: string; title: string; status: SessionStatus; provider?: string; role?: string; workflowId?: string; currentPhaseId?: string; runtimeMode: string; branch?: string; worktreePath?: string; model?: ModelSelection; archivedAt?: string }>;
  phaseRuns: Array<{ phaseRunId: string; sessionId: string; phaseId: string; phaseName: string; phaseType: string; iteration: number; status: string; workflowId: string }>;
  channels: Array<{ channelId: string; sessionId: string; type: string; status: string }>;
  pendingRequests: Array<{ requestId: string; sessionId: string; type: string; status: string }>;
  updatedAt: string;
}
```

ForgeReadModel is the SERVER-SIDE read model used by the decider for invariant checking. It includes more detail than the client ForgeSnapshot (which is stripped for wire efficiency).

## Checkpoint Revert Contract

Forge preserves t3-code's message-level undo capability, adapted to the session model.

### Revert granularity

Revert is per-session but ONLY allowed for the current (latest writing) leaf session in the worktree. Once a subsequent child session writes to the worktree, earlier child sessions' checkpoints become read-only history — they cannot be reverted to without destroying later work.

**Invariant:** `session.checkpoint-revert` is rejected if any child session with a later `created_at` than the target session has modified the worktree (i.e., has checkpoint refs). The decider enforces this by checking the readModel for newer child session checkpoints.

**Rationale:** git checkpoints capture the ENTIRE worktree state. `git reset --hard` to an older checkpoint restores the whole tree, not just one session's changes. Per-session checkpoint namespacing (`refs/forge/checkpoints/{session_id}/turn/{n}`) organizes refs but does NOT make the captured state session-scoped.

This matches t3-code's behavior where one thread = one session, so there was never a second writer to conflict with. In forge, the constraint is: revert is available within the currently active phase's child session(s). Once a phase completes and the next phase's child session writes, the previous phase's checkpoints are historical only.

### What gets trimmed on revert (within the constraint above)
1. Transcript entries after the target turn (from transcript_entries)
2. Checkpoint refs after the target turn (git refs deleted)
3. Phase outputs written after the target turn (if phase was completing)
4. Filesystem restored via `git reset --hard` to the target checkpoint ref
5. Provider state rolled back (Codex: thread/rollback; Claude: new session with truncated context)

### Provider state rollback
- **Codex**: Use `thread/rollback` with the target turn count. This is the primary mechanism — Codex manages its own conversation history server-side.
- **Claude**: Start a new session with conversation history truncated to the target turn. The SDK's `resume` parameter may help if the server-side session is still alive; otherwise, replay truncated transcript as context.

### Multi-agent revert
If a deliberation phase is reverted, both child sessions roll back to the target turn count. Channel messages posted after that point are soft-deleted (marked with `deleted_at`, not physically removed — preserves event log integrity).

**Note:** Multi-agent revert (rolling back both child sessions in a deliberation) is deferred to v2. For v1, revert is only available for the latest writing child session in single-agent phases. Chat sessions and multi-agent workflow phases do not support revert — their channel transcripts are append-only.

## Provider Approval Contract

### Session-level autonomy
`sessions.runtime_mode`: `supervised` | `autonomous` (default: autonomous). For child sessions, inherited from the parent session unless overridden by phase config.
- Supervised: provider enters approval-required mode. All tool calls require human approval.
- Autonomous: provider runs full-access. No approval prompts.

### interactive_requests payload schema for type='approval'

```json
{
  "requestType": "file_change_approval | file_read_approval | command_execution_approval | ...",
  "detail": "human-readable tool summary",
  "toolName": "Write",
  "toolInput": { "file_path": "/src/auth.ts", "content": "..." },
  "suggestions": ["Write:/src/**"]
}
```

### Resolution schema

```json
{
  "decision": "accept | acceptForSession | decline | cancel",
  "updatedPermissions": ["Write:/src/**"]
}
```

### Provider mapping (internal)
Each ProviderAdapter maps session.runtime_mode to provider-specific policy:
- Claude supervised -> approval-required (canUseTool callback prompts). autonomous -> full-access (allow all).
- Codex supervised -> `{ approvalPolicy: 'on-request', sandbox: 'workspace-write' }`. autonomous -> `{ approvalPolicy: 'never', sandbox: 'danger-full-access' }`.

### acceptForSession durability
Ephemeral. Lives in provider's in-memory session state. NOT persisted to SQLite. On session restart (crash recovery, daemon restart), all session-scoped permissions are lost. The leaf session will re-request approval. UI shows: 'Session permissions were reset — you may see repeat approval requests.'

### v2 extension points
- Per-project approval policy overrides (expose ProviderApprovalPolicy in project config)
- Per-project sandbox mode overrides (expose ProviderSandboxMode in project config)
- Per-phase runtime_mode (e.g., review=supervised, implement=autonomous)

### Bootstrap Request Resolution

The `bootstrap-failed` interactive request supports three resolution actions:

resolvedWith payloads:
- Retry: `{ action: 'retry' }` → BootstrapReactor re-runs the bootstrap script → emits session.bootstrap-completed or session.bootstrap-failed
- Skip: `{ action: 'skip' }` → BootstrapReactor emits session.bootstrap-skipped → session proceeds without bootstrap (quality checks may fail)
- Fail: `{ action: 'fail' }` → Engine dispatches session.fail → session status becomes 'failed'

CLI mapping:
- `forge bootstrap-retry <session-id>` → find pending bootstrap-failed request for this session → `request.resolve { requestId, resolvedWith: { action: 'retry' } }`
- `forge bootstrap-skip <session-id>` → same lookup → `request.resolve { requestId, resolvedWith: { action: 'skip' } }`
- `forge cancel <session-id>` covers the fail case (cancels the entire session)

## Agent-Initiated User Input Protocol

Providers emit `user-input.requested` events when the provider needs clarifying input from the user. State machine:

1. Provider emits user-input.requested
2. Engine creates interactive_request (type: `user-input`, status: `pending`, payload: questions)
3. Engine sets session status to `needs-attention`
4. Push event -> frontend shows questions in session view
5. Human answers via UI or CLI (`forge answer <session-id> --input ...`)
6. Engine resolves interactive_request (status: `resolved`, resolved_with: answers)
7. Engine sends answers to provider (Claude: respondToUserInput, Codex: item/tool/requestUserInput response)
8. Session status returns to `running`
9. Agent continues from where it paused

The leaf session stays `running` but blocked while waiting — the provider SDK holds the callback promise open. Session `needs-attention` status drives sidebar badge and notifications.

### Interactive Request Recovery Protocol

On daemon/app restart:

```typescript
async function recoverInteractiveRequests(db: Database): Promise<void> {
  const pending = await db.query("SELECT * FROM interactive_requests WHERE status = 'pending'");

  for (const req of pending) {
    switch (req.type) {
      case "approval":
      case "user-input":
        // Provider callback is gone (in-memory only). Mark stale, restart turn.
        await db.run(
          "UPDATE interactive_requests SET status = 'stale', stale_reason = 'session restarted after crash' WHERE request_id = ?",
          req.request_id
        );
        await engine.dispatch({ type: 'session.restart-turn', sessionId: req.child_session_id! });
        break;

      case "gate":
        // Gates are independent of provider state. Resume waiting.
        // The UI will re-render the gate approval view.
        break;

      case "correction-needed":
        // Channel is persisted. Resume waiting for human correction.
        break;
    }
  }
}
```

## Per-Phase Sandbox Mode

Workflow phases can specify a `sandboxMode` that controls what tools the child session's provider can use:
- `read-only`: Agent can read files, search, browse — but cannot write files or run commands. Used for review/deliberation phases.
- `workspace-write`: Agent can read and write files in the worktree, run commands. Used for implementation phases. (Default)
- `danger-full-access`: No restrictions. Used sparingly.

For multi-agent phases without channels (parallel independent review), `sandboxMode` defaults to `read-only`. This prevents two parallel child sessions from making conflicting file edits in the shared worktree.

The provider adapter maps sandboxMode to provider-native enforcement:
- Claude: `canUseTool` callback denies write tools when `read-only`
- Codex: `sandbox: 'read-only'` on session config

### Codex Collaboration Mode Mapping

Codex sessions require a collaboration mode (`plan` | `default`). Derived from workflow phase config:
- Phases can set `codexMode: 'plan' | 'default'` explicitly in config
- If not specified: default is `'default'`
- Deliberation/review phases that focus on analysis (not code writing) may benefit from `plan` mode

The `interactionMode` concept from t3-code is replaced by explicit phase config. There is no session-level interaction mode.

## Branch/Worktree Lifecycle

### Worktree lifecycle

```
Session created -> create worktree at ~/.forge/worktrees/{session_id}/
  Branch: forge/{session_id} (or user-specified)
  Created from: project's current HEAD

Session running -> child sessions operate in top-level session's worktree_path
  Child session cwd = parent session's worktree_path

Session completed -> prompt for cleanup
  If worktree clean: delete worktree, keep branch
  If uncommitted changes: warn user, keep worktree
  Auto-cleanup after 7 days for completed sessions (configurable)

Session failed -> keep worktree for debugging
  Auto-cleanup after 30 days (configurable)
```

### Worktree Creation Rules

1. Auto-generated sessions: worktree at `~/.forge/worktrees/{session_id}/`, branch `forge/{session_id}`
2. User-specified branch: worktree at `~/.forge/worktrees/{session_id}/`, branch as specified
   - REJECT if branch is checked out in main repo or claimed by another session
   - Error message includes the conflicting session ID
3. PR review sessions: worktree at `~/.forge/worktrees/{session_id}/`, tracking PR head branch
   - REJECT if PR branch already claimed by another session
4. Chat sessions: NO worktree unless `pattern.requiresWorkdir = true`
   - `requiresWorkdir=true`: worktree created, same rules as (1)
   - `requiresWorkdir=false`: child session cwd = project root, `runtime_mode = supervised`. sandboxMode defaults to 'read-only'. File writes are denied by the provider adapter.
5. Bootstrap: runs on EVERY new worktree creation. Never reruns (no adoption case).
6. Cleanup: session owns its worktree exclusively. Completed -> prompt cleanup. Failed -> keep for debugging.

### Branch Claim Model

A branch is Forge-claimed if and only if a session row has that branch AND `worktree_path IS NOT NULL` AND `archived_at IS NULL`.

### Branch Availability Check

Before creating a worktree with a user-specified or PR branch:
1. Query sessions table for active claims on that branch -> error with session ID
2. Query `git worktree list` for existing worktrees on that branch:
   a. Forge-managed path (under `~/.forge/worktrees/`) -> orphan, suggest cleanup
   b. External path -> error with path
3. Check main repo HEAD -> error if branch is currently checked out

Auto-generated `forge/{session_id}` branches skip this check (unique by construction).

### Semantic Branch Renaming

On first turn, forge renames the temporary `forge/{session_id}` branch to `forge/feat/{semantic-name}` (generated from session description or first provider message). Uses `resolveAvailableBranchName` for deduplication (append -1, -2 on collision).

Branch availability check runs at BOTH create and rename time. The sessions table `branch` column is updated atomically via `session.meta-updated` event. Source of truth for branch name is the sessions table; on recovery, reconcile against live git state if diverged.

### Worktree Cleanup Job

A periodic cleanup job (configurable interval, default daily) handles automatic worktree reclamation:

1. Find sessions where status IN ('completed', 'cancelled') AND worktree_path IS NOT NULL AND completed_at/updated_at is older than retention threshold (7 days for completed, 30 days for failed)
2. For each candidate:
   a. Check terminal session registry for active terminals with cwd inside the worktree. If found, skip cleanup and log "Worktree in use by terminal, skipping."
   b. Check if worktree is clean (no uncommitted changes)
3. If clean and no active terminals: `git worktree remove {path}`, set sessions.worktree_path = NULL (releases branch claim), delete worktree directory
4. If dirty: skip, log warning "Worktree has uncommitted changes, skipping cleanup"
5. On manual `forge cleanup` CLI command: run the same logic immediately, with --force flag to clean even dirty worktrees (terminal check still applies unless --force-all)

This job also cleans orphaned worktrees (worktrees under ~/.forge/worktrees/ not referenced by any session row).

### Dropped Behaviors (intentional cuts from t3-code)

- Worktree adoption (branch already has worktree -> reuse): DROPPED. Sessions always create fresh.
- Branch selector switching worktrees mid-session: DROPPED. Session is bound to its worktree for life.
- Local mode (operate in main repo without worktree): DROPPED for real sessions. Only chat sessions without requiresWorkdir.

### Worktree Bootstrap

Bootstrap runs SERVER-SIDE as an implicit pre-step before any child sessions spawn. It is not a workflow phase — it's infrastructure that every session requires.

**Bootstrap sequence:**
1. Engine creates git worktree: `git worktree add ~/.forge/worktrees/{session_id} -b forge/{session_id}`
2. Engine looks up project's bootstrap command (from project config `runOnWorktreeCreate` or `.forge/config.json`)
3. Engine runs bootstrap command in the worktree (e.g., `npm install`, `bun install`)
4. On success: session proceeds to first workflow phase (or provider start for standalone agent sessions)
5. On failure: session enters `needs-attention` status, interactive_request created (type: `bootstrap-failed`), human sees error output and can retry/skip/fail
6. Timeout: configurable, default 5 minutes. Hung scripts are killed.

The existing t3-code `ProjectScript.runOnWorktreeCreate` mechanism moves from web (client-side) to server (daemon-side). The project config maps the bootstrap command.

**Worktree cost model (v1):** Each session incurs a full bootstrap cost. Rely on package manager caches for efficiency. This is the same model as CI systems. Shared node_modules or pre-built pools are v2 optimizations.

### Workflow Completion Actions

Workflows can configure post-completion git operations via on_completion in the workflow definition:
- auto_commit: boolean — commit all changes in the worktree
- auto_push: boolean — push the branch to remote
- create_pr: boolean — create a PR with AI-generated title/description

These are NOT phases. They run after the last phase completes, using t3-code's existing GitManager infrastructure (stacked actions: commit -> push -> PR creation with progress tracking).

If not configured, the session shows uncommitted changes and the user uses the standard git controls (same as t3-code's commit/push/PR UI).

## Session Admission Control

**Policy:** FIFO, leaf-session-level limiting, no preemption.

- `maxConcurrentLeafSessions` config (default: 3). Counts active provider leaf sessions (Claude SDK + Codex subprocesses).
- When engine starts a child session and limit is reached: phase_run stays `pending`. Parent session stays `running` (conceptually in progress, waiting for slot).
- When a leaf session completes or fails: engine checks pending phase_runs (FIFO by created_at), starts next.
- No new session status needed. UI shows 'Waiting for slot' in phase status when a phase_run is pending due to admission control.
- No preemption in v1 — running leaf sessions are never interrupted to free slots.

### Multi-Session Admission

Phases requiring N child sessions reserve N slots atomically:
- If N slots available: reserve all N, start child sessions
- If fewer than N slots available: phase_run stays `pending`
- Single-session phases behind a waiting multi-session phase CAN consume individual freed slots. FIFO applies at the phase_run level, but a phase_run that needs N slots yields to the next phase_run that CAN start with available slots. This prevents capacity deadlock.

### Workload Admission (beyond provider sessions)

Provider leaf sessions are NOT the only expensive work. The daemon also runs:
- Worktree bootstrap scripts (`npm install`, `bun install`) — heavy CPU/disk/network
- Quality check commands (test suites, linters, typecheckers) — heavy CPU
- Git operations (worktree creation, checkpoint capture) — moderate I/O

**v1 policy:**
- `maxConcurrentBootstraps`: default 2. Bootstraps queue FIFO beyond this limit.
- `maxConcurrentQualityChecks`: default 2. Quality checks queue FIFO.
- Git operations: serialized per-session (no global limit needed — they're fast).

These limits are separate from `maxConcurrentLeafSessions`. A system with 3 active leaf sessions can also have 2 bootstraps and 2 quality checks running simultaneously.

### Starvation Prevention

The yield-to-smaller-phase rule (multi-session phases yield slots to single-session phases that can start) can starve multi-session phases if single-session work keeps arriving.

**v1 mitigation:** After a multi-session phase has been pending for 3 consecutive slot-free cycles (i.e., 3 single-session phases started while it waited), the next freed slot is RESERVED for the multi-session phase. No single-session phase can consume it. This provides bounded starvation — maximum 3 bypasses before the multi-session phase gets priority.

## Quality Check Configuration

Workflows reference quality checks by key, not by command. Project-level config maps keys to commands.

Project config (~/.forge/config.json or .forge/config.json in repo root):

```json
{
  "qualityChecks": {
    "test": { "command": "bun run test", "required": true },
    "lint": { "command": "bun lint", "required": true },
    "typecheck": { "command": "bun typecheck", "required": true }
  }
}
```

Workflow YAML references keys:

```yaml
qualityChecks:
  - check: test
    required: true
```

If no project config exists, forge detects package manager from lockfile and generates defaults. This is a convenience, not a guarantee.

## Transcript Storage

Retention: active leaf session transcripts are fully loaded. Completed leaf session transcripts are paginated (most recent 200 entries by default, older on-demand). Archival after 30 days moves transcripts to compressed files, metadata stays in SQLite.

### Transcript Archival Retrieval

After the archival period (default 30 days), transcript entries are moved from SQLite to compressed files:
- Archive path: `~/.forge/archives/{session_id}/transcript.jsonl.gz`
- Format: gzipped JSON Lines (one transcript_entry JSON object per line)
- Metadata stays in SQLite: `sessions` table retains the session record with token usage and status

`session.getTranscript()` retrieval logic:
1. Check `sessions.transcript_archived` flag
2. If transcript_archived = 0: query SQLite `transcript_entries` table (normal path)
3. If transcript_archived = 1: read from archive file at `~/.forge/archives/{session_id}/transcript.jsonl.gz`
4. If transcript_archived = 1 but archive file missing: return error "Transcript archived but file not found"
5. Never fall through based on row absence — a leaf session with zero transcript rows is a new/empty session, not an archived one
6. Pagination works on both sources (offset/limit applied after decompression for archived transcripts)

Archive files are created by a periodic cleanup job (configurable interval, default daily). The job:
1. Finds leaf sessions where `completed_at` is older than the archival threshold
2. Exports transcript_entries to gzipped JSONL
3. Deletes the SQLite rows
4. Updates `sessions.transcript_archived` to 1. This is separate from `sessions.archived_at` which is the user-facing archive lifecycle.

**Performance note:** Archived transcript retrieval is O(file_size) per request (full decompression before offset/limit). Acceptable because archived access is infrequent (historical review only). v2 optimization: chunked archives with index file for O(chunk_size) pagination.

## Claude MCP Tool Integration

```typescript
// In-process MCP server registered when spawning a child session that participates in a channel
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

function createChannelMcpServer(engine: OrchestrationEngine, session: Session, channel: Channel) {
  return createSdkMcpServer({
    name: "forge-channels",
    tools: [
      {
        name: "post_to_channel",
        description: "Post a message to the shared channel. Other participants can see this.",
        schema: { message: z.string().describe("Your message to post") },
        async handler({ message }) {
          // Content-hash idempotency (matches doc 11 pattern)
          const currentSeq = await engine.getChannelMaxSequence(channel.id);
          const key = idempotencyKey(session.id, "post_to_channel", { message }, currentSeq);
          const cached = await engine.getToolCallResult(session.provider, session.id, key);
          if (cached) return cached;

          const messageId = crypto.randomUUID();
          await engine.dispatch({
            type: "channel.post-message",
            channelId: channel.id,
            messageId,
            fromType: "agent",
            fromId: session.id,
            fromRole: session.role,
            content: message,
          });

          const result = { content: [{ type: "text" as const, text: `Posted message ${messageId}` }] };
          await engine.cacheToolCallResult(session.provider, session.id, key, result);
          return result;
        },
      },
      {
        name: "read_channel",
        description: "Read unread messages from the shared channel.",
        schema: {},
        async handler() {
          // read_channel is naturally idempotent: same cursor = same result.
          // No cache needed — cursor position is the idempotency key.
          const cursor = await engine.getChannelReadCursor(channel.id, session.id);
          const messages = await engine.getChannelMessagesSince(channel.id, cursor);

          // DO NOT advance cursor here. Cursor advances on explicit ack
          // or on next post_to_channel (implicit ack).

          return {
            content: [{
              type: "text" as const,
              text: messages.length === 0
                ? "No new messages."
                : messages.map(m => `[${m.fromRole || m.fromType}]: ${m.content}`).join("\n\n"),
            }],
          };
        },
      },
      {
        name: "propose_conclusion",
        description: "Propose that the deliberation has reached a conclusion. Both participants must propose for it to end.",
        schema: { summary: z.string().describe("Your summary of the conclusion reached") },
        async handler({ summary }) {
          // Content-hash idempotency
          const currentSeq = await engine.getChannelMaxSequence(channel.id);
          const key = idempotencyKey(session.id, "propose_conclusion", { summary }, currentSeq);
          const cached = await engine.getToolCallResult(session.provider, session.id, key);
          if (cached) return cached;

          await engine.dispatch({
            type: "channel.conclude",
            channelId: channel.id,
            sessionId: session.id,
            summary,
          });

          const result = { content: [{ type: "text" as const, text: "Conclusion proposed. Waiting for other participant(s)." }] };
          await engine.cacheToolCallResult(session.provider, session.id, key, result);
          return result;
        },
      },
    ],
  });
}
```

### Codex Turn Injection (v1 fallback)

Codex cannot host MCP tools. For v1, channel participation works via turn injection:

```typescript
// Between Codex turns for a child session, inject new channel messages as a user message
function buildChannelInjectionTurn(messages: ChannelMessage[]): string {
  if (messages.length === 0) return "";
  const formatted = messages
    .map(m => `[${m.fromRole || m.fromType}]: ${m.content}`)
    .join("\n\n");
  return `[CHANNEL UPDATE - New messages from other participants]\n\n${formatted}\n\n` +
    `Respond to these messages. When you want to post a response, write your response ` +
    `clearly. When you think the discussion has reached a conclusion, say "PROPOSE CONCLUSION" ` +
    `followed by your summary.`;
}

// Engine parses Codex response for channel posts and conclusion signals
// This is heuristic but scoped to a known protocol, not free-text classification
```

The asymmetry is accepted for v1. The deliberation engine abstracts over the transport difference: it sees channel messages regardless of whether they came from MCP tool calls (Claude) or parsed turn responses (Codex).

### Codex turn/steer Decision

v1 intentionally does NOT use Codex's `turn/steer` API for mid-turn correction injection. Corrections are delivered between turns for both providers, ensuring consistent correction behavior regardless of provider.

Rationale: Using turn/steer for Codex but not Claude would create provider-asymmetric correction latency. Users would learn different correction timing expectations per provider. Between-turn delivery is predictable and sufficient for v1.

v2 consideration: If Claude SDK adds mid-session message injection, both providers can adopt mid-turn corrections simultaneously. Until then, between-turn is the uniform policy.

## Startup Sequence

1. Open SQLite database (create ~/.forge/ directory and forge.db if missing)
2. Run migrations (fail loudly on failure — no partial state)
3. Compute read model from projection tables. Projection tables persist across restarts. Check `projection_state` cursor vs event store high-water mark — if events exist beyond the cursor, replay from cursor forward. There is NO separate snapshots table — projections ARE the snapshot.
4. Create composition root (all services instantiated, none accepting work)
5. Open socket (daemon) / WebSocket (app) — accept connections, queue commands
6. Recover state:
   a. Stale interactive requests -> mark stale, prepare session restart
   b. Deliberation state -> check child session liveness, prepare recovery
   c. Paused sessions -> leave paused (resume requires explicit command)
7. Emit 'welcome' (clients hydrate read model)
8. Emit 'ready' (start processing queued commands)
9. Resume leaf sessions for sessions that were 'running' at shutdown:
   a. Claude: try resume with stored session ID, fallback to context summary
   b. Codex: thread/resume with stored thread ID, fallback to context summary
   Resume commands are dispatched through the normal command path (FIFO ordering with user commands). The engine dispatches `session.resume` commands — it does NOT directly spawn provider processes during recovery. This means a user `session.pause` received during recovery is processed in FIFO order relative to resume commands.
10. Start notification dispatch

## Shutdown Policy

daemon.stop / app close with stop:

1. Stop accepting new commands
2. Notify connected clients: shutting_down
3. For each running leaf session: send interrupt to provider, wait up to 30s, force-kill
4. Persist final state (flush event store, update snapshots)
5. Close socket/WebSocket, close database
6. Exit

App close with 'keep running in background':

1. Backend transitions to daemon mode (already running)
2. App disconnects
3. Backend continues processing
4. PID file + socket persist for discovery

## Daemon Singleton and Discovery

Only one forge daemon may own ~/.forge/forge.sock at a time.

Startup discovery algorithm:

1. Acquire exclusive flock on ~/.forge/forge.lock
2. Check if ~/.forge/forge.pid exists
3. If PID exists and process alive: connect to socket, send daemon.ping
   a. Ping succeeds -> daemon running, connect as client
   b. Ping fails -> process is wedged, kill it, remove PID + socket, start fresh
4. If PID exists and process dead: remove stale PID + socket, start fresh
5. If no PID: start fresh
6. On fresh start: bind socket, write PID file, release flock

Stale socket recovery: the flock prevents races between two processes trying to bind simultaneously.

Desktop single-instance: Electron's requestSingleInstanceLock(). Second instance sends argv to first via 'second-instance' event, then exits. First instance focuses window and processes the command (e.g., forge://session/123 navigation).

Protocol handler: Electron's setAsDefaultProtocolClient('forge'). On 'open-url' event, parse forge://session/{id} and navigate to that session.

## Client Bootstrap Contract

When the app connects (or reconnects) to the backend/daemon, it receives a session-centric read model.

### Initial Snapshot (`getSnapshot` RPC)

Returns compact metadata — NO transcripts, NO full channel histories:

```typescript
interface ForgeSnapshot {
  snapshotSequence: number;       // for delta subscription
  projects: ProjectSummary[];     // id, title, workspaceRoot
  sessions: SessionSummary[];     // id, projectId, parentSessionId, phaseRunId, type, title, status, provider, role, bootstrapStatus, workflowId, currentPhaseId, branch, createdAt, updatedAt, archivedAt — client builds tree from parentSessionId
  activePhaseRuns: PhaseRunSummary[];  // id, sessionId, phaseName, phaseType, status, iteration — only current/active
  pendingRequestCounts: Record<SessionId, number>;  // badge counts for needs-attention
}
```

### Lazy-Loaded by RPC (on user navigation)

| Data | RPC | When loaded |
|------|-----|-------------|
| Transcript entries | `session.getTranscript({ sessionId, limit?, offset? })` | User opens a leaf session's chat view |
| Child sessions | `session.getChildren({ sessionId })` | User expands a collapsed container session in the tree |
| Channel messages | `channel.getMessages({ channelId, limit?, offset? })` | User opens deliberation view |
| Historical phase runs | `session.getPhaseRuns({ sessionId })` | User expands session history (returns phase run summaries including associated child session IDs and channel IDs per phase, enabling navigation to historical phases) |
| Phase outputs | `session.getPhaseOutput({ phaseRunId, outputKey })` | Workflow resolution or user request |
| Quality check details | `session.getQualityChecks({ phaseRunId })` | User expands gate results |
| Session channels | `session.getChannels({ sessionId })` | User opens a session detail |
| Deliberation state | `phaseRun.getDeliberationState({ phaseRunId })` | Rendering deliberation view |
| Chat synthesis | `session.getSynthesis({ sessionId })` | After chat conclusion |

### Push Event Channels (deltas after snapshot)

| Channel | Payload | Purpose |
|---------|---------|---------|
| `session.event` | Session lifecycle changes (status, phase transition) — applies to all sessions | Update sidebar badges, update child session views |
| `channel.message` | New channel messages | Update deliberation view |
| `request.event` | Interactive request changes | Update attention badges, show approval UI |
| `notification.event` | Attention-needed signals | Trigger OS notifications |
| `session.synthesis` | Synthesis generated for chat session | Update chat session view |
| `session.bootstrap` | Bootstrap stdout/stderr, progress, completion | Stream bootstrap logs to UI |
| `session.correction` | Correction queued/delivered status | Update correction UI state |

```typescript
type SessionBootstrapEvent =
  | { type: 'session.bootstrap-started'; sessionId: SessionId }
  | { type: 'session.bootstrap-output'; sessionId: SessionId; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'session.bootstrap-completed'; sessionId: SessionId; success: boolean; error?: string }
```

Bootstrap events are ephemeral push events (not event-sourced). On failure, the bootstrap error summary is persisted in the `interactive_requests.payload_json` for the `bootstrap-failed` request — this survives reconnect. Live stdout streaming is best-effort and lost on disconnect.

The welcome payload replaces t3-code's `ServerLifecycleWelcomePayload` (which carried `bootstrapThreadId`). The new welcome is simply the snapshot above.

## Daemon Transport

```
Transport:
  macOS/Linux:  Unix domain socket at ~/.forge/forge.sock
                Permissions: 0600 (owner only)
                Auth: OS-level (socket permissions)
  Windows:      Named pipe \\?\pipe\forge
                Auth: Windows ACL (current user)
  WSL:          Unix socket within WSL at ~/.forge/forge.sock
                (WSL daemon is separate from Windows daemon)

v1 implements macOS/Linux transports only. Windows/WSL definitions are included for
completeness but are NOT part of v1. The Electron app on Windows uses in-app
notifications only (no daemon mode, no OS notifications in v1).

Protocol: JSON-RPC 2.0, bidirectional
  Requests:     { jsonrpc: "2.0", id, method, params } -> { jsonrpc: "2.0", id, result }
  Subscriptions: { method: "events.subscribe", params: { fromSequence } }
                  -> stream of { channel: "event", sequence, data }
  Reconnect:    client provides lastSequence, server replays from event store
  Dedup:        client-side by sequence (same pattern as current ws.ts)
  Sequence:     monotonic from event store (same source as WebSocket events)
```

## Product Identity

```
Base directory:     ~/.forge/
SQLite database:    ~/.forge/forge.db
Socket path:        ~/.forge/forge.sock
PID file:           ~/.forge/forge.pid
Config:             ~/.forge/config.json
Logs:               ~/.forge/logs/
Worktrees:          ~/.forge/worktrees/{session_id}/
Provider logs:      ~/.forge/logs/sessions/{session_id}/

Protocol scheme:    forge://
App ID (macOS):     com.forgetools.forge
App ID (Linux):     forge.desktop

State isolation:    Forge NEVER reads/writes ~/.t3
                    Both can coexist on same machine
                    No migration of t3 data — fresh start
```

### Version Compatibility

- Database migrations are strictly forward-only. Rolling back forge binaries after a migration requires restoring from backup or starting fresh.
- The daemon reports its protocol version on client connect (in the welcome payload). If app protocol version != daemon protocol version, the app shows 'Version mismatch — please restart the daemon' and refuses to operate.
- CLI tools include the protocol version in their socket handshake. Version mismatch returns an error with upgrade instructions.
- Event store format is append-only and forward-compatible. New event types are ignored by old projectors (they skip unknown events). This means a newer daemon can write events that an older projector doesn't understand, but the older projector won't crash.

## Dependency Matrix (v1)

```
REQUIRED (hard prerequisites):
  Node.js >= 24           Runtime (Node path)
  Bun >= 1.3              Runtime (Bun path)
  SQLite (bundled)        Persistence (node:sqlite on Node, bun:sqlite on Bun)
  @anthropic-ai/claude-agent-sdk   Claude provider
  Electron >= 40          Desktop app
  Git >= 2.30             Worktrees, checkpoints, branch management (required)

REQUIRED (user-installed):
  Codex CLI               Codex provider (if using Codex workflows)

OPTIONAL (degrades gracefully):
  terminal-notifier       macOS notifications (without: in-app only)
  notify-send             Linux notifications (without: in-app only)

EXPERIMENTAL (v2):
  Codex dynamicTools      Symmetric channel tools for Codex

NOT v1:
  Windows native daemon   (Electron works, daemon is macOS/Linux only)
  WSL daemon mode         (users run forge app in WSL with Wayland/X11)
```

## Why This Is Better

1. **No unnecessary abstraction.** You start a session, not a "task that contains a session." Direct.
2. **t3-code UI stays intact for agent sessions.** The thread -> agent session mapping is trivial. All the chat view, approval UI, diff viewer, terminal drawer work as-is.
3. **Chat sessions don't need scratch task indirection.** A chat IS a session. No `__scratch__` workflow, no synthetic phase runs.
4. **The sidebar is unified.** One list of sessions. Type determines rendering, not section placement.
5. **Outputs display naturally.** Phase outputs, synthesis, quality checks — they're rendered inline in the session view, not in a separate "task detail" panel.
6. **Promotion is simpler.** Chat session -> workflow session is just: create new workflow session, add a `promoted-from` session_link. The chat session's channel content feeds the first phase via inputFrom.

## Design Tradeoffs

### The goal-aggregate tradeoff

The sessions-first model collapses two concepts: the **goal** (what to accomplish) and the **execution aggregate** (what manages state). In the task-centric model, a Task was the goal and contained sessions as execution. Here, the session IS both.

This is a deliberate simplification. The cost: if you want to "retry a goal differently" (different workflow, different approach), you create a new session and link it (session_links, link_type='related'). There's no parent entity to group retries under. The benefit: no Task layer to maintain, no Task-Session impedance mismatch, simpler UI, simpler event model.

For most workflows this is the right call — users think in terms of "I started a conversation" or "I started a workflow run," not "I have a persistent goal that spawns execution attempts." If persistent goals become important later, session groups provide a lightweight grouping mechanism without reintroducing the Task entity.

## Migration from t3-code

The thread-to-session mapping is almost 1:1:
- Thread.id -> Session.id (type: "agent")
- Thread.title -> Session.title
- Thread.modelSelection -> Session.model_json
- Thread.runtimeMode -> Session.runtime_mode
- Thread.branch -> Session.branch
- Thread.worktreePath -> Session.worktree_path
- Thread.messages -> stays as-is (agent sessions use the same message model)
- Thread.activities -> stays as-is
- Thread.session (OrchestrationSession) -> Agent record
- Thread.checkpoints -> checkpoint_refs

The aggregate changes from "thread" to "session" in the event store. But for agent sessions, the events are structurally identical with different type names.

## What This Means for Each Design Doc

- **doc 02 (data model)**: CONSOLIDATED into this document
- **doc 04 (workflow engine)**: Workflow attaches to session.type="workflow", not to tasks. Phase runner unchanged.
- **doc 05 (workspace UX)**: Sidebar shows sessions. Agent sessions use t3-code's chat view. Workflow sessions add phase UI.
- **doc 06 (agent integration)**: Child sessions replace "provider sessions." Context injection, recovery matrix unchanged.
- **doc 07 (daemon mode)**: Socket API references sessions instead of tasks. CLI: `forge list`, `forge correct <session-id>`, etc.
- **doc 08 (deliberation)**: Chat sessions replace scratch tasks. Channel tools unchanged.
- **doc 10 (schemas)**: CONSOLIDATED into this document.
- **doc 11 (channel tool contract)**: channel_reads keyed by (channel_id, session_id) where session_id is the participating child session. Otherwise unchanged.
- **doc 12 (chat mode)**: SIMPLIFIED — chat sessions are first-class, no scratch task indirection.

## Related Documents

- [01-architecture.md](./01-architecture.md) - System architecture
- [04-workflow-engine.md](./04-workflow-engine.md) - How workflows execute
- [05-workspace-ux.md](./05-workspace-ux.md) - How the data model surfaces in the UI
- [07-daemon-mode.md](./07-daemon-mode.md) - Daemon architecture
- [11-channel-tool-contract.md](./11-channel-tool-contract.md) - Deep dive on channel integration
