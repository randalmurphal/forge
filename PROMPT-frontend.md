# Frontend Loop

## Housekeeping

```
Ignore: node_modules/, dist/, .turbo/, coverage/, *.log, bun.lock
```

## Prime Directive

This loop builds the frontend UI components and state management for forge's workflow, channel, and session tree features. It consumes the server endpoints and types from Loops 1 and 2.

This loop builds:
- Sidebar tree -- expandable parent/child thread hierarchy
- Workflow picker -- dropdown in thread creation flow
- Workflow timeline view -- phase outputs rendered by type
- Channel view -- deliberation conversation display
- Quality check results component -- inline pass/fail display
- Gate approval component -- inline approve/reject/correct
- Workflow editor -- list-based phase card editor
- WebSocket push event handling for new channels
- New Zustand stores and React Query hooks for workflow/channel state

This loop does NOT build: server services, daemon mode, CLI, or product identity changes.

Scope boundary: If it requires creating server endpoints, modifying persistence layers, or changing orchestration logic -- it's out of scope for this loop.

## Authority Hierarchy

1. design/05-workspace-ux.md (UX authority)
2. design/15-contracts.md (type authority for props/state)
3. design/12-channel-chat-mode.md (deliberation UX)
4. design/14-implementation-guide.md (frontend patterns)
5. This PROMPT

When authorities conflict, higher-numbered documents yield to lower-numbered. UX spec wins on layout and interaction. Contract types win on data shapes. This PROMPT wins on implementation scope and file placement.

## Rules of Engagement

- Follow existing component patterns (see ChatView.tsx, Sidebar.tsx)
- Extract pure logic to `.logic.ts` files with `.logic.test.ts` tests
- Use Tailwind CSS for styling (no CSS modules, no styled-components)
- Use TanStack React Query for server data (useQuery, useMutation)
- Use Zustand for client state (follow existing store.ts patterns)
- Use TanStack Router for file-based routing
- Use Lucide React for icons
- Use BaseUI React for UI primitives (Dialog, Menu, Popover)
- Use CVA for component variants
- Keep components under 500 lines -- extract sub-components
- The existing ChatView.tsx is UNCHANGED for plain threads -- new components compose alongside it
- New stores go in apps/web/src/stores/ as separate files (workflowStore.ts, channelStore.ts)
- New routes follow TanStack Router file-based conventions in apps/web/src/routes/
- Pure logic files contain zero React imports -- only data transformations and derivations

PROHIBITED:
- Modifying existing server code
- Creating new server services or endpoints
- Modifying ChatView.tsx (it works for agent sessions as-is)
- Using CSS-in-JS or CSS modules
- Creating components over 500 lines without extraction
- Using async/await outside of React Query hooks
- Defining new types that aren't derived from design/15-contracts.md

## Environment

- Language: TypeScript
- Runtime: Bun / Node.js
- Framework: React 19 + Effect.js
- State: Zustand + TanStack React Query
- Routing: TanStack Router (file-based)
- Styling: Tailwind CSS + CVA
- Icons: Lucide React
- UI primitives: BaseUI React
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
6. Write tests (logic files get .logic.test.ts, components get interaction tests where valuable)
7. Run quality gate
8. Commit with descriptive message
9. Update progress file (mark item complete, log iteration)
10. Repeat

## Work Items

**WI-1: Workflow store**
- Spec references: design/15-contracts.md section 2 (WorkflowDefinition type), design/14-implementation-guide.md stores section
- Target files: NEW apps/web/src/stores/workflowStore.ts
- Deliver: Zustand store holding: available workflows (fetched from server), selected workflow for creation, workflow editing state. React Query hooks: useWorkflows() to fetch available list, useWorkflow(id) for single workflow. Follow existing store.ts patterns -- flat state, pure helper functions, typed actions.
- Tests: Store updates correctly on workflow fetch. Query hooks type-check. Selection state updates.
- Done when: Workflow data fetchable and cached, store exports clean typed API

**WI-2: Channel store**
- Spec references: design/15-contracts.md section 3 (Channel, ChannelMessage types)
- Target files: NEW apps/web/src/stores/channelStore.ts
- Deliver: Zustand store for: active channel messages (per channel), channel subscription state, deliberation state (turn count, participants). React Query hooks: useChannelMessages(channelId, limit?), useChannel(channelId). Pagination support for message history.
- Tests: Store updates on new messages. Pagination cursor advances correctly.
- Done when: Channel data fetchable and reactive to push events

