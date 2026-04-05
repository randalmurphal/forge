# Foundation Loop

## Housekeeping

```
Ignore: node_modules/, dist/, .turbo/, coverage/, *.log, bun.lock
```

## Prime Directive

This loop builds the data foundation for forge: new database tables, @effect/schema contract types, and extensions to the orchestration decider/projector for workflow, channel, and child thread commands/events.

This loop does NOT build: workflow execution logic, channel services, MCP integration, UI components, daemon mode, or any runtime behavior. It creates the types, tables, and command/event handling that later loops depend on.

Scope boundary: If it requires starting a provider session, running a shell command, or rendering UI -- it's out of scope for this loop.

## Authority Hierarchy

1. design/15-contracts.md (type authority -- exact schemas, commands, events)
2. design/13-sessions-first-redesign.md (data model authority)
3. design/14-implementation-guide.md (codebase patterns authority)
4. This PROMPT (work items and rules)

## Rules of Engagement

- Follow existing Effect.js patterns exactly (Services/ + Layers/, Effect.gen, ServiceMap.Service)
- Follow existing @effect/schema patterns for type definitions (see baseSchemas.ts, orchestration.ts)
- Follow existing migration patterns (see persistence/Migrations.ts, numbered migrations)
- New commands are added to the existing decider.ts switch statement before the default case
- New events are added to the existing projector.ts switch statement before the default case
- New types go in NEW files (packages/contracts/src/workflow.ts, channel.ts) to avoid bloating orchestration.ts
- New command/event type unions extend the existing unions in orchestration.ts
- All repository interfaces go in persistence/Services/, implementations in persistence/Layers/
- Tests co-located with implementations
- NEVER modify existing command/event handlers -- only ADD new cases
- NEVER delete existing migrations -- only ADD new numbered ones
- NEVER guess at Effect.js APIs -- read existing code for patterns

PROHIBITED:

- Creating runtime services (WorkflowEngine, ChannelService, etc.) -- that's Loop 2
- Creating UI components -- that's Loop 3
- Modifying existing t3-code behavior in any way
- Using async/await instead of Effect patterns
- Defining types that aren't in design/15-contracts.md

## Environment

- Language: TypeScript
- Runtime: Bun / Node.js
- Framework: Effect.js 4.0.0-beta.43
- Schema: @effect/schema (NOT Zod)
- Test: Vitest
- Working directory: /Users/randy/repos/forge

## Quality Gate

```bash
bun typecheck && bun run test
```

Both must pass. Every commit must pass the quality gate. If typecheck fails, fix the types. If tests fail, fix the tests or the code. NEVER skip the quality gate.

## Workflow Per Iteration

1. Read the progress file for any Known Issues -- fix those FIRST (highest severity)
2. Pick the next uncompleted work item
3. Read the referenced design doc sections
4. Read the relevant existing codebase files to understand patterns
5. Implement the work item following existing patterns exactly
6. Write tests
7. Run quality gate
8. Commit with descriptive message
9. Update progress file (mark item complete, log iteration)
10. Repeat

## Work Items

**WI-1: Branded identifier types**

- Spec references: design/15-contracts.md section 1
- Target files: packages/contracts/src/baseSchemas.ts
- Deliver: Add WorkflowId, WorkflowPhaseId, PhaseRunId, ChannelId, ChannelMessageId, LinkId, InteractiveRequestId using the existing makeEntityId helper
- Tests: Verify each type creates valid branded values and rejects empty strings
- Done when: All 7 new branded types exist and typecheck passes

**WI-2: Workflow contract types**

- Spec references: design/15-contracts.md section 2
- Target files: NEW packages/contracts/src/workflow.ts
- Deliver: All workflow types -- AgentOutputMode, PhaseType, GateAfter, GateOnFail, PhaseRunStatus, QualityCheckReference, QualityCheckResult, PhaseGate, GateResult, AgentOutputConfig (discriminated union for schema/channel/conversation), AgentDefinition, DeliberationConfig, InputFromReference, WorkflowPhase, WorkflowDefinition, OnCompletionConfig, ForgeProjectConfig (quality check + bootstrap config). Export all new types from packages/contracts/src/index.ts.
- Tests: Schema encoding/decoding tests for key types (WorkflowPhase, WorkflowDefinition, AgentOutputConfig union). Verify discriminated union dispatch works.
- Done when: All types from section 2 of contracts doc exist, encode/decode correctly, exported from index

