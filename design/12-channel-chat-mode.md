# Deliberation Workflows

## What This Is

Deliberation patterns — debate, interrogate, explore, code-review, refine-prompt — are workflows. They show up in the workflow picker alongside build-loop and plan-then-implement. The user clicks "+ New session," picks "interrogate" from the workflow dropdown, provides a question, and two agents start deliberating in a channel view. No separate mode, no separate entry point.

This is HerdingLlamas rebuilt into forge as first-class workflows. The terminal TUI becomes a native view in the app. Deliberation sessions are first-class — no `__scratch__` workflow, no synthetic phase_runs.

## Why This Matters Architecturally

Deliberation workflows are first-class, not a workaround layered on top of the workflow model:

1. **Deliberation sessions are top-level entities.** A session with a deliberation workflow (internal type: "chat") directly has: a pattern, two child sessions, a deliberation channel, and deliberation state. No indirection, no synthetic phase_runs.
2. **Deliberation sessions can be promoted.** If a deliberation produces an actionable plan, you can "promote" the findings into a new session with a different workflow via a `promoted-from` session_link.
3. **The channel view is reusable.** The same component renders deliberation in both contexts — embedded in a workflow session's multi-agent phase or standalone in a deliberation session.

## User Flow

```
1. User clicks "+ New session"
2. Normal session creation flow:
   - Title/description: text input (the question, plan, or context)
   - Workflow picker: user selects "interrogate", "debate", "explore", "code-review",
     or "refine-prompt" from the dropdown (alongside build-loop, plan-then-implement, etc.)
   - Model picker: provider selection (claude vs codex, or claude vs claude)
   - Optional: working directory for code-aware patterns, max turns override
3. Session created (internal type: "chat", pattern_id set from workflow selection)
4. Two child sessions spawn directly under the session (no phase_run needed)
5. Channel view shows the conversation (identical to the deliberation view in workspace mode)
6. User can:
   - Watch passively
   - Intervene (post to the channel, both agents see it)
   - End early
   - When done: dismiss, or "Create session from this" to promote findings
```

## Data Model

A deliberation session uses the sessions-first model directly:

```typescript
// When user picks a deliberation workflow (e.g. "interrogate"):
const session = await engine.dispatch({
  type: "session.create",
  sessionId: newId(),
  projectId: currentProject.id,
  type: "chat", // internal type, determined by the workflow
  title: `Deliberation: ${question.substring(0, 60)}`,
  status: "running",
  patternId: "interrogate", // or debate, explore, etc.
});
// Engine then creates two child sessions directly under the session
// (no phase_run — child sessions belong to the session for chat type),
// creates the deliberation channel, and starts the child sessions.
```

The session schema from doc 13 directly supports this:

- `session.type = "chat"` (internal, set automatically when a deliberation workflow is selected)
- `session.pattern_id` identifies the deliberation pattern
- Two child sessions belong directly to the parent session (`parent_session_id` set, `phase_run_id` is NULL for deliberation sessions)
- One deliberation channel belongs to the session

No synthetic workflow, no synthetic phase_run, no `__scratch__` anything.

### Promotion Lifecycle

Promotion creates a NEW session — it does not mutate the deliberation session:

1. Deliberation session's channel transcript is read and formatted
2. New session created with fresh `session_id`, assigned the chosen workflow
3. A `promoted-from` session_link connects the new session to the deliberation session
4. Deliberation session is archived (`archived_at` set, not deleted — transcript preserved)
5. New session proceeds through normal lifecycle: worktree creation → bootstrap → first workflow phase
6. The first phase's prompt includes `{{PREVIOUS_FINDINGS}}` resolved from the deliberation session's channel content via the session_link

The workflow for the new session references the promotion content:

```yaml
inputFrom:
  PREVIOUS_FINDINGS: promoted-from.channel
```

`resolveInputFrom` follows the `promoted-from` session_link, finds the deliberation session, reads the channel transcript. This replaces the synthetic `__promoted__` phase_run from the previous design.

New session's `metadata_json` includes `{ "promotedFrom": "<deliberation_session_id>" }` for traceability.

## UI Layout

### Sidebar Integration

All sessions appear in one unified list. Sessions with workflows are expandable, showing their child sessions in a tree. There is no separate section or entry point for deliberation sessions.

```
┌──────────────────┐
│  SESSIONS        │
│  ▶ Auth refactor │  <- build-loop workflow, running
│    └ claude ●    │     <- child session (implement phase)
│  ◉ API migration │  <- no workflow (direct chat), needs attention
│  ▶ Is Redis right│  <- interrogate workflow, deliberating
│    ├ claude ◌    │     <- child session (advocate)
│    └ codex  ◌    │     <- child session (interrogator)
│  ✓ Fix login bug │  <- no workflow (direct chat), completed
│                  │
│  + New session   │
│                  │
│  [Terminal] [+]  │
└──────────────────┘
```

Sessions with deliberation workflows show the deliberation status (turn count, whether concluded). Each child session is a full session you can click into.

### Channel View

Identical to the deliberation view in workspace mode. Child session messages color-coded by role, turn counter, intervene button, end button. Each child session is independently viewable — clicking one in the sidebar tree opens its individual chat view.

Additional controls for deliberation sessions:

- **"Create session"** button — promotes the deliberation findings into a new session with a different workflow
- **"Summary"** button — runs a synthesis agent on the channel transcript (like `herd summary`)
- **"Export"** — saves the channel transcript as markdown

### Summary Generation

When a deliberation concludes (or on demand), forge can run a synthesis step:

```
1. Collect full channel transcript
2. Spawn a single child session with the synthesis prompt
3. The synthesis prompt varies by pattern:
   - Debate: "Synthesize the answer from both sides' arguments"
   - Interrogate: "Produce a structured plan assessment with gaps found"
   - Explore: "Extract actionable implications from the analogies discussed"
   - Code Review: "Compile findings by severity with recommended actions"
   - Refine Prompt: "Produce the final improved prompt with all accepted changes"
4. Display summary in a panel below the channel view
```

This mirrors HerdingLlamas' `herd summary` command but integrated into the UI.

## Pattern Templates

Each pattern comes with pre-configured role prompts, turn limits, and synthesis prompts. These are the same prompts used in workflow deliberation phases — shared templates, not duplicated.

```typescript
interface ChatPattern {
  id: string;
  name: string;
  description: string;
  roles: [RoleConfig, RoleConfig];
  defaultMaxTurns: number;
  synthesisPrompt: string;
  requiresWorkdir: boolean; // code-review needs a repo
  requiresInput: "question" | "plan" | "code" | "prompt";
}

const PATTERNS: ChatPattern[] = [
  {
    id: "debate",
    name: "Debate",
    description: "Two agents argue positions on a question",
    roles: [
      { name: "Proponent", prompt: DEBATE_PROPONENT_PROMPT },
      { name: "Opponent", prompt: DEBATE_OPPONENT_PROMPT },
    ],
    defaultMaxTurns: 20,
    synthesisPrompt: DEBATE_SYNTHESIS_PROMPT,
    requiresWorkdir: false,
    requiresInput: "question",
  },
  {
    id: "interrogate",
    name: "Interrogate Plan",
    description: "Systematically probe a plan for gaps",
    roles: [
      { name: "Advocate", prompt: ADVOCATE_PROMPT },
      { name: "Interrogator", prompt: INTERROGATOR_PROMPT },
    ],
    defaultMaxTurns: 20,
    synthesisPrompt: INTERROGATE_SYNTHESIS_PROMPT,
    requiresWorkdir: true,
    requiresInput: "plan",
  },
  // ... explore, code-review, refine-prompt
];
```

## CLI Integration

```bash
# Start a standalone deliberation from CLI
forge chat interrogate "Is our caching strategy sound?" --workdir .
forge chat debate "Should we use microservices or monolith?"
forge chat code-review --diff HEAD~3..HEAD
forge chat refine-prompt ./prompts/implement.md --target claude

# These create deliberation sessions and open the channel view in the app
# Or with --json, output the transcript when complete (like herd --json)
```

## Challenges

### Discoverability of deliberation workflows

Users need to discover that deliberation patterns exist in the workflow picker. The dropdown should make it clear: some workflows are implementation patterns (build-loop, plan-then-implement), others are thinking patterns (interrogate, debate, explore). Grouping or labeling within the dropdown helps.

**Resolution:** The workflow picker groups workflows by category. Deliberation workflows have a brief description (e.g., "Systematically probe a plan for gaps"). The default "(none)" option is clear: direct chat, no orchestration. The promotion path ("create session from this") bridges from deliberation to implementation.

### Child session lifecycle for deliberation sessions

Deliberation sessions create two child sessions directly (no phase_run). When the deliberation concludes, child sessions complete. When the user dismisses the session, it is archived (not deleted — transcript is preserved). The deliberation_state is stored on the session's channel or in the session's metadata_json.

### Pattern prompt maintenance

The role prompts (advocate, interrogator, connector, critic, etc.) are the engine of behavior control. They need to be:

- Shared between standalone deliberation workflows and workflow deliberation phases
- Versioned (so improvements to prompts benefit all contexts)
- Customizable (advanced users might want to tweak prompts)

Store prompts as files in the app bundle (version-controlled). Allow user overrides in `~/.forge/prompts/`. Deliberation patterns reference prompts by ID, not by embedding them.

## Open Questions

1. **Can deliberations be resumed?** If you close forge mid-deliberation, can you reopen and continue? With the sessions-first model, yes — the channel and child sessions are persisted. The daemon can keep them running.

2. **Should deliberations appear in cost reporting?** Deliberations cost money. They should appear in cost reporting alongside other sessions. (Yes — they're just sessions.)

3. **Can you have multiple deliberations open simultaneously?** Probably yes — each is independent. The sidebar shows all active sessions. Switching between them is like switching between any sessions.

4. **Should deliberation patterns be extensible?** Can users define custom patterns with custom role prompts? This is the "community workflow templates" idea from 09-open-questions.md applied to deliberation workflows. Stretch goal but valuable — see doc 04's Workflow Management section.

## Related Documents

- [08-deliberation.md](./08-deliberation.md) — Multi-agent patterns and role prompts
- [11-channel-tool-contract.md](./11-channel-tool-contract.md) — How agents interact with channels
- [05-workspace-ux.md](./05-workspace-ux.md) — Sidebar and view layout
- [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) — Sessions-first data model
