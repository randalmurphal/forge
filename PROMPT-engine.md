# Engine Loop

## Housekeeping

```
Ignore: node_modules/, dist/, .turbo/, coverage/, *.log, bun.lock
```

## Prime Directive

This loop builds the workflow engine, channel system, and deliberation engine -- the runtime services that make forge's orchestration work. It consumes the types, tables, and command/event infrastructure from Loop 1 (foundation).

This loop builds:
- WorkflowRegistry -- loads and resolves workflow definitions
- WorkflowEngine -- phase execution logic, gate evaluation
- WorkflowReactor -- event-driven phase lifecycle management
- QualityCheckRunner -- executes project quality checks
- BootstrapReactor -- server-side worktree bootstrap
- ChannelService -- message persistence, cursor management
- DeliberationEngine -- multi-agent turn-taking, liveness, conclusion
- McpChannelServer -- Claude MCP tool hosting for channels
- Codex channel injection -- turn injection and PROPOSE_CONCLUSION parsing
- Built-in workflow YAML definitions and prompt templates

This loop does NOT build: UI components, daemon mode, socket API, Electron changes, or product identity changes.

Scope boundary: Everything in this loop is a server-side Effect Layer. No React, no Electron, no CLI.

## Authority Hierarchy

1. design/15-contracts.md (type authority)
2. design/04-workflow-engine.md (workflow behavior authority)
3. design/11-channel-tool-contract.md (channel behavior authority)
4. design/08-deliberation.md (deliberation pattern authority)
5. design/13-sessions-first-redesign.md (data model authority)
6. design/14-implementation-guide.md (codebase patterns)
7. This PROMPT

## Rules of Engagement

- Every new service follows Services/ + Layers/ pattern (interface in Services/, implementation in Layers/, tests co-located)
- New services go in apps/server/src/workflow/ and apps/server/src/channel/ directories
- New reactors go in apps/server/src/orchestration/Layers/ (alongside existing reactors)
- All services are Effect Layers, registered in the server composition root (apps/server/src/server.ts)
- Reactors subscribe to domain events via the existing PubSub pattern (see ProviderCommandReactor)
- Deterministic commandIds for all reactor-dispatched commands (see design/15-contracts.md section 13)
- WorkflowEngine dispatches commands to OrchestrationEngine -- it never writes to DB directly
- ChannelService writes channel_messages directly (hybrid table per State Ownership Matrix)
- MCP tools use @anthropic-ai/claude-agent-sdk's createSdkMcpServer and tool() helpers
- Quality checks run via child_process.exec (or Bun equivalent) with timeout
- Bootstrap runs in the session's worktree directory

PROHIBITED:
- Creating UI components or modifying React code
- Creating daemon/socket/CLI infrastructure
- Modifying the decider or projector (that was Loop 1)
- Guessing at Claude Agent SDK APIs -- read the actual SDK types
- Creating types that should be in contracts (those were Loop 1)

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

**WI-1: WorkflowRegistry service**
- Spec references: design/04-workflow-engine.md "Workflow Management", design/15-contracts.md section 2 (WorkflowDefinition type)
- Target files: NEW apps/server/src/workflow/Services/WorkflowRegistry.ts, NEW apps/server/src/workflow/Layers/WorkflowRegistry.ts + .test.ts, NEW apps/server/src/workflow/Errors.ts
- Deliver: Service that loads built-in workflow YAML files, upserts them into the workflows table (built_in=1) on startup, resolves workflows by name with built_in precedence (user workflows override built-in by name), provides queryAll/queryByName/queryById methods. Uses the ProjectionWorkflows repository from Loop 1.
- Tests: Load YAML workflow, verify materialization to DB. Resolve by name with precedence. Handle missing workflow.
- Done when: WorkflowRegistry loads, materializes, and resolves workflows

**WI-2: Built-in workflow YAML definitions**
- Spec references: design/04-workflow-engine.md built-in workflows section
- Target files: NEW apps/server/src/workflow/builtins/ directory with YAML files: implement.yaml, build-loop.yaml, interrogate.yaml, debate.yaml, explore.yaml, code-review.yaml, refine-prompt.yaml, plan-then-implement.yaml
- Deliver: YAML files matching the WorkflowDefinition schema. Each defines phases with agent definitions, gates, quality check references. Use the GateAfter/GateOnFail enums from contracts.
- Tests: All YAML files parse and validate against WorkflowDefinition schema
- Done when: 8 built-in workflow files exist and validate