**WI-3: Channel contract types**

- Spec references: design/15-contracts.md section 3
- Target files: NEW packages/contracts/src/channel.ts
- Deliver: ChannelType, ChannelStatus, ChannelMessage, Channel, InjectionState, DeliberationState. Export all new types from packages/contracts/src/index.ts.
- Tests: Schema encoding/decoding tests for ChannelMessage, DeliberationState
- Done when: All channel types exist, typecheck, exported from index

**WI-4: Interactive request contract types**

- Spec references: design/15-contracts.md section 4
- Target files: NEW packages/contracts/src/interactiveRequest.ts (or extend orchestration.ts)
- Deliver: InteractiveRequestType, InteractiveRequestStatus, all 5 payload discriminated unions (approval, user-input, gate, bootstrap-failed, correction-needed), all 5 resolution discriminated unions, InteractiveRequest entity type. Export all new types from packages/contracts/src/index.ts.
- Tests: Verify discriminated union dispatch for each request type
- Done when: All interactive request types exist, discriminated unions work, exported from index

**WI-5: New command types**

- Spec references: design/15-contracts.md section 5
- Target files: packages/contracts/src/orchestration.ts (extend existing unions)
- Deliver: All new command schemas -- thread.start-phase, thread.complete-phase, thread.fail-phase, thread.skip-phase, thread.start-quality-checks, thread.complete-quality-checks, thread.correct, thread.bootstrap-started/completed/failed/skipped, thread.add-link, thread.promote, thread.add-dependency, thread.remove-dependency, channel.create, channel.post-message, channel.conclude, channel.close, request.open, request.resolve, request.mark-stale. Add to ForgeCommand union. Wire into the existing DispatchableClientOrchestrationCommand or InternalOrchestrationCommand unions as appropriate.
- Tests: Verify each command schema encodes/decodes. Verify the ForgeCommand union accepts all command types.
- Done when: All commands from section 5 of contracts doc exist in the command union

**WI-6: New event types**

- Spec references: design/15-contracts.md section 6
- Target files: packages/contracts/src/orchestration.ts (extend existing event types)
- Deliver: All new event schemas with typed payloads -- thread.phase-started, thread.phase-completed, thread.phase-failed, thread.phase-skipped, thread.quality-checks-started, thread.quality-checks-completed, thread.correction-queued, thread.correction-delivered, thread.bootstrap-\*, thread.link-added, thread.link-removed, thread.promoted, thread.dependency-added, thread.dependency-removed, thread.dependencies-satisfied, channel.created, channel.message-posted, channel.conclusion-proposed, channel.concluded, channel.closed, request.opened, request.resolved, request.stale, thread.phase-output-edited, thread.synthesis-completed. Add to ForgeEvent union.
- Tests: Verify each event schema encodes/decodes with payloads
- Done when: All events from section 6 exist in the event union

**WI-7: Database migrations -- workflow and phase tables**

- Spec references: design/13-sessions-first-redesign.md SQL schemas, design/14-implementation-guide.md migration pattern
- Target files: NEW apps/server/src/persistence/Migrations/020_WorkflowTables.ts, register in Migrations.ts
- Deliver: CREATE TABLE workflows (id, name, description, phases_json, built_in, created_at, updated_at) with UNIQUE index on (name, built_in). CREATE TABLE phase_runs (id, thread_id, workflow_id, phase_id, phase_name, phase_type, sandbox_mode, iteration, status, gate_result_json, quality_checks_json, deliberation_state_json, started_at, completed_at) with indexes. Follow existing migration Effect.gen pattern.
- Tests: Migration applies without error on clean DB
- Done when: Migration registered, tables created on startup

**WI-8: Database migrations -- channel tables**

- Spec references: design/13-sessions-first-redesign.md channel schemas
- Target files: NEW apps/server/src/persistence/Migrations/021_ChannelTables.ts, register in Migrations.ts
- Deliver: CREATE TABLE channels (id, thread_id, phase_run_id, type, status, created_at, updated_at). CREATE TABLE channel_messages (id, channel_id, sequence, from_type, from_id, from_role, content, metadata_json, created_at, deleted_at) with UNIQUE on (channel_id, sequence). CREATE TABLE channel_reads (channel_id, session_id, last_read_sequence, updated_at) with composite PK. CREATE TABLE tool_call_results. All with proper indexes.
- Tests: Migration applies without error
- Done when: Migration registered, tables created

