# Workspace UX

## Principles

The workspace should feel like mission control, not a chat app. You're overseeing multiple sessions, each at different stages, and you need to quickly assess: what's running, what needs me, what's done.

### Glanceable status

The sidebar tells you everything at a glance without clicking into anything. Session name, current phase, status badge, time since last activity. If something needs attention, it's visually obvious (not buried in a menu).

### Keyboard-first

Every action is reachable by keyboard. Navigate sessions with j/k, open session with Enter, post correction with c, approve gate with a. Mouse works too, but power users should never need it.

### Minimal chrome

No tab bars, breadcrumbs, or nested navigation. The workspace is flat: sidebar on the left, main content on the right. The main content changes based on what's selected. That's it.

### Progressive disclosure

The default view shows what matters: session status, current agent output, correction input. Details (full transcript, token usage, git diff, quality check logs) are one keypress away but not cluttering the default view.

## Layout

```
┌──────────────────┬──────────────────────────────────────────┐
│                  │                                          │
│   Sessions       │              Main Panel                  │
│                  │                                          │
│  ┌────────────┐  │  Depends on selected session + workflow: │
│  │▶ Refactor  │  │                                          │
│  │  ● running │  │  - Chat view (conversation, = t3-code)   │
│  │  └ claude  │  │  - Workflow view (phase progress + child) │
│  │    ● impl  │  │  - Channel view (deliberation)           │
│  ├────────────┤  │  - Review view (quality check results)   │
│  │  Fix login │  │  - Terminal view                         │
│  │  ◉ needs   │  │                                          │
│  │    attention│  │  Clicking a leaf (child) session opens   │
│  ├────────────┤  │  the chat view component.                │
│  │▶ Review #42│  │  Clicking a container (workflow)         │
│  │  ◌ delib.  │  │  opens the orchestration/channel view.   │
│  │  ├ claude  │  │                                          │
│  │  └ codex   │  │                                          │
│  ├────────────┤  ├──────────────────────────────────────────┤
│  │+ New session│  │  Correction / Input Bar                  │
│  └────────────┘  │  [Type correction or message...]    Send │
│                  └──────────────────────────────────────────┘
│  [Terminal] [+]  │
└──────────────────┘
```

## Sidebar: Sessions

### What each session entry shows

```
┌─────────────────────────────┐
│ ● Refactor auth middleware  │  <- status dot + title
│   implement (2/4)  3m ago   │  <- current phase (iteration/max) + recency (workflow sessions)
│   claude  main              │  <- provider + branch
└─────────────────────────────┘
```

The sidebar shows all sessions in one list. Sessions with workflows are expandable, revealing their child sessions (phases, deliberation participants). Sessions without a workflow look exactly like t3-code threads.

Clicking any leaf (child) session in the tree opens the same chat view component. Clicking a container session (workflow or chat) opens the orchestration/channel view.

**Status indicators:**

- `●` green = running, child session actively working
- `◉` yellow = needs attention (gate waiting, correction needed, error)
- `◌` blue = deliberation in progress (two child sessions)
- `○` gray = paused or created (not started)
- `✓` green outline = completed
- `✗` red = failed

**Sorting:** Needs-attention first, then running, then paused, then completed. Within each group, most recently active first.

**Filtering:** Toggle to show/hide completed sessions. Search by title. Filter by project.

### Quick actions from sidebar

- Hover/select a session: shows phase progress bar (workflow sessions) or conversation status (no-workflow sessions)
- Right-click / keyboard shortcut: pause, resume, cancel, restart
- Notification badge: count of unread items (corrections, gate results)

### Terminal tabs at bottom

Below the session list, a separate section for terminal sessions. These are independent of sessions - just scratch terminals for manual work.

## Main Panel: Session View

For agent sessions and single-agent workflow phases (implement, review):