**WI-3: Built-in prompt templates**
- Spec references: design/04-workflow-engine.md "Agent Output", design/15-contracts.md section 10 (PromptTemplate)
- Target files: NEW apps/server/src/workflow/prompts/ directory with YAML files for each role: implement.yaml, review.yaml, finalize.yaml, advocate.yaml, interrogator.yaml, scrutinizer.yaml, defender.yaml, connector.yaml, critic.yaml, evaluator.yaml, refiner.yaml, synthesize.yaml
- Deliver: Prompt templates with system prompt text using {{DESCRIPTION}}, {{PREVIOUS_OUTPUT}}, {{ITERATION_CONTEXT}} placeholders. Each prompt should be substantial and specific -- not generic "you are a reviewer" but detailed methodology (draw from HerdingLlamas prompt patterns in design/08-deliberation.md).
- Tests: All prompts parse, all referenced variables are in the known set
- Done when: Prompt templates exist for all built-in workflow agent roles

**WI-4: Prompt resolution**
- Spec references: design/15-contracts.md section 10 (resolution order)
- Target files: NEW apps/server/src/workflow/Services/PromptResolver.ts, Layers/PromptResolver.ts
- Deliver: Service that resolves a prompt template by name. Resolution order: project (.forge/prompts/) > user global (~/.forge/prompts/) > built-in (bundled). Returns the resolved PromptTemplate. Applies {{VAR}} substitution given a variables map.
- Tests: Resolution order precedence. Variable substitution. Missing prompt error. Missing variable left as-is.
- Done when: Prompts resolve with correct precedence and variable substitution works

**WI-5: QualityCheckRunner service**
- Spec references: design/15-contracts.md section 9 (ForgeProjectConfig), design/04-workflow-engine.md quality checks
- Target files: NEW apps/server/src/workflow/Services/QualityCheckRunner.ts, Layers/QualityCheckRunner.ts + .test.ts
- Deliver: Service that reads .forge/config.json from the project root, resolves quality check keys to commands, executes them via child_process in the session's worktree, captures stdout/stderr, enforces timeout, returns structured QualityCheckResult array. Non-blocking (runs as Effect).
- Tests: Execute a passing check. Execute a failing check. Timeout handling. Missing config file (graceful degradation). Missing check key.
- Done when: Quality checks execute, capture output, respect timeout

**WI-6: BootstrapReactor**
- Spec references: design/13-sessions-first-redesign.md worktree bootstrap section, design/14-implementation-guide.md task 2.5
- Target files: NEW apps/server/src/orchestration/Services/BootstrapReactor.ts, NEW apps/server/src/orchestration/Layers/BootstrapReactor.ts + .test.ts
- Deliver: Reactor that subscribes to thread.created events where workflow_id is set (or bootstrap is needed). Creates git worktree at ~/.forge/worktrees/{threadId}/. Reads bootstrap command from project config. Executes it. On success: dispatches thread.bootstrap-completed. On failure: dispatches thread.bootstrap-failed + creates bootstrap-failed interactive request. On timeout: same as failure. Uses deterministic commandId: bootstrap:{threadId}:{attempt}.
- Tests: Successful bootstrap creates worktree and dispatches completion. Failed bootstrap creates interactive request. Retry after failure. Idempotent on replay.
- Done when: Bootstrap reactor handles the full lifecycle

**WI-7: WorkflowEngine service**
- Spec references: design/04-workflow-engine.md phase runner, design/13-sessions-first-redesign.md execution model
- Target files: NEW apps/server/src/workflow/Services/WorkflowEngine.ts, Layers/WorkflowEngine.ts + .test.ts
- Deliver: Service with methods: startWorkflow(threadId, workflowDef), advancePhase(threadId), evaluateGate(threadId, phaseRunId, gateConfig). startWorkflow dispatches thread.start-phase for the first phase. advancePhase checks current phase status, evaluates gate, either advances to next phase or retries. evaluateGate runs quality checks (via QualityCheckRunner) or returns human-approval-needed. All operations dispatch commands to OrchestrationEngine -- no direct DB writes.
- Tests: Start workflow -> first phase starts. Phase completes -> gate evaluates -> next phase starts. Quality check failure -> retry. Human gate -> waits. Last phase completes -> workflow done.
- Done when: WorkflowEngine can drive a multi-phase workflow through its lifecycle