**WI-9: Database migrations -- thread extensions**

- Spec references: design/13-sessions-first-redesign.md session/thread schema extensions
- Target files: NEW apps/server/src/persistence/Migrations/022_ThreadExtensions.ts, register in Migrations.ts
- Deliver: ALTER TABLE on thread projection tables to add: parent_thread_id, phase_run_id, workflow_id, workflow_snapshot_json, current_phase_id, pattern_id, role, deliberation_state_json, bootstrap_status, completed_at, transcript_archived. Add indexes for parent_thread_id, phase_run_id.
- Tests: Migration applies, existing threads still load correctly
- Done when: Existing thread functionality unbroken, new columns exist

**WI-10: Database migrations -- phase outputs and other tables**

- Spec references: design/13-sessions-first-redesign.md
- Target files: NEW apps/server/src/persistence/Migrations/023_PhaseOutputTables.ts, register in Migrations.ts
- Deliver: CREATE TABLE phase_outputs (phase_run_id, output_key, content, source_type, source_id, metadata_json, created_at, updated_at) with composite PK. CREATE TABLE session_links. CREATE TABLE session_dependencies. CREATE TABLE session_synthesis. CREATE TABLE phase_run_provenance. CREATE TABLE phase_run_outcomes. CREATE TABLE project_knowledge. CREATE TABLE attention_signals.
- Tests: Migration applies without error
- Done when: All tables from doc 13 exist

**WI-11: Projection repositories -- workflows**

- Spec references: design/14-implementation-guide.md persistence patterns
- Target files: NEW apps/server/src/persistence/Services/ProjectionWorkflows.ts, NEW apps/server/src/persistence/Layers/ProjectionWorkflows.ts
- Deliver: Interface with queryAll, queryById, queryByName, upsert, delete. Implementation using existing SqlClient pattern.
- Tests: CRUD operations work against test DB
- Done when: Repository can store and retrieve workflows

**WI-12: Projection repositories -- phase runs**

- Target files: NEW apps/server/src/persistence/Services/ProjectionPhaseRuns.ts, NEW apps/server/src/persistence/Layers/ProjectionPhaseRuns.ts
- Deliver: Interface with queryByThreadId, queryById, upsert, updateStatus. Implementation.
- Tests: CRUD operations
- Done when: Repository works

**WI-13: Projection repositories -- channels and messages**

- Target files: NEW apps/server/src/persistence/Services/ProjectionChannels.ts + ProjectionChannelMessages.ts, apps/server/src/persistence/Layers/
- Deliver: Channel repository (queryByThreadId, create, updateStatus). Message repository (queryByChannelId with pagination, insert, getUnreadCount). Channel reads repository (getCursor, updateCursor).
- Tests: CRUD operations, pagination
- Done when: All channel repositories work

**WI-14: Projection repositories -- phase outputs**

- Target files: NEW apps/server/src/persistence/Services/ProjectionPhaseOutputs.ts, apps/server/src/persistence/Layers/
- Deliver: Interface with queryByPhaseRunId, queryByKey, upsert. Implementation.
- Tests: CRUD
- Done when: Repository works

**WI-15: Projection repository -- interactive requests**

- Target files: NEW apps/server/src/persistence/Services/ProjectionInteractiveRequests.ts, NEW apps/server/src/persistence/Layers/ProjectionInteractiveRequests.ts
- Deliver: Interface with queryByThreadId, queryById, queryPending, upsert, updateStatus, markStale. Implementation using SqlClient pattern.
- Tests: CRUD operations, query pending requests, mark stale
- Done when: Repository can store and retrieve interactive requests

**WI-16: Decider extensions -- workflow commands**

- Spec references: design/15-contracts.md section 5 commands, existing decider.ts patterns
- Target files: apps/server/src/orchestration/decider.ts
- Deliver: Add case handlers for all thread._ workflow commands (start-phase, complete-phase, fail-phase, skip-phase, start-quality-checks, complete-quality-checks, correct, bootstrap-_, add-link, promote, add-dependency, remove-dependency). Each validates invariants against read model (e.g., thread must exist, phase must be in valid state) and returns typed events. Add new commandInvariants helpers as needed.
- Tests: Unit tests for each command -- valid input produces correct events, invalid input returns appropriate errors
- Done when: All workflow commands handled in decider, tests pass

**WI-17: Decider extensions -- channel commands**

