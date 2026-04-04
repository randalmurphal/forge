# Workflow Engine

## What This Is

The workflow engine is what turns forge from a chat wrapper into an orchestration system. It manages how workflow sessions progress through phases, when to pause for human input, when to loop back for another iteration, and how to coordinate multiple agents.

This is where orc's concepts (phases, gates, quality checks), HerdingLlamas' patterns (deliberation, structured roles), and ralph-loops' methodology (build loops with review gates) converge into one system.

## Core Concepts

### Phases

A phase is a discrete step in a workflow. It has a type, a configuration, and a gate that determines what happens after it completes.

**Phase types:**

| Type | What happens | Example |
|------|-------------|---------|
| `single-agent` | One agent runs with a prompt | Implement a feature |
| `multi-agent` | Two+ agents, optionally with a shared channel | Deliberate on a plan; parallel independent review |
| `automated` | Run a script or quality check, no agent | Run tests, lint, typecheck |
| `human` | Wait for human input or approval | Review implementation |

### Gates

A gate sits between phases. It decides: continue, retry, pause for human, or fail.

```typescript
interface Gate {
  type: "auto" | "human" | "quality-check"

  // For auto gates: proceed if all conditions met
  autoConditions?: AutoCondition[]

  // For quality-check gates: run checks, continue if all pass
  qualityChecks?: QualityCheck[]

  // What to do on failure
  // Defaults: `auto` gates default onFailure: 'fail'. `quality-check` gates default onFailure: 'retry'. `human` gates default onFailure: 'pause'.
  onFailure: "retry" | "pause" | "fail"

  // If retry: which phase to loop back to
  retryFromPhase?: PhaseId
  maxRetries?: number
}

type AutoCondition =
  | { type: "session-completed" }     // all agents in this phase have finished their work
  | { type: "channel-concluded" }     // multi-agent reached agreement
  | { type: "script-passed"; script: string }

interface QualityCheckReference {
  check: string       // key into project quality check config
  required: boolean
}
```

### Loops

Some phases repeat. A build loop runs implement -> review -> fix -> review -> fix until quality is met or the human says stop.

```typescript
interface LoopConfig {
  maxIterations: number
  loopBackToPhase: PhaseId
  exitCondition: "gate-pass" | "human-approve" | "max-iterations"
  accumulateContext: boolean    // carry forward review findings across iterations
}
```

When `accumulateContext` is true, each iteration includes a summary of what previous iterations found and fixed. This is ralph-loops' "progress tracker" pattern - the agent doesn't start fresh each iteration, it builds on what was learned.

### Agent Output

Each phase's agent definition specifies what it produces. There are three output modes:

**Schema output** — for phases where an agent does work and needs to report structured results. The output schema is enforced by the provider (Claude/Codex structured output). The schema MUST include a `summary: string` field — this is what renders in the workflow timeline. Other fields are structured data available to downstream phases via `{{PREVIOUS_OUTPUT}}`.

Example agent definition with schema output:
```yaml
agent: implement
  prompt: implement-template
  output:
    type: schema
    schema:
      summary: string        # displayed in workflow timeline
      filesChanged: string[]
      testsAdded: number
      testsPassing: boolean
```

**Channel output** — for deliberation phases. The channel conversation IS the output. Renders in the workflow timeline as the back-and-forth between participants. No schema, no enforcement — the conversation is the deliverable.

**Conversation output** — default when no schema is specified. The output is the agent's final message or the conversation itself. Used for simple phases where structured data isn't needed.

The agent definition is:
- **Prompt** — system prompt template with engine-injected placeholders (`{{DESCRIPTION}}`, `{{PREVIOUS_OUTPUT}}`, `{{ITERATION_CONTEXT}}`)
- **Output** — schema (with enforced JSON shape), channel (deliberation), or conversation (default)
- **Model** — which provider/model (can be overridden per phase in the workflow)

Prompts are written directly. No custom variable system — if you want the prompt to mention TypeScript, write "TypeScript" in the prompt. The three built-in placeholders cover runtime context:
- `{{DESCRIPTION}}` — what the user typed when starting the session
- `{{PREVIOUS_OUTPUT}}` — the output from the previous phase (rendered summary for schema outputs, channel transcript for deliberation, last message for conversation)
- `{{ITERATION_CONTEXT}}` — on retry: what failed last time (quality check output, error messages, human corrections)