**WI-3: Sidebar tree -- parent/child hierarchy**
- Spec references: design/05-workspace-ux.md sidebar section
- Target files: MODIFY apps/web/src/components/Sidebar.tsx, NEW apps/web/src/components/SidebarTree.tsx, NEW apps/web/src/components/SidebarTree.logic.ts, NEW apps/web/src/components/SidebarTree.logic.test.ts
- Deliver: Extend sidebar to render thread tree. Top-level threads show normally. Threads with childThreadIds are expandable -- click arrow to show children indented. Children show: title, provider icon, role label, status badge. Parent status badge propagates from children (any child needs-attention -> parent shows needs-attention). Tree depth bounded at 2. Follow existing SidebarThreadSummary patterns. Sorting: needs-attention first, then running, then paused, then completed.
- Tests: Tree builds correctly from flat thread list with parentThreadId. Status propagation logic. Expand/collapse state. Sorting (needs-attention first, most recently active within group).
- Done when: Sidebar shows expandable thread tree with status propagation

**WI-4: Workflow picker in thread creation**
- Spec references: design/05-workspace-ux.md session creation section (question 4 resolution)
- Target files: MODIFY apps/web/src/hooks/useHandleNewThread.ts or the creation flow component, NEW apps/web/src/components/WorkflowPicker.tsx
- Deliver: Dropdown component showing available workflows fetched from workflow store. "(none)" = plain agent chat (default). Selecting a workflow stores workflow_id in the creation params. On submit, thread.create command includes workflow_id. Dropdown uses BaseUI Menu or Popover for the picker UI. Built-in workflows listed first, then project-specific, then user-created.
- Tests: Dropdown renders workflows. Selection updates creation params. Default is no workflow. Submit includes workflow_id when selected.
- Done when: Users can pick a workflow when creating a thread

**WI-5: Workflow timeline view**
- Spec references: design/05-workspace-ux.md "Workflow Timeline View"
- Target files: NEW apps/web/src/components/WorkflowTimeline.tsx, NEW apps/web/src/components/WorkflowTimeline.logic.ts, NEW apps/web/src/components/WorkflowTimeline.logic.test.ts, NEW apps/web/src/routes/_workflow.$threadId.tsx
- Deliver: Component showing phase outputs in a scrollable timeline. Each phase section: header (phase name, status, iteration), output rendered by type (schema output -> summary markdown, channel output -> chat-style messages, conversation -> last message markdown). Quality check results between phases (pass/fail with expandable output). Active phase shows live child session streaming. Route detects workflow threads and renders this instead of ChatView. Clicking a phase header expands into that child session's full chat transcript.
- Tests: Timeline renders from phase_run + phase_output data. Schema output shows summary. Channel output shows messages. Quality checks render between phases. Active phase identified correctly.
- Done when: Workflow threads show the timeline view with correct output rendering per type

**WI-6: Channel view**
- Spec references: design/05-workspace-ux.md "Channel View", design/12-channel-chat-mode.md
- Target files: NEW apps/web/src/components/ChannelView.tsx, NEW apps/web/src/components/ChannelView.logic.ts, NEW apps/web/src/components/ChannelView.logic.test.ts
- Deliver: Component showing deliberation channel messages. Messages labeled by role and color-coded per participant (like HerdingLlamas TUI). Turn counter. Real-time updates via WebSocket push. Intervene button opens text input that posts to the channel. View individual participant's full transcript by clicking their name (navigates to child thread). Split view option: participant transcripts flanking the channel (three-pane layout toggled by keyboard shortcut).
- Tests: Messages render with correct role labels. Color coding per participant. Turn counter updates on new messages. Intervene posts to channel API.
- Done when: Channel view shows deliberation with real-time updates and split view option

**WI-7: Quality check results component**
- Spec references: design/05-workspace-ux.md gate/quality check sections
- Target files: NEW apps/web/src/components/QualityCheckResults.tsx
- Deliver: Inline component showing check pass/fail status. Each check: name, pass/fail icon (Lucide CheckCircle/XCircle), expandable output. Used in workflow timeline between phases. Collapsed by default for passing checks, expanded for failures.
- Tests: Renders pass/fail correctly. Output expands/collapses. Failure checks default-expanded.
- Done when: Quality check results display cleanly between timeline phases

**WI-8: Gate approval component**
- Spec references: design/05-workspace-ux.md "Gate Approval View"
- Target files: NEW apps/web/src/components/GateApproval.tsx
- Deliver: Inline component for human gates. Shows: phase output summary, quality check results (if applicable), unresolved items list, changes summary. Three buttons: Approve (dispatches gate approval command), Reject (with reason textarea), Correct (textarea that posts correction to guidance channel then retries). Keyboard shortcuts: `a` to approve, `r` to reject. Appears inline in the workflow timeline at human-approval gates.
- Tests: Approve dispatches correct command. Reject with reason dispatches reject. Correct posts to channel and retries. Keyboard shortcuts work.
- Done when: Gate approval handles all three actions with keyboard support