**WI-8: WorkflowReactor**
- Spec references: design/13-sessions-first-redesign.md execution model (reactor table)
- Target files: NEW apps/server/src/orchestration/Services/WorkflowReactor.ts, Layers/WorkflowReactor.ts + .test.ts
- Deliver: Reactor subscribing to domain events. On thread.created with workflowId: trigger bootstrap then start first phase. On thread.phase-completed: call WorkflowEngine.advancePhase. On thread.quality-checks-completed: evaluate gate. On request.resolved (gate approval): advance phase. On thread.bootstrap-completed: start first phase. On request.resolved (bootstrap retry): re-run bootstrap. Deterministic commandIds for all dispatches.
- Tests: Full workflow lifecycle through reactor events. Retry scenario. Bootstrap failure -> retry -> success. Idempotent replay.
- Done when: Reactor drives the complete workflow lifecycle from events

**WI-9: ChannelService**
- Spec references: design/11-channel-tool-contract.md, design/15-contracts.md section 3
- Target files: NEW apps/server/src/channel/Services/ChannelService.ts, Layers/ChannelService.ts + .test.ts, Errors.ts
- Deliver: Service with methods: createChannel(threadId, type, phaseRunId?), postMessage(channelId, fromType, fromId, fromRole?, content), getMessages(channelId, afterSequence?, limit?), getUnreadCount(channelId, sessionId), getCursor(channelId, sessionId), advanceCursor(channelId, sessionId, sequence). Uses channel repositories from Loop 1. Channel message posting dispatches channel.post-message command. Cursor management follows the canonical read-cursor invariant (cursor advances on post/conclude, NOT on read).
- Tests: Create channel. Post message (sequence increments). Get messages with pagination. Cursor tracks reads correctly. Unread count. Idempotent message posting.
- Done when: ChannelService handles full channel lifecycle

**WI-10: McpChannelServer**
- Spec references: design/11-channel-tool-contract.md Claude MCP integration, design/15-contracts.md section 7
- Target files: NEW apps/server/src/channel/Layers/McpChannelServer.ts + .test.ts
- Deliver: Function that creates an in-process MCP server using @anthropic-ai/claude-agent-sdk's createSdkMcpServer + tool(). Three tools: post_to_channel (posts message, returns messageId), read_channel (returns unread messages, does NOT advance cursor), propose_conclusion (records conclusion proposal, checks mutual agreement). Content-hash idempotency via tool_call_results table. Returns the MCP server config to be passed to query() mcpServers option.
- Tests: Tool execution produces correct channel operations. Idempotency on replay. Conclusion requires mutual agreement.
- Done when: MCP server hosts all 3 tools correctly

**WI-11: Codex channel injection**
- Spec references: design/11-channel-tool-contract.md Codex integration
- Target files: NEW apps/server/src/channel/Layers/CodexChannelInjection.ts + .test.ts
- Deliver: Functions for: formatChannelInjection(messages) -- formats channel messages as a synthetic user turn. parseCodexChannelResponse(response) -- extracts PROPOSE_CONCLUSION prefix. Injection state management (injectionState in deliberation state). Cursor advance at injection time.
- Tests: Format messages correctly. Parse PROPOSE_CONCLUSION. Parse normal response. Handle missing prefix.
- Done when: Codex injection formatting and parsing work

**WI-12: DeliberationEngine**
- Spec references: design/11-channel-tool-contract.md deliberation liveness, design/08-deliberation.md
- Target files: NEW apps/server/src/channel/Services/DeliberationEngine.ts, Layers/DeliberationEngine.ts + .test.ts
- Deliver: Service managing deliberation lifecycle. Ping-pong turn-taking (track currentSpeaker, advance on post). Liveness tracking (lastPostTimestamp, nudgeCount, stallTimeoutMs). Conclusion detection (both participants call propose_conclusion). Persists DeliberationState to phase_runs.deliberation_state_json (workflow) or sessions.deliberation_state_json (chat). Nudge mechanism (queued for Claude, injectable for Codex).
- Tests: Turn-taking alternation. Stall detection -> nudge. Mutual conclusion -> channel.concluded. Max turns -> force conclude. Recovery from persisted state.
- Done when: DeliberationEngine handles full deliberation lifecycle