## Built-In Workflows

These ship with forge. Users can clone and customize them. The YAML format maps directly to what the workflow editor presents — each phase block is a card in the editor UI.

### Implement (simple)

Single agent, single phase, auto gate. What t3-code does today.

```yaml
name: implement
phases:
  - name: implement
    type: single-agent
    provider: auto                    # use default provider
    gate:
      type: auto
      autoConditions:
        - type: session-completed
```

### Build Loop

Ralph-loops pattern. Implement, review, fix, repeat.

```yaml
name: build-loop
phases:
  - name: implement
    type: single-agent
    provider: auto
    prompt: implement
    gate:
      type: quality-check
      qualityChecks:
        - check: test
          required: true
        - check: lint
          required: true
        - check: typecheck
          required: true
      onFailure: retry
      retryFromPhase: implement
      maxRetries: 5

  - name: review
    type: single-agent
    provider: auto
    prompt: review
    gate:
      type: human
      onFailure: retry
      retryFromPhase: implement

  - name: finalize
    type: automated
    gate:
      type: auto
    qualityChecks:
      - check: test
        required: true
```

**Note:** For `type: automated` phases, `qualityChecks` at phase level defines what the phase RUNS. The gate evaluates the results. For `type: quality-check` gates on other phase types, `qualityChecks` inside the gate is the check list.

The implement phase loops on quality check failure (tests, lint). When quality checks pass, the review phase runs. Human reviews and either approves (proceed to finalize) or sends correction (loop back to implement with context).

**Note:** Quality check commands are NOT hardcoded in workflows. Workflows reference checks by key (e.g., `test`, `lint`, `typecheck`). Project-level configuration maps keys to actual commands (e.g., `test` → `bun run test`). See [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) for the configuration format. The `npm` commands shown above are illustrative only.

### Deliberation

HerdingLlamas interrogate pattern. Two agents with asymmetric roles examine a question.

```yaml
name: deliberate
phases:
  - name: deliberate
    type: multi-agent
    agents:
      - role: advocate
        provider: claude
        prompt: advocate
      - role: interrogator
        provider: codex       # or claude with different config
        prompt: interrogator
    channel: deliberation
    gate:
      type: auto
      autoConditions:
        - type: channel-concluded
    maxTurns: 20

  - name: synthesize
    type: single-agent
    provider: auto
    prompt: synthesize-deliberation
    inputFrom: deliberate.channel     # feed channel transcript as input
    gate:
      type: human
```

### Plan-Then-Implement

Deliberate on the plan, then build-loop the implementation.

```yaml
name: plan-then-implement
phases:
  - name: plan-review
    type: multi-agent
    agents:
      - role: advocate
        provider: claude
        prompt: plan-advocate
      - role: interrogator
        provider: codex
        prompt: plan-interrogator
    channel: deliberation
    gate:
      type: human                    # human approves plan
      onFailure: retry

  - name: implement
    type: single-agent
    provider: auto
    prompt: implement
    inputFrom: plan-review.channel    # approved plan feeds implementation (plan-review is a deliberation phase producing channel output)
    gate:
      type: quality-check
      qualityChecks:
        - check: test
          required: true
      onFailure: retry
      retryFromPhase: implement
      maxRetries: 5

  - name: code-review
    type: multi-agent
    agents:
      - role: scrutinizer
        provider: claude
        prompt: code-scrutinizer
      - role: defender
        provider: codex
        prompt: code-defender
    channel: deliberation
    gate:
      type: human
```

### Code Review

HerdingLlamas code-review pattern.

```yaml
name: code-review
phases:
  - name: independent-review
    type: multi-agent
    config:
      sandboxMode: read-only
    agents:
      - role: scrutinizer
        provider: claude
        prompt: code-scrutinizer
      - role: defender
        provider: codex
        prompt: code-defender
    gate:
      type: auto
      autoConditions:
        - type: session-completed

  - name: cross-examine
    type: multi-agent
    agents:
      - role: scrutinizer
        provider: claude
        prompt: cross-examine-scrutinizer
      - role: defender
        provider: codex
        prompt: cross-examine-defender
    channel: deliberation
    inputFrom:
      SCRUTINIZER_FINDINGS: independent-review.output:scrutinizer
      DEFENDER_FINDINGS: independent-review.output:defender
    gate:
      type: auto
      autoConditions:
        - type: channel-concluded
    maxTurns: 20

  - name: present-findings
    type: human
    inputFrom:
      REVIEW_FINDINGS: cross-examine.channel
    gate:
      type: human
```