```
┌──────────────────────────────────────────────────┐
│  Phase: implement (iteration 2 of 5)             │
│  Provider: claude | Tokens: 45.2k | Cost: $1.23  │
├──────────────────────────────────────────────────┤
│                                                  │
│  Agent output (streaming)                        │
│                                                  │
│  Reading src/auth/middleware.ts...               │
│  The current implementation has a session        │
│  token storage issue. I'll refactor to use...    │
│                                                  │
│  [Tool: edit_file src/auth/middleware.ts]         │
│  @@ -45,10 +45,15 @@                             │
│  - const token = localStorage.get(...)           │
│  + const token = await secureStore.get(...)      │
│                                                  │
│  Running tests...                                │
│  ✓ 42 passed  ✗ 1 failed                        │
│  FAIL: test/auth.test.ts                         │
│  Expected: 200, Received: 401                    │
│                                                  │
├──────────────────────────────────────────────────┤
│  ⚡ Correction from you (2 min ago):             │
│  "The API changed in the other session, update   │
│   the import path from @/auth to @/auth/v2"      │
├──────────────────────────────────────────────────┤
│  [Type correction or message...]            Send │
└──────────────────────────────────────────────────┘
```

Key elements:

- **Phase header**: which phase, which iteration, provider info, cost
- **Session output**: streaming, collapsible tool calls, inline diffs
- **Correction history**: visible inline so you see what you already told the agent
- **Input bar**: always visible at the bottom for corrections

### Collapsible sections

- Tool calls: show the tool name and a summary, expand for full input/output
- Diffs: show filename and change summary, expand for full diff
- Long outputs: truncate with "show more"

### Status transitions visible

When a gate triggers, it appears inline:

```
──── Gate: quality-check ────
✓ tests passed (42/42)
✓ lint passed
✗ typecheck failed: 2 errors
  src/auth/types.ts:15 - Type 'string' is not assignable to type 'SessionToken'
  src/auth/types.ts:28 - Property 'expires' is missing

→ Retrying implement phase (iteration 3)
────────────────────────────
```

### Phase Output Viewer

When a phase completes and produces output (plan, synthesis, review findings), the main panel shows:

- Markdown rendering for plan/synthesis/review outputs
- Editable text area (user can refine before feeding to next phase)
- Action buttons: 'Feed to next phase' / 'Create session from this' / 'Export as markdown'
- For multi-agent phase outputs: tabbed view per role (scrutinizer findings, defender findings), each tab corresponds to a child session

### Workflow Timeline View

When viewing a top-level workflow session (the container, not a child), the main panel shows a timeline of phase outputs, rendered according to each phase's output type:

**Schema output phases** — render the `summary` field as markdown text. Structured data available via expand/detail view.

**Channel/deliberation phases** — render the channel conversation inline. Messages labeled by role, displayed like a chat. This IS the output for deliberation phases.

**Conversation output phases** — render the agent's final message as markdown.

**Quality check results** — render between phases when checks ran. Show pass/fail per check with output for failures. If the phase retried, the check results appear before the retry:

```
─── Implement (completed) ───────────────────
Refactored auth middleware to use secure token
storage. 3 files changed, 4 tests added.

─── Quality Checks ──────────────────────────
✓ lint — passed
✓ typecheck — passed
✗ test — 1 failed
  FAIL auth.test.ts:47
  Expected: 200, Received: 401

→ Retrying Implement (attempt 2/5)

─── Implement (attempt 2, completed) ────────
Fixed the test failure. The API endpoint was
returning 401 because the middleware wasn't
passing the token to the downstream service.

─── Quality Checks ──────────────────────────
✓ lint — passed
✓ typecheck — passed
✓ test — 4/4 passed

─── Review (completed) ──────────────────────
[Scrutinizer]: The error handling on line 45...
[Defender]: Architecture fit is good...

─── Finalize (completed) ────────────────────
Committed: a3f7b2c "refactor auth middleware"
PR #47 created: github.com/repo/pull/47
```