**WI-13: ChannelReactor**
- Spec references: design/14-implementation-guide.md directory structure (orchestration/Layers/ChannelReactor.ts)
- Target files: NEW apps/server/src/orchestration/Services/ChannelReactor.ts, NEW apps/server/src/orchestration/Layers/ChannelReactor.ts + .test.ts
- Deliver: Reactor subscribing to channel events. On channel.message-posted: advance read cursors for posting session (per read-cursor invariant), notify other participants. On channel.conclusion-proposed: check if all participants have proposed, dispatch channel.concluded if so. On channel.concluded: notify workflow reactor (for workflow phases) or update session status (for chat sessions). Uses ChannelService for persistence operations.
- Tests: Message post advances cursor. Mutual conclusion triggers concluded event. Single conclusion does not conclude. Notification of other participants.
- Done when: Channel events trigger appropriate lifecycle actions

**WI-14: inputFrom resolution**
- Spec references: design/15-contracts.md section 11 (inputFrom grammar)
- Target files: NEW apps/server/src/workflow/Layers/InputResolver.ts + .test.ts
- Deliver: Function resolveInputFrom(reference, threadId) that: parses the reference string (phaseName.outputKey or phaseName.output:role), queries phase_outputs for the most recent completed phase_run matching phaseName, returns the content. Handles promoted-from.channel by following session_links. Returns error for missing references.
- Tests: Resolve simple reference. Resolve role-specific reference. Resolve promoted-from link. Missing phase -> error. Missing output -> error.
- Done when: inputFrom resolves all reference syntaxes correctly

**WI-15: Server composition -- register new services**
- Spec references: design/14-implementation-guide.md server composition pattern
- Target files: apps/server/src/server.ts
- Deliver: Register all new services in the Layer composition. WorkflowRegistryLive, WorkflowEngineLive, QualityCheckRunnerLive, ChannelServiceLive, DeliberationEngineLive, BootstrapReactorLive, WorkflowReactorLive. Follow the existing ReactorLayerLive + RuntimeServicesLive pattern.
- Tests: Server starts without errors with all new services registered
- Done when: All new services available in the running server

**WI-16: WebSocket RPC handlers for new methods**
- Spec references: design/15-contracts.md section 14 (socket API registry), existing apps/server/src/ws.ts patterns
- Target files: packages/contracts/src/rpc.ts (EXTEND), apps/server/src/ws.ts (EXTEND)
- Deliver: Add RPC method definitions for: workflow.list, workflow.get, workflow.create, workflow.update, channel.getMessages, channel.getChannel, phaseRun.list, phaseRun.get, phaseOutput.get, session.getChildren, session.getTranscript (if not already existing). Add corresponding handlers in ws.ts that delegate to the appropriate services (WorkflowRegistry, ChannelService, projection repositories). Also add push subscription RPCs for new channels: workflow.phase, channel.message, workflow.quality-check, workflow.bootstrap, workflow.gate.
- Tests: RPC calls return expected data. Push subscriptions deliver events.
- Done when: Frontend can fetch workflow/channel/phase data via RPC and receive push events

## Reminders

- This loop depends on Loop 1 (foundation) being complete. All contract types, migrations, repositories, decider/projector extensions must exist.
- Reactors subscribe to events and dispatch commands. They never write to the DB directly (except for hybrid tables documented in the State Ownership Matrix).
- The WorkflowEngine dispatches commands to OrchestrationEngine. The reactors listen for the resulting events and trigger the next step. This is the reactor pattern -- event -> react -> command -> event.
- Deterministic commandIds prevent duplicate processing on restart. Every reactor-dispatched command must use a deterministic ID derived from stable work item identity.
- The Claude Agent SDK's createSdkMcpServer is imported from "@anthropic-ai/claude-agent-sdk". The tool() helper creates MCP tool definitions with Zod schemas (the SDK uses Zod internally for MCP tools, even though the rest of the codebase uses @effect/schema).
- Quality checks and bootstrap run shell commands. Use child_process.exec (or Bun equivalent) with AbortSignal for timeout. Capture stdout and stderr separately.

## Review Phase

After all work items are complete, enter the review/fix cycle:

1. Check progress file for Known Issues -- fix ALL (highest severity first)
2. If no Known Issues, sweep one review category (see below)
3. Run quality gate, commit all fixes
4. Update progress file
5. Repeat

You NEVER write "Loop Complete" or "Loop Done" in the progress file. The human decides when the loop is done.

Review categories:
1. Spec Compliance -- services match design docs exactly
2. Error Handling -- every Effect error typed and propagated
3. Test Coverage -- reactor lifecycle, channel operations, quality check edge cases
4. Code Consistency -- same patterns as existing reactors
5. Dead Code -- all services registered in server.ts, all layers exported
6. Integration Wiring -- reactors actually subscribe to events, services actually use repositories
7. Security -- shell command injection prevention in quality checks/bootstrap