### Per-Phase Configuration

Workflow phases can override execution parameters. These allow the same workflow template to behave differently based on session complexity.

```yaml
phases:
  - name: implement
    type: single-agent
    config:
      maxTurns: 150          # default varies by workflow
      checkpointInterval: 5   # checkpoint every N turns (0 = only at completion)
      turnTimeoutMs: 600000   # 10 minutes per turn
      sessionPersistence: true # persist session for resume
    gate:
      type: quality-check
```

These map to orc's weight-based executor configs. v2: automatic weight detection selects config presets (trivial: 50 turns, small: 100, medium: 150, large: 250).

The `SessionCommands` union (see doc 13) includes the phase and child session lifecycle commands that the workflow engine dispatches.

## Workflow Management

Workflows are reusable configurations. A workflow is just an ordered list of phases — what to do, in what order, with what happens between each step.

### Storage

- **Built-in workflows** — ship with forge as YAML files bundled in the app. Materialized into the database on startup. Cannot be modified directly but can be cloned.
- **Global user workflows** — created by the user, stored in the workflows table with built_in = 0. Available across all projects.
- **Project workflows** — stored as YAML files in .forge/workflows/ within a project. Available only for that project. Take precedence over global workflows with the same name.

On startup, the engine reads all YAML sources and upserts into the workflows table. The table is the sole runtime source. YAML files are the version-controlled source for built-in and project workflows.

### Creating Workflows

The workflow editor (see doc 05) provides a list-based UI for defining phases. Each phase specifies:
- **What runs:** single agent with a model/prompt, or deliberation with two models/prompts and roles
- **What happens after:** auto-continue, quality checks, human approval, or done
- **What happens on failure:** retry, go back to an earlier phase, or stop
- **Configuration:** max retries, max turns (for deliberation), quality check selection

### Running Workflows

When creating a session, the user picks a workflow from a dropdown. The workflow determines everything — how many phases, what agents run, what checks execute, when to pause for human input. The user provides a description/prompt and the session starts.

The session's worktree and branch follow t3-code's existing patterns (see doc 13 for worktree lifecycle). Each phase spawns child sessions that work in the session's worktree.

### Workflow Completion and Git

Git operations happen after the workflow completes, not as a workflow phase. When a session (workflow or agent) has code changes:

- Changes are in the session's worktree on its branch
- The user can commit, push, create a PR — same controls as t3-code
- Workflows can configure auto-completion actions:

```yaml
on_completion:
  auto_commit: true
  auto_push: true
  create_pr: true           # AI-generated title/description
```

These run after the last phase completes successfully. If not configured, the user manually commits/pushes/creates PRs using the same UI controls t3-code provides.

The "finalize" phase in built-in workflows like build-loop is for final quality checks, not git operations. Git happens after the workflow engine is done.

## Engine Implementation

### Phase Runner

The phase runner is the core loop. For each phase in the workflow session:

```
1. Check preconditions (previous phase completed, dependencies met)
2. Create PhaseRun record
3. Based on phase type:
   a. single-agent: spawn one child session, wait for completion
   b. multi-agent:
      1. Spawn N child sessions (all-or-nothing admission per session admission control)
      2. If phase has channel config:
         a. Create channel, attach channel tools (Claude: MCP, Codex: injection)
         b. Create DeliberationState, orchestrate turn-taking
         c. Wait for conclusion or max turns
         d. Write phase_output: 'channel' (formatted transcript)
      3. If phase has NO channel config (parallel independent):
         a. Start all child sessions with their prompts (no channel tools)
         b. Default sandboxMode to 'read-only' unless explicitly overridden
         c. Wait for ALL child sessions to complete
         d. Write phase_output per role: 'output:{role}' = final assistant message
   c. automated: run quality checks or scripts
   d. human: emit notification, wait for human action
4. Evaluate gate:
   a. auto: check conditions, continue or retry
   b. human: pause, emit notification, wait for human
   c. quality-check: run checks, continue or retry
5. On continue: advance to next phase
6. On retry: loop back to specified phase with accumulated context
7. On fail: mark session as failed, notify human
```

