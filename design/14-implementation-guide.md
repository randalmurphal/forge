# Implementation Guide

## Approach

Forge is built by EXTENDING the existing t3-code codebase, not rewriting it. Effect.js stays. The thread model stays. New features (workflows, channels, child threads, deliberation) are added on top of what already works.

Every implementation task should follow the patterns already established in the codebase. This document defines those patterns and the concrete tasks.

## Codebase Patterns to Follow

### Server: Services + Layers

Every new server feature follows the established two-directory pattern:

```
feature/
├── Services/
│   └── FeatureService.ts     ← Interface only (ServiceMap.Service pattern, 40-100 lines)
├── Layers/
│   ├── FeatureService.ts     ← Implementation (Effect.gen, 200-500 lines)
│   └── FeatureService.test.ts ← Tests co-located
├── Errors.ts                  ← Error types
└── Utils.ts                   ← Pure helpers
```

**Interface definition:**
```typescript
export interface WorkflowEngineShape {
  readonly startPhase: (input: StartPhaseInput) => Effect.Effect<void, WorkflowEngineError>;
  readonly evaluateGate: (input: EvaluateGateInput) => Effect.Effect<GateResult, WorkflowEngineError>;
}

export class WorkflowEngine extends ServiceMap.Service<WorkflowEngine, WorkflowEngineShape>()(
  "forge/workflow/Services/WorkflowEngine",
) {}
```

**Implementation:**
```typescript
const makeWorkflowEngine = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine;
  const sql = yield* SqlClient.SqlClient;

  const startPhase: WorkflowEngineShape["startPhase"] = (input) =>
    Effect.gen(function* () {
      // ...
    });

  return { startPhase, evaluateGate };
});

export const WorkflowEngineLive = Layer.effect(WorkflowEngine, makeWorkflowEngine);
```

### Orchestration: Extending Decider/Projector

New commands and events are added to the existing decider.ts and projector.ts. These files grow but remain the single source of truth for command → event logic and event → read-model projection.

**New commands** are added to the command union in packages/contracts/src/orchestration.ts. Follow the existing naming: `thread.{action}` for thread-level, `channel.{action}` for channel-level.

**New events** follow past-tense naming: `thread.phase-started`, `thread.phase-completed`, `channel.message-posted`.

**The decider** validates invariants against the read model and returns events. No IO. No side effects.

**The projector** applies events to the in-memory read model. No IO. No side effects.

**Reactors** handle async side effects triggered by events (starting providers, running quality checks, bootstrap). These are separate Effect services.

### Persistence: Migrations + Repositories

New tables are added via numbered migrations in apps/server/src/persistence/Migrations/. Follow the existing pattern:

```typescript
// 020_WorkflowTables.ts
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS phase_runs (...)`;
  yield* sql`CREATE TABLE IF NOT EXISTS workflows (...)`;
  yield* sql`CREATE INDEX IF NOT EXISTS ...`;
});
```

New repositories follow Services/ + Layers/ pattern in persistence/.

### Frontend: Components + Stores

**New components** go in apps/web/src/components/. Extract pure logic into `.logic.ts` files with `.logic.test.ts` tests.

**State changes** extend the existing Zustand store (apps/web/src/store.ts) or create focused new stores if the concern is distinct.

**Server data** uses TanStack React Query for fetching and mutations.

**Styling** uses Tailwind CSS. Dark mode via CSS variables. Component variants via CVA. Icons from Lucide React.

**Routing** uses TanStack Router file-based routing in apps/web/src/routes/.

### Contracts: Shared Types

New types go in packages/contracts/src/. Use @effect/schema for runtime-validated types. Group by domain:

- orchestration.ts — extend for workflow/channel commands and events
- New files for distinct domains (workflow.ts, channel.ts) if orchestration.ts gets too large

### Testing

Co-locate tests with implementation. Mock services via Layer.succeed(). Run Effects with Effect.runPromise(). Extract pure logic for focused testing.

## New Server Directory Structure

```
apps/server/src/
├── workflow/                    ← NEW
│   ├── Services/
│   │   ├── WorkflowEngine.ts
│   │   ├── WorkflowRegistry.ts
│   │   └── QualityCheckRunner.ts
│   ├── Layers/
│   │   ├── WorkflowEngine.ts
│   │   ├── WorkflowEngine.test.ts
│   │   ├── WorkflowRegistry.ts
│   │   ├── QualityCheckRunner.ts
│   │   └── QualityCheckRunner.test.ts
│   ├── BuiltInWorkflows.ts      ← YAML loading + materialization
│   └── Errors.ts
│
├── channel/                     ← NEW
│   ├── Services/
│   │   ├── ChannelService.ts
│   │   └── DeliberationEngine.ts
│   ├── Layers/
│   │   ├── ChannelService.ts
│   │   ├── ChannelService.test.ts
│   │   ├── DeliberationEngine.ts
│   │   ├── DeliberationEngine.test.ts
│   │   └── McpChannelServer.ts  ← MCP tool hosting for Claude
│   └── Errors.ts
│
├── daemon/                      ← NEW (later)
│   ├── Services/
│   │   └── DaemonService.ts
│   ├── Layers/
│   │   ├── DaemonService.ts
│   │   ├── SocketTransport.ts
│   │   └── NotificationDispatch.ts
│   └── Errors.ts
│
├── orchestration/               ← EXISTING, extended
│   ├── decider.ts               ← Add workflow/channel commands
│   ├── projector.ts             ← Add workflow/channel event handling
│   ├── Layers/
│   │   ├── WorkflowReactor.ts   ← NEW — phase lifecycle management
│   │   ├── BootstrapReactor.ts  ← NEW — worktree bootstrap
│   │   ├── ChannelReactor.ts    ← NEW — channel event handling
│   │   └── ... existing reactors stay
│   └── Services/
│       └── ... existing + new reactor interfaces
│
├── persistence/                 ← EXISTING, extended
│   ├── Migrations/
│   │   ├── 020_WorkflowTables.ts       ← NEW
│   │   ├── 021_ChannelTables.ts        ← NEW
│   │   ├── 022_ThreadExtensions.ts     ← NEW (parent_thread_id, etc.)
│   │   └── 023_PhaseOutputTables.ts    ← NEW
│   ├── Services/
│   │   ├── ProjectionPhaseRuns.ts      ← NEW
│   │   ├── ProjectionChannels.ts       ← NEW
│   │   ├── ProjectionChannelMessages.ts ← NEW
│   │   └── ProjectionPhaseOutputs.ts   ← NEW
│   └── Layers/
│       ├── ProjectionPhaseRuns.ts      ← NEW
│       ├── ProjectionChannels.ts       ← NEW
│       └── ... implementations
```

## New Frontend Structure

```
apps/web/src/
├── components/
│   ├── WorkflowTimeline.tsx          ← NEW — phase output timeline
│   ├── WorkflowTimeline.logic.ts     ← NEW — pure derivation logic
│   ├── WorkflowTimeline.logic.test.ts
│   ├── WorkflowEditor.tsx            ← NEW — workflow creation/editing
│   ├── WorkflowEditor.logic.ts
│   ├── ChannelView.tsx               ← NEW — deliberation channel display
│   ├── ChannelView.logic.ts
│   ├── PhaseCard.tsx                 ← NEW — phase card in workflow editor
│   ├── QualityCheckResults.tsx       ← NEW — check pass/fail display
│   ├── GateApproval.tsx              ← NEW — inline gate approval UI
│   ├── Sidebar.tsx                   ← MODIFIED — add tree expansion
│   ├── ChatView.tsx                  ← EXISTING — unchanged for plain threads
│   └── ... existing components stay
│
├── routes/
│   ├── _chat.$threadId.tsx           ← EXISTING — plain thread view
│   ├── _workflow.$threadId.tsx       ← NEW — workflow timeline view
│   ├── _workflow.editor.tsx          ← NEW — workflow editor page
│   ├── _workflow.editor.$workflowId.tsx ← NEW — edit specific workflow
│   └── ... existing routes stay
│
├── stores/
│   ├── workflowStore.ts              ← NEW — workflow state
│   └── channelStore.ts               ← NEW — channel state
```

## Implementation Tasks

### Group 1: Schema & Data Layer

**1.1 — Thread extensions migration**
Add columns to thread projection tables:
- parent_thread_id (nullable FK to threads)
- phase_run_id (nullable FK to phase_runs)
- workflow_id (nullable FK to workflows)
- workflow_snapshot_json (frozen workflow at creation)
- current_phase_id
- pattern_id (for deliberation)
- role (for child threads in deliberation)
- deliberation_state_json
- bootstrap_status

Create the migration file, update the projection thread repository interfaces and implementations.

**1.2 — Workflows table + repository**
Create workflows table (id, name, description, phases_json, built_in, created_at, updated_at). Create Services/ProjectionWorkflows.ts interface and Layers/ implementation. Add UNIQUE index on (name, built_in).

**1.3 — Phase runs table + repository**
Create phase_runs table (id, thread_id, workflow_id, phase_id, phase_name, phase_type, sandbox_mode, iteration, status, gate_result_json, quality_checks_json, deliberation_state_json, started_at, completed_at). Create repository.

**1.4 — Channel tables + repositories**
Create channels, channel_messages, channel_reads tables with indexes. Create repository interfaces and implementations.

**1.5 — Phase outputs table + repository**
Create phase_outputs table (phase_run_id, output_key, content, source_type, source_id, metadata_json, created_at, updated_at). Create repository.

**1.6 — Extend orchestration contracts**
Add new command types and event types to packages/contracts/src/orchestration.ts:
- Workflow commands: thread.start-phase, thread.complete-phase, thread.fail-phase
- Channel commands: channel.create, channel.post-message, channel.conclude
- Phase output events: thread.phase-output-written
- All event payloads as @effect/schema types

### Group 2: Workflow Engine

**2.1 — WorkflowRegistry service**
Loads built-in workflow YAML, materializes to DB on startup, resolves workflows by name with built_in precedence. Effect Layer following Services/ + Layers/ pattern.

**2.2 — WorkflowEngine service**
Phase runner logic: given a workflow definition and a thread, execute phases in sequence. For each phase: spawn child thread(s), wait for completion, evaluate gate, handle retry/continue/fail. This is the orchestration core — it dispatches commands to the OrchestrationEngine, doesn't do work directly.

**2.3 — WorkflowReactor**
Subscribes to thread events. When a workflow thread is created, starts the first phase. When a child thread completes, evaluates the gate and advances to the next phase. When quality checks are needed, triggers QualityCheckRunner. Deterministic commandIds for idempotency.

**2.4 — QualityCheckRunner service**
Reads project quality check config, executes shell commands (test, lint, typecheck), captures output, reports results. Runs in the session's worktree. Timeout handling. Returns structured pass/fail results.

**2.5 — BootstrapReactor**
When a thread needs a worktree (workflow or agent thread with worktree enabled), creates the git worktree, runs the project's bootstrap command (npm install, etc.), reports success/failure. Emits bootstrap events.

**2.6 — Decider extensions**
Add workflow/channel command handling to the existing decider.ts. Validate invariants (phase ordering, gate preconditions, channel state). Emit appropriate events.

**2.7 — Projector extensions**
Add event handling for new event types. Update the in-memory read model with workflow/phase/channel state. Materialize phase_outputs from event payloads.

**2.8 — Built-in workflow definitions**
YAML files for: implement (single phase), build-loop (implement + quality checks + review + finalize), interrogate, debate, explore, code-review, refine-prompt, plan-then-implement. Including prompt templates for each agent role.

### Group 3: Channel System

**3.1 — ChannelService**
Message persistence, cursor management, message retrieval. Effect Layer. Handles guidance channels (human → agent correction) and deliberation channels (agent ↔ agent).

**3.2 — McpChannelServer**
In-process MCP server for Claude sessions participating in deliberation. Hosts post_to_channel, read_channel, propose_conclusion tools. Registered via mcpServers on query(). Content-hash idempotency.

**3.3 — Codex channel injection**
Turn injection for Codex sessions in deliberation. Format channel messages as synthetic user turns. Parse PROPOSE_CONCLUSION prefix from responses. Manage injection state for crash recovery.

**3.4 — DeliberationEngine**
Turn-taking management for multi-agent phases. Ping-pong strategy. Liveness tracking (stall detection, nudge limits). Conclusion detection (mutual propose_conclusion). Persists deliberation state.

### Group 4: Frontend

**4.1 — Sidebar tree**
Extend Sidebar.tsx to support parent/child thread hierarchy. Expandable containers for workflow and deliberation threads. Status badge propagation from children to parent. Tree depth bounded at 2. Follow existing Sidebar patterns.

**4.2 — Workflow picker in thread creation**
Add workflow dropdown to the thread creation flow. List available workflows (built-in + project + user). "None" = plain agent chat (default, existing behavior). Selecting a workflow sets workflow_id on the thread.

**4.3 — Workflow timeline view**
New component for viewing workflow thread output. Shows phase outputs rendered by type (schema summary, channel conversation, plain text). Quality check results between phases. Gate approval UI inline. Route: _workflow.$threadId.tsx.

**4.4 — Channel view**
New component for viewing deliberation conversations. Messages color-coded by role. Turn counter. Intervene button (post to channel). View individual participant's full transcript by clicking their name. Split view option (participant transcripts flanking channel).

**4.5 — Workflow editor**
Full-page editor for creating/editing workflows. Vertical list of phase cards. Each card: name, model picker, prompt picker, after dropdown (auto-continue, quality checks, human approval, done), on-fail dropdown (retry, go back, stop). Deliberation toggle per phase. Save globally or per-project.

**4.6 — Quality check results component**
Inline display of quality check pass/fail with expandable output. Used in the workflow timeline between phases.

**4.7 — Gate approval component**
Inline approval UI: summary of phase output, approve/reject/correct buttons. Correction textarea that posts to guidance channel. Used in the workflow timeline at human-approval gates.

### Group 5: Daemon Mode

**5.1 — Daemon process management**
Separate Node.js process, not Electron child. PID file, flock-based singleton discovery. Socket binding. Process lifecycle (start, stop, restart). daemon.json for WebSocket port + auth token.

**5.2 — Socket transport**
Unix domain socket with JSON-RPC protocol. CLI client that connects to the socket. Maps socket methods to OrchestrationEngine commands.

**5.3 — Notification dispatch**
OS-native notifications via argv-based process spawning (no shell interpolation). Platform probing (terminal-notifier on macOS, notify-send on Linux). Fallback to in-app only. Non-fatal failures.

**5.4 — Electron lifecycle change**
App discovers running daemon on startup. Connects via WebSocket. On quit, daemon continues running. System tray icon for daemon status. requestSingleInstanceLock. setAsDefaultProtocolClient('forge').

**5.5 — Product identity**
~/.forge base directory, forge:// protocol, com.forgetools.forge app ID, FORGE_* env vars. State isolation from ~/.t3. Applied as a single rename pass.

## Task Dependencies

```
1.1 ─┬─ 1.3 ──── 2.1 ──── 2.2 ──── 2.3
     │                      │
1.2 ─┘            2.4 ─────┘
                  2.5 ──────┘
1.6 ──── 2.6 ──── 2.7
         
1.4 ──── 3.1 ──── 3.2
                   3.3
         3.4 (needs 3.1)

4.1 (needs 1.1)
4.2 (needs 1.2)
4.3 (needs 2.7, 1.5)
4.4 (needs 3.1)
4.5 (needs 1.2)
4.6 (needs 2.4)
4.7 (needs 2.6)

5.* (independent, can start anytime)
```

Groups 1-3 backend work can be parallelized across tasks that don't share dependencies. Group 4 frontend work starts once the server endpoints it needs are available. Group 5 is independent.