Clicking a phase header expands into that child session's full chat transcript. The timeline is the overview; the child sessions are the detail.

**During active execution:** The timeline shows completed phases' outputs above, and the currently active child session's live chat below (streaming). When the active phase completes and the next starts, the completed output scrolls up into the timeline and the new phase's live chat appears.

**At a gate:** The gate UI (approve/reject/correct) appears inline in the timeline between the completed phase and the next pending phase.

## Main Panel: Channel View (Deliberation)

For multi-agent phases:

```
┌──────────────────────────────────────────────────┐
│  Phase: deliberate | Advocate (claude) vs        │
│  Interrogator (codex) | Turn 6/20                │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌─ Advocate ──────────────────────────────────┐ │
│  │ The proposed caching layer is well-suited   │ │
│  │ for this access pattern. Redis gives us...  │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  ┌─ Interrogator ──────────────────────────────┐ │
│  │ What happens when the cache is cold after   │ │
│  │ a deploy? The stampede protection is not...  │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  ┌─ Advocate ──────────────────────────────────┐ │
│  │ Valid point. I'll concede that stampede      │ │
│  │ protection needs explicit handling. Here's   │ │
│  │ a revised approach: ...                      │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
├──────────────────────────────────────────────────┤
│  [Intervene / End deliberation]            Send  │
└──────────────────────────────────────────────────┘
```

Key elements:

- **Child session messages color-coded by role** (like HerdingLlamas TUI)
- **Turn counter**: how far through the deliberation
- **Research footnotes**: when agents cite sources, show inline
- **Intervene**: human can post to the channel, both agents see it
- **End deliberation**: human can force conclusion early

### Split Deliberation View

Since each deliberation participant is a full session, the UI can offer a three-pane split:

- Left: First participant's internal session (full chat view — tool calls, reasoning, research)
- Center: Channel conversation (the exchange between participants)
- Right: Second participant's internal session

This gives forensic visibility into WHY each participant posted what they did. The channel shows the conversation; the side panes show the work behind each message. Toggle between split view and channel-only view with a keyboard shortcut.

### Side-by-side option

For code review deliberation, option to show the two agents' independent reviews side by side before cross-examination begins:

```
┌────────────────────────┬─────────────────────────┐
│  Scrutinizer           │  Defender               │
│                        │                         │
│  [HIGH] Line 45: SQL   │  Architecture fit is    │
│  injection via string  │  good. The new service  │
│  concat in query...    │  follows the existing   │
│                        │  pattern from...        │
│  [MED] No error        │                         │
│  handling on the HTTP  │  [CONCERN] Missing      │
│  client timeout...     │  backwards compat for   │
│                        │  existing consumers...  │
└────────────────────────┴─────────────────────────┘
```

## Main Panel: Gate Approval View

When a phase hits a human gate:

```
┌──────────────────────────────────────────────────┐
│  ◉ Gate: Human Review Required                   │
│  Phase: review completed | Waiting for approval  │
├──────────────────────────────────────────────────┤
│                                                  │
│  Summary:                                        │
│  Agent reviewed implementation and found 3       │
│  issues. 2 were fixed, 1 needs your decision.   │
│                                                  │
│  ┌─ Unresolved ─────────────────────────────────┐│
│  │ The auth endpoint returns 200 on invalid     ││
│  │ tokens instead of 401. Agent notes this may  ││
│  │ be intentional for backwards compatibility.  ││
│  │ Spec is ambiguous.                           ││
│  └──────────────────────────────────────────────┘│
│                                                  │
│  ┌─ Changes ────────────────────────────────────┐│
│  │ 4 files changed, +127 -43                    ││
│  │ src/auth/middleware.ts (major)               ││
│  │ src/auth/types.ts (new)                      ││
│  │ test/auth.test.ts (updated)                  ││
│  │ package.json (dependency added)              ││
│  │ [View full diff]                              ││
│  └──────────────────────────────────────────────┘│
│                                                  │
│  [Approve & Continue]  [Correct & Retry]  [Fail] │
│                                                  │
│  Correction: [Optional message if retrying...]   │
└──────────────────────────────────────────────────┘
```