### Multi-Agent Orchestration

For deliberation phases, the engine manages turn-taking:

```
1. Create shared deliberation channel
2. Spawn child session A with role prompt + channel tools
3. Spawn child session B with role prompt + channel tools
4. Orchestration loop:
   a. Wait for either child session to post to channel
   b. Notify other child session of new message
   c. Check for conclusion signals (both child sessions agree to conclude)
   d. Check for max turns
   e. Check for human intervention
5. On conclusion: collect channel transcript for synthesis
```

The engine doesn't inject messages into child session context directly for deliberation. Instead, child sessions have tools to read/write the channel (like HerdingLlamas). This gives the agent deliberate control over what it posts.

For corrections (guidance channel), the engine DOES inject messages. The human's correction appears as high-priority context on the child session's next turn. The agent doesn't choose to read it - it's forced into their context.

Quality checks run in the session's worktree. The `inputFrom` directive resolves within the session's phase runs.

### Context Accumulation

Across loop iterations, the engine builds a context summary:

```typescript
interface IterationContext {
  iteration: number
  previousFindings: string[]       // what review found last time
  previousCorrections: string[]    // what human corrected
  qualityCheckResults: QualityCheckResult[]  // what passed/failed
  accumulatedPatterns: string[]    // recurring issues
}
```

This prevents the "groundhog day" problem where an agent makes the same mistake every iteration because it doesn't know what was tried before.

## Variable Resolution

Phase prompts use `{{VARIABLE_NAME}}` placeholders that the engine resolves before passing to the provider.

### Source Types (v1)

| Source | Description | Example |
|--------|------------|---------|
| `static` | Hardcoded value in workflow definition | `{{MAX_RETRIES}}` = "3" |
| `env` | Environment variable | `{{NODE_ENV}}` from process.env |
| `builtin` | Engine-computed from session/phase/agent context | `{{SESSION_DESCRIPTION}}`, `{{ITERATION}}` |
| `phase_output` | Resolved from a previous phase's output via `inputFrom` | `{{SPEC_CONTENT}}` from plan-review.synthesis |

v2 extension points: `script` (execute shell command), `api` (HTTP endpoint), `prompt_fragment` (reusable prompt snippets from ~/.forge/prompts/fragments/).

### Built-In Variables

| Variable | Source | Value |
|----------|--------|-------|
| `SESSION_ID` | session | Session identifier |
| `SESSION_TITLE` | session | Session title |
| `SESSION_DESCRIPTION` | session | Session description (from metadata) |
| `PROJECT_PATH` | session | Project workspace root |
| `WORKING_DIR` | session | Worktree path (or project root if no worktree) |
| `BRANCH` | session | Current git branch |
| `PHASE_NAME` | phase_run | Current phase name |
| `PHASE_TYPE` | phase_run | Current phase type |
| `ITERATION` | phase_run | Current loop iteration (1-based) |
| `MAX_ITERATIONS` | workflow phase config | Maximum loop iterations |
| `RETRY_REASON` | gate_result | Why the previous iteration failed |
| `RETRY_FEEDBACK` | gate_result + corrections | Gate failure details + human corrections |
| `QUALITY_CHECK_RESULTS` | gate_result | Formatted quality check output from previous gate |
| `ITERATION_CONTEXT` | accumulated | Built from previous phase_runs' outputs and corrections |
| `PREVIOUS_FINDINGS` | phase_output | Resolved inputFrom content |
| `CORRECTION_HISTORY` | guidance channel | All corrections posted by human for this session |

### Resolution Order

1. Built-in variables (always available, computed from current context)
2. Workflow-defined static variables
3. Phase output variables (resolved via inputFrom)
4. Environment variables

Later sources override earlier ones if names collide. Missing required variables cause phase start failure. Missing optional variables resolve to empty string.

### inputFrom-to-Variable Binding

