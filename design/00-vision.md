# Vision

## What Forge Is

Forge is an agent workspace for software development. It manages coding agent sessions (Claude Code, Codex), orchestrates them through structured workflows, and provides a workspace UI designed for monitoring, correction, and fire-and-forget execution.

It is not a terminal emulator. It is not a chat wrapper. It is the control plane for how you work with coding agents.

## The Problem

Today's agent tools force you to babysit. You start a session, watch it work, intervene when it drifts, and manually coordinate when multiple sessions need attention. The tools assume you're sitting there watching. When you walk away, you come back to either a finished session or a mess you have to untangle.

The specific failures:

1. **No structured workflows.** You can tell an agent "implement this," but there's no system for "implement, then review with a second agent, then fix what the review found, then run quality checks." Each step is manual.

2. **No correction mechanism.** When an agent goes off the rails mid-session, your options are: wait for it to finish and try again, or kill it and start over. There's no way to say "stop, you're headed the wrong way, here's what to focus on" without abandoning context.

3. **No multi-agent coordination.** Two agents reviewing the same plan surface different blind spots. But running that requires manual setup, manual monitoring, manual synthesis. There's no system for structured disagreement.

4. **No observability without context-switching.** Web UIs require opening a browser. Terminal output scrolls past. There's no "notify me when this needs attention and let me handle it inline."

5. **No continuity.** Close your laptop, lose your session state. Reopen, start over. There's no daemon that keeps working and picks up where you left off.

## What Forge Replaces

- **orc's web UI** for workflow monitoring and interaction (forge becomes the primary interface)
- **HerdingLlamas** as a standalone tool (deliberation patterns become forge workflows)
- **ralph-loops** as a manual process (build loops become forge workflows with proper gates)
- **Raw Claude Code / Codex CLI sessions** for complex tasks (forge wraps them with structure)

orc's Go daemon may survive for headless/background orchestration, or its concepts may be fully absorbed into forge's TS backend. That decision is deferred until the architecture stabilizes (see [07-daemon-mode.md](./07-daemon-mode.md)).

## Who It's For

A developer who uses AI coding agents daily and wants to:

- Kick off work and get notified when it needs attention
- Correct agents mid-session without losing context
- Run structured workflows (plan review, implementation with quality gates, multi-agent code review)
- See what's happening across multiple sessions at a glance
- Not think about the orchestration plumbing

## Design Principles

### Agent-first, terminal-second

The primary interface is agent session management. Terminal tabs exist for manual work but aren't the core product. The UI is organized around sessions and workflows, not terminal sessions.

### Fire-and-forget by default

Start a session, walk away. The system notifies you when it needs attention (gate approval, correction needed, session complete). The default state is autonomous execution, not supervised execution.

### Correction over restart

When an agent drifts, you post a correction. The agent incorporates it on its next iteration. You don't kill the session and lose context. Corrections are first-class, persisted, and visible in the session history.

### Workflows are composable patterns, not rigid pipelines

A workflow is a sequence of phases with gates between them. Phases can be: single-agent implementation, two-agent deliberation, automated quality checks, human review. They compose freely.

### One language, one stack

TypeScript throughout. Server, client, contracts, daemon. Shared types, shared tooling, no cross-language friction. AI agents can work on any part of the codebase without context-switching.

### Simple over clever

Plain async/await over Effect.js. Constructor injection over framework DI. Discriminated unions over typed error channels. The patterns should be obvious to any TypeScript developer and to AI agents writing the code.

## What Success Looks Like

You open forge. The sidebar shows your active sessions with status badges. One session is running autonomously (green). Another is waiting for your review (yellow badge). A third has two agents deliberating on a plan (blue, you can watch or ignore).

You click the yellow session. The agent hit a quality gate failure - tests are failing. You see the last few transcript entries, the test output, and a correction input. You type "the API changed in the other session, update the import path" and hit send. The agent picks up the correction and continues. You never left your workspace.

A system notification pops up: the deliberation finished. Both agents agreed the plan has a gap in error handling. You click through, read the synthesis, approve the updated plan. The system automatically starts the implementation phase with the revised plan.

You close forge, go to lunch. The implementation keeps running. When it hits the review gate, the daemon sends you a notification. You reopen forge, everything is where you left it.

## Non-Goals

- **General-purpose terminal emulator.** Use Ghostty, WezTerm, whatever you prefer for general terminal work. Forge's terminal is for quick manual tasks adjacent to agent work.
- **IDE replacement.** Forge doesn't edit files directly. Agents edit files. You review their work in forge and in your editor.
- **LLM API wrapper.** Forge uses Claude Agent SDK and Codex subprocess management. It doesn't implement its own LLM calling, tool execution, or prompt management.
- **Multi-user collaboration.** Single user, multiple agents. Not Google Docs for agents.

## Related Documents

- [01-architecture.md](./01-architecture.md) - System architecture and component boundaries
- [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) - Sessions-first data model
- [05-workspace-ux.md](./05-workspace-ux.md) - UI/UX design