- Target files: apps/server/src/orchestration/decider.ts
- Deliver: Add case handlers for channel.create, channel.post-message, channel.conclude, channel.close. Validate: channel must exist for message/conclude/close, thread must exist for create.
- Tests: Unit tests for each channel command
- Done when: All channel commands handled

**WI-18: Decider extensions -- interactive request commands**

- Target files: apps/server/src/orchestration/decider.ts
- Deliver: Add case handlers for request.open, request.resolve, request.mark-stale.
- Tests: Unit tests
- Done when: All request commands handled

**WI-19: Projector extensions -- workflow events**

- Spec references: existing projector.ts patterns
- Target files: apps/server/src/orchestration/projector.ts
- Deliver: Add case handlers for all thread.phase-_, thread.quality-checks-_, thread.bootstrap-_, thread.correction-_, thread.link-_, thread.dependency-_, thread.promoted events. Update the in-memory read model with phase run state, thread status changes, link/dependency tracking.
- Tests: Unit tests -- given read model + event, verify correct state changes
- Done when: All workflow events projected correctly

**WI-20: Projector extensions -- channel events**

- Target files: apps/server/src/orchestration/projector.ts
- Deliver: Add case handlers for channel.created, channel.message-posted, channel.conclusion-proposed, channel.concluded, channel.closed. Update read model with channel state.
- Tests: Unit tests for each event
- Done when: All channel events projected

**WI-21: Projector extensions -- request events**

- Target files: apps/server/src/orchestration/projector.ts
- Deliver: Add handlers for request.opened, request.resolved, request.stale.
- Tests: Unit tests
- Done when: All request events projected

**WI-22: Read model extensions**

- Spec references: design/15-contracts.md section 8
- Target files: packages/contracts/src/orchestration.ts (OrchestrationReadModel), apps/server/src/orchestration/projector.ts
- Deliver: Extend OrchestrationReadModel with: workflows array, phaseRuns array, channels array, pendingRequests array. Extend OrchestrationThread with: parentThreadId, phaseRunId, workflowId, currentPhaseId, patternId, role, childThreadIds, bootstrapStatus. Initialize new arrays in projector's initial state.
- Tests: Verify read model builds correctly from event replay including new fields
- Done when: Read model includes all new fields, projection works end-to-end

**WI-23: ProjectionPipeline extensions**

- Spec references: existing ProjectionPipeline.ts patterns
- Target files: apps/server/src/orchestration/Layers/ProjectionPipeline.ts
- Deliver: Add new projector definitions for phase_runs, channels, channel_messages, phase_outputs tables. Register new projection repositories. Add projector names to ORCHESTRATION_PROJECTOR_NAMES constant.
- Tests: New projectors apply events to correct tables
- Done when: All new projection tables populated by the pipeline

## Reminders

- The existing thread aggregate (commands, events, projector, read model) must continue working perfectly. All existing tests must pass.
- Effect.js patterns: yield\* for dependency injection, Effect.gen for generators, Layer.effect for service registration, ServiceMap.Service for interfaces.
- Migration numbering starts at 020 (the existing codebase has migrations through 019).
- New contract types go in NEW files to avoid bloating orchestration.ts, but the command/event unions in orchestration.ts must be extended to include the new types.
- The decider is pure -- no IO, no side effects. The projector is pure -- no IO, no side effects. Only return events from decider, only return updated state from projector.
- Read existing code before writing new code. Match patterns exactly.

## Review Phase

After all work items are complete, enter the review/fix cycle:

1. Check progress file for Known Issues -- fix ALL (highest severity first)
2. If no Known Issues, sweep one review category (see below)
3. Run quality gate, commit all fixes
4. Update progress file
5. Repeat

You NEVER write "Loop Complete" or "Loop Done" in the progress file. The human decides when the loop is done.

Review categories:

1. Spec Compliance -- every type, command, event matches design/15-contracts.md exactly
2. Error Handling -- every Effect error path is typed and handled
3. Test Coverage -- all commands produce correct events, all events project correctly
4. Code Consistency -- same patterns as existing codebase (Effect.gen, ServiceMap, Layer)
5. Dead Code -- no unused types, no unreferenced schemas, no orphaned migrations
6. Integration Wiring -- all new projectors registered in ProjectionPipeline, all new types exported from contracts index
7. Security -- no SQL injection in migration DDL, no unsafe type casts