The `inputFrom` directive in workflow YAML resolves a phase output and binds it to a named variable:

```yaml
phases:
  - name: implement
    inputFrom:
      SPEC_CONTENT: plan-review.synthesis
      REVIEW_FINDINGS: code-review.channel
```

At phase start, the engine resolves each inputFrom reference (via `resolveInputFrom` in doc 13) and makes the content available as `{{SPEC_CONTENT}}` and `{{REVIEW_FINDINGS}}` in the phase prompt template.

When `inputFrom` is a simple string (not a map), the resolved content binds to the variable `{{INPUT}}`. Example: `inputFrom: deliberate.channel` makes the channel transcript available as `{{INPUT}}` in the phase prompt.

## Challenges

### Channel tool design
Child sessions need tools to interact with channels. These tools must be:
- Reliable (agents actually use them, not just ignore them)
- Injected into the child session's tool set dynamically (not all sessions need channel tools)
- Intercepted by the backend (tool calls go to forge, not to the filesystem)

For Claude Agent SDK: custom tools are supported. The SDK allows defining tools that the backend handles.
For Codex: tool interception is less straightforward. May need to use file-based communication (agent writes to a known path, forge watches it) or Codex's API for injecting tools.

### Turn-taking coordination for multi-agent
Two child sessions running simultaneously can create race conditions. Who goes first? What if both post at the same time? Options:
1. **Strict turn-taking**: Agent A posts, waits. Agent B reads, posts, waits. Ping-pong.
2. **Event-driven**: Either agent can post anytime. The other gets notified of new messages.
3. **Phase-based**: Both research independently (no channel), then cross-examine (channel opens).

HerdingLlamas uses event-driven with nudges. This works but requires careful timing. Strict turn-taking is simpler and may be better for a v1.

### Quality check reliability
Quality checks run shell commands. These can:
- Take a long time (full test suite)
- Be flaky (intermittent failures)
- Require specific environment (node version, dependencies)
- Fail for reasons unrelated to the agent's work

Need to handle: timeouts, retries for flaky tests, clear error reporting that distinguishes "your code is broken" from "the test environment is broken."

### Workflow definition UX
Users will want to create custom workflows. The YAML format is powerful but error-prone. Options:
- YAML files with validation (developer-friendly, version-controllable)
- UI form builder (accessible but limited)
- Template customization (pick a built-in workflow, adjust parameters)

Start with built-in workflows + template customization. Add YAML for power users. UI builder is a stretch goal.

### Phase prompt management
Each phase needs a prompt. Where do prompts live?
- Embedded in workflow YAML (simple, self-contained)
- Separate prompt files referenced by workflow (reusable, easier to edit)
- Generated dynamically from session context (most flexible, hardest to debug)

Probably: separate files for built-in workflows, embedded for user-created workflows, with variable substitution for session-specific context.

## Open Questions

1. **Worktree bootstrap handles dependency installation.** (RESOLVED) Every workflow session's worktree runs a bootstrap step (implicit phase 0) before any child sessions spawn. The project's `runOnWorktreeCreate` script (e.g., `npm install`) executes server-side. Bootstrap failure creates a `needs-attention` interactive request. Quality checks run in the bootstrapped worktree. See [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) for the bootstrap lifecycle.

2. **Can workflows be modified mid-execution?** If a session is in the implement phase and the user decides to add a review phase, can they? Or must they restart the workflow? Probably "no" for v1, but worth designing for.

3. **Phase outputs are first-class records.** (RESOLVED) The `phase_outputs` table stores explicit output records written at phase completion. Synthesis phases write the final assistant message. Deliberation phases write the formatted channel transcript. The `inputFrom` directive in workflow YAML resolves against this table deterministically. See [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) for the table definition and resolution logic.

4. **Should the engine support parallel WORKFLOW phases (different phases running concurrently across different sessions)?** Probably not v1. Note: parallel child sessions within a single multi-agent phase ARE supported — this is how deliberation and independent review work. Admission control counts active leaf sessions (sessions with provider != NULL).

## Related Documents

- [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) - Sessions-first data model
- [06-agent-integration.md](./06-agent-integration.md) - How agents interact with forge
- [08-deliberation.md](./08-deliberation.md) - Multi-agent patterns in detail