### Phase Transition States

When a workflow moves between phases, the UI surfaces transient states:

**Quality check running:**
The main panel shows a progress view: check name, running/passed/failed status per check, streaming stdout for the active check. This appears automatically when a quality-check gate starts evaluating. The user can see test output in real time.

**Gate evaluation complete, next phase pending:**
If the gate passes automatically, the UI briefly shows "Phase N completed — starting Phase N+1..." and auto-navigates to the new child session when it spawns. If the gate requires human approval, the gate approval view appears (summary, unresolved items, approve/reject/correct buttons).

**Between phases (gate passed, bootstrap running for next phase):**
Show "Setting up Phase N+1..." with bootstrap output streaming. Once bootstrap completes and the new child session starts, auto-navigate to it.

**Auto-navigation rule:** When a new child session spawns in a workflow the user is viewing, the UI auto-navigates to that child session's chat view. The user can always navigate back to the parent workflow overview or to previous phase children via the sidebar tree.

## Notifications

### In-app notifications

- Yellow badge on session in sidebar
- Toast notification (non-blocking, auto-dismiss after 5s)
- Sound (optional, configurable)

### OS notifications (via Electron)

- Native macOS/Linux/Windows notifications
- Click notification -> forge focuses and navigates to the session
- Configurable: which events trigger OS notifications
  - Default: gate approvals, session failures, deliberation complete
  - Optional: every phase transition, every agent message

### Notification settings

```
Notify me when:
  [x] A session needs my attention (gate, error, correction needed)
  [x] A deliberation completes
  [x] A session completes
  [ ] Every phase transition
  [ ] Agent posts to a channel

Notification method:
  [x] In-app toast
  [x] OS notification
  [ ] Sound
```

## Keyboard Shortcuts

| Key           | Action                                              |
| ------------- | --------------------------------------------------- |
| `j/k`         | Navigate session list                               |
| `Enter`       | Open selected session                               |
| `Esc`         | Back to session list                                |
| `c`           | Focus correction input                              |
| `a`           | Approve gate (when gate view active)                |
| `r`           | Reject / retry gate                                 |
| `t`           | Toggle terminal panel                               |
| `n`           | New session                                         |
| `p`           | Pause/resume selected session                       |
| `d`           | Toggle details panel (token usage, full transcript) |
| `Cmd+1-9`     | Jump to session by position                         |
| `Cmd+Shift+N` | New terminal tab                                    |

## Challenges

### Information density vs. clarity

Sessions produce a LOT of output. Tool calls, file reads, diffs, reasoning, test output. Showing everything is overwhelming. Hiding too much makes it hard to debug when something goes wrong. The collapsible section approach helps but needs careful defaults.

**Proposed defaults:**

- Tool calls: collapsed, show tool name + one-line summary
- Diffs: collapsed, show filename + stats (+/- lines)
- Test output: collapsed, show pass/fail count
- Agent reasoning: visible (this is what matters)
- Corrections: always visible, highlighted

### Streaming UX

Session output streams token by token. The UI needs to:

- Scroll smoothly (not jump)
- Not re-render the entire conversation on each token
- Handle tool calls that appear mid-stream
- Show "thinking..." state cleanly

t3-code already handles this for the conversation view. We inherit that.

### Multi-session overview

When you have 5+ sessions running, the sidebar needs to convey status without requiring you to read each entry carefully. The color-coded status dots help, but we might also need:

- A dashboard/summary view (all sessions at a glance)
- Grouped by project
- Timeline view (when did each session start, where is it now)

This is a v2 feature, not v1. For v1, the sidebar with status dots is sufficient for 3-10 sessions.

### Responsive to different workflows