**WI-9: Workflow editor**
- Spec references: design/05-workspace-ux.md "Workflow Editor" section
- Target files: NEW apps/web/src/components/WorkflowEditor.tsx, NEW apps/web/src/components/PhaseCard.tsx, NEW apps/web/src/routes/_workflow.editor.tsx, NEW apps/web/src/routes/_workflow.editor.$workflowId.tsx
- Deliver: Full-page editor. Vertical list of phase cards. Each card: name input, model picker dropdown, prompt picker dropdown, "After" dropdown (auto-continue, quality checks, human approval, done), "On fail" dropdown (retry, go back to phase, stop). Deliberation toggle per phase (adds second model/prompt picker with role labels -- Advocate/Interrogator). Drag reorder via @dnd-kit (already in codebase) or up/down buttons. Add/remove phases. Save globally or per-project (scope toggle). Clone built-in workflows (built-ins are read-only, clone to edit). Routes: /workflow/editor (new) and /workflow/editor/:id (edit existing).
- Tests: Add phase. Remove phase. Reorder. Save dispatches correct mutation. Load existing workflow populates cards. Deliberation toggle adds second participant fields.
- Done when: Workflow editor creates and edits workflows with full phase card editing

**WI-10: WebSocket push event handling**
- Spec references: design/15-contracts.md section 7 (push events)
- Target files: MODIFY apps/web/src/store.ts (or new handler), MODIFY apps/web/src/wsTransport.ts
- Deliver: Handle new push channels: workflow.phase (phase lifecycle events), channel.message (new channel messages), workflow.quality-check (check progress/results), workflow.bootstrap (bootstrap progress), workflow.gate (gate status changes). Decode payloads using contract schemas. Route events to the correct store (workflowStore, channelStore, or main store). Follow existing push event handling patterns in __root.tsx.
- Tests: Each push event type updates the correct store state. Malformed payloads are rejected cleanly.
- Done when: All new push events received, decoded, and routed to stores

**WI-11: Phase transition states**
- Spec references: design/05-workspace-ux.md "Phase Transition States"
- Target files: Part of WorkflowTimeline.tsx (may extract sub-component if needed)
- Deliver: Show transient states inline in the timeline: "Running quality checks..." with streaming check output, "Phase completed -- starting next...", "Setting up next phase..." with bootstrap output, "Waiting for approval" with gate UI (WI-8). Auto-navigate to new child session when it spawns (listen for push event, update router). Transient states driven by push events from WI-10.
- Tests: Each transition state renders correctly based on push event payloads. Auto-navigation triggers on child session spawn event.
- Done when: Phase transitions are visible and auto-navigation works

## Reminders

- The existing thread/session UI must continue working perfectly. All existing tests must pass.
- ChatView.tsx is NOT modified. Workflow and channel views are new components that compose alongside it.
- The main panel dispatches to the correct component based on thread type: no-workflow threads use ChatView, workflow threads use WorkflowTimeline, deliberation threads use ChannelView.
- Stores are separate files in apps/web/src/stores/ -- do not bloat the existing store.ts with workflow/channel state.
- Pure logic in .logic.ts files has zero React imports. These files are the primary test surface.
- Follow the existing patterns in Sidebar.tsx, store.ts, and __root.tsx exactly. Read them before writing.
- @dnd-kit is already a dependency (used in Sidebar.tsx for thread reordering) -- reuse it for the workflow editor phase reordering.

## Review Phase

After all work items are complete, enter the review/fix cycle:

1. Check progress file for Known Issues -- fix ALL (highest severity first)
2. If no Known Issues, sweep one review category (see below)
3. Run quality gate, commit all fixes
4. Update progress file
5. Repeat

You NEVER write "Loop Complete" or "Loop Done" in the progress file. The human decides when the loop is done.

Review categories:
1. Spec Compliance -- UI matches design/05-workspace-ux.md exactly (status indicators, layout, keyboard shortcuts, sorting)
2. Component Size -- no component over 500 lines, logic extracted to .logic.ts
3. Test Coverage -- every .logic.ts has comprehensive .logic.test.ts (edge cases, empty states, error states)
4. Accessibility -- keyboard navigation (j/k, Enter, Esc, a/r for gates), focus management, ARIA labels
5. State Management -- no prop drilling, stores used correctly, React Query for server data, Zustand for client state
6. Dead Code -- no unused components, store fields, imports, or route definitions
7. Performance -- no unnecessary re-renders, memoization where needed, virtual scrolling for long lists