The main panel needs to render differently based on phase type:

- Single-agent: conversation view
- Multi-agent: channel view (like a chat between agents)
- Automated: quality check results
- Human: approval form

This isn't just styling - it's different component trees. Need a clean way to switch based on phase type without a rats' nest of conditionals.

**Approach:** One component per internal session type, with sub-components per phase type for workflow sessions. Sessions without a workflow use t3-code's chat view directly. Clicking a child session within any container also opens the chat view. The main panel dispatches to the right component based on the internal `session.type` and (for workflow sessions) `phaseRun.phase.type`. Each component owns its own layout and interaction patterns.

## Design Inspirations

- **cmux sidebar**: Vertical tabs with git branch, port, notification metadata per workspace. Clean, glanceable.
- **Linear**: Session list with status indicators, keyboard navigation, progressive disclosure.
- **HerdingLlamas TUI**: Color-coded agent messages in deliberation, message count, elapsed time in header.
- **VS Code terminal**: Terminal as a panel below the main content, not a separate window.

## Workflow Editor

The workflow editor is a simple list-based interface for creating and editing workflows. No canvas, no graph, no node editor. A workflow is a list of phases in order.

### Creating a Workflow

```
Create Workflow
─────────────────────────────────────────────
Name: [build-with-review              ]
Scope: (●) Global  ( ) This project

Phases:
┌─────────────────────────────────────────┐
│ 1. Implement                         [⋮]│
│    Model: [claude-sonnet-4-5       ▾]   │
│    Prompt: [implement template     ▾]   │
│    After: [run quality checks      ▾]   │
│      Checks: ☑ test  ☑ lint  ☑ types   │
│    On fail: [retry this phase      ▾]   │
│      Max retries: [5]                   │
├─────────────────────────────────────────┤
│ 2. Review                            [⋮]│
│    Model: [claude-opus-4           ▾]   │
│    Prompt: [review template        ▾]   │
│    After: [human approval          ▾]   │
│    On fail: [go back to: Implement ▾]   │
├─────────────────────────────────────────┤
│ 3. Finalize                          [⋮]│
│    Model: [claude-sonnet-4-5       ▾]   │
│    Prompt: [finalize template      ▾]   │
│    After: [done                    ▾]   │
└─────────────────────────────────────────┘

  [+ Add phase]                     [Save]
```

Each phase is a card in a vertical list. The [⋮] handle allows reordering via drag or keyboard.

### Phase Card Fields

**Name:** Free text, identifies the phase in the sidebar and in inputFrom references.

**Model:** Dropdown of available models. Can differ per phase (e.g., opus for review, sonnet for implementation). "auto" uses the session's model selection.

**Prompt:** Dropdown of available prompt templates (bundled + project + personal overrides). Or "custom" to write inline.

**After:** What happens when this phase completes:

- **auto-continue** — proceed to next phase immediately
- **run quality checks** — run the project's configured checks, proceed if passing. Results display in the workflow timeline between phases. On failure, the failure output is passed to the retried phase as `{{ITERATION_CONTEXT}}`.
- **human approval** — pause and wait for the user to approve/reject
- **done** — this is the last phase, session completes

**On fail:** What to do if the "After" condition fails:

- **retry this phase** — re-run this phase with context from the failure (max retries configurable)
- **go back to: [phase]** — jump back to an earlier phase
- **stop** — mark the session as failed, notify user

### Deliberation Phases

For deliberation (two-perspective phases), the phase card expands:

```
┌─────────────────────────────────────────┐
│ 1. Plan Review            [deliberation]│
│    Participants:                        │
│      Advocate:    [claude-opus-4     ▾] │
│        Prompt: [advocate template   ▾]  │
│      Interrogator:[codex-gpt-5.4   ▾]  │
│        Prompt: [interrogator tmpl  ▾]   │
│    Max turns: [20]                      │
│    After: [human approval          ▾]   │
│    On fail: [retry this phase      ▾]   │
└─────────────────────────────────────────┘
```

The user toggles between single-agent and deliberation mode for each phase. In deliberation mode, two model/prompt pickers appear with role labels.

### Workflow Management

- **Global workflows** — available across all projects. Stored in forge's database. Built-in workflows ship pre-configured and can be cloned/customized.
- **Project workflows** — stored in .forge/workflows/ within the project. Available only for that project. Take precedence over global workflows with the same name.
- **Editing** — click any workflow in the list to open the editor. Built-in workflows can be cloned but not modified directly.
- **Deleting** — user-created workflows can be deleted. Built-in workflows cannot.

Access the workflow list via sidebar menu or settings. The workflow editor is a full-page view, not a modal.

## Open Questions

1. **Split panes?** Should the main panel support splits (e.g., agent output on top, terminal on bottom)? cmux has this. It's useful but adds complexity to the layout engine.

2. **Dark mode only, or light mode too?** Developer tools are traditionally dark. Supporting both doubles the design work. Probably dark-only for v1.

3. **How do we handle very long sessions?** A session running for hours produces a massive transcript. Virtual scrolling handles the rendering, but loading the full transcript on session select might be slow. Pagination? Only load recent N entries?

4. **Session Creation Flow** (RESOLVED):

   ### Session Creation

   One entry point: **+ New session**

   The creation flow:
   1. Text input: describe what you want to do (title/description)
   2. Workflow picker: dropdown showing available workflows. Options include:
      - **(none)** — direct chat with an agent (default, = t3-code behavior)
      - **build-loop** — implement with quality checks, retry until passing
      - **plan-then-implement** — deliberate on plan, then implement
      - **code-review** — dual-perspective review with cross-examination
      - **interrogate** — systematically probe a plan for gaps
      - **debate** — argue both sides of a question
      - **explore** — lateral thinking with reality-checking
      - **refine-prompt** — systematic prompt evaluation and improvement
      - Plus any project-specific or user-created workflows
   3. Model picker: which provider/model to use (sticky per project)
   4. Optional: branch override, project selection if multi-project

   That's it. No "session type" selector. The workflow choice determines everything — whether there are phases, whether there are child sessions, what the output looks like. "No workflow" = agent session = t3-code chat. A deliberation workflow = two child sessions with a channel. A build-loop = phases with quality gates.

   The sidebar shows ALL sessions in one list. Workflow sessions are expandable to show child sessions (phases, deliberation participants). Sessions without a workflow look exactly like t3-code threads. The sidebar follows t3-code's existing patterns for managing many sessions, old sessions, archiving, etc.

   **On submit**: Dispatch `session.create`, transition to 'Bootstrapping' view (for sessions that require a worktree) or directly to session view (for workflows with requiresWorkdir=false).
   **Bootstrapping**: Show streamed stdout from bootstrap script (via `session.bootstrap` push channel). Progress indicator. On failure: show error + Retry/Skip/Cancel buttons (mapped to `bootstrap-failed` interactive_request resolution).
   **Ready**: Bootstrap complete, first workflow phase starts (workflow sessions) or agent starts (no-workflow sessions). Transition to session view.

   Per doc 13, ALL sessions that require a worktree go through server-side bootstrap. Sessions create a worktree from project HEAD and run bootstrap before the agent starts. Sessions with requiresWorkdir=false skip worktree creation.

   Draft persistence: per-project, stored in localStorage (adapted from t3-code's composerDraftStore). Sticky model selection carries between session creations.

5. **Diff viewer**: Inline in the session view, or a dedicated panel? t3-code has a DiffPanel. Worth keeping. But when do you show it - automatically when files change, or on user request?

## Related Documents

- [00-vision.md](./00-vision.md) - Design principles
- [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) - What the UI renders
- [04-workflow-engine.md](./04-workflow-engine.md) - What drives phase transitions
