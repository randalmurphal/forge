# Architecture

## System Shape

Forge is a desktop application with an optional headless daemon mode. The application is a single process that runs a Node.js backend server and an Electron shell hosting a React frontend. The daemon mode runs the same backend without the Electron shell, for fire-and-forget execution.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Forge Desktop (Electron)                     │
│                                                                  │
│  ┌──────────────────────────────┐  ┌──────────────────────────┐ │
│  │       React Frontend         │  │    Electron Shell        │ │
│  │                              │  │                          │ │
│  │  Workspace sidebar           │  │  Native notifications    │ │
│  │  Session views               │  │  File dialogs            │ │
│  │  Terminal (xterm.js)         │  │  System tray (daemon)    │ │
│  │  Channel/deliberation views  │  │  Window management       │ │
│  │  Workflow status             │  │  OS integration          │ │
│  │  Correction input            │  │                          │ │
│  └──────────┬───────────────────┘  └──────────────────────────┘ │
│             │ WebSocket                                          │
│  ┌──────────▼───────────────────────────────────────────────────┐│
│  │                    Node.js Backend                            ││
│  │                                                               ││
│  │  ┌─────────────┐ ┌──────────────┐ ┌───────────────────────┐ ││
│  │  │  Workflow    │ │   Provider   │ │  Session Manager      │ ││
│  │  │  Engine      │ │   Agents     │ │                       │ ││
│  │  │              │ │              │ │   Lifecycle, state,    │ ││
│  │  │  Phases      │ │  Claude SDK  │ │   persistence         │ ││
│  │  │  Gates       │ │  Codex sub.  │ │                       │ ││
│  │  │  Channels    │ │  Multi-agent │ │                       │ ││
│  │  └──────────────┘ └──────────────┘ └───────────────────────┘ ││
│  │                                                               ││
│  │  ┌─────────────┐ ┌──────────────┐ ┌───────────────────────┐ ││
│  │  │  Terminal    │ │ Notification │ │   Persistence         │ ││
│  │  │  Manager     │ │ Dispatch     │ │                       │ ││
│  │  │              │ │              │ │   SQLite (events,     │ ││
│  │  │  PTY mgmt    │ │  OS native   │ │   sessions, channels, │ ││
│  │  │  xterm.js    │ │  In-app      │ │   transcripts,        │ ││
│  │  │              │ │  Socket API  │ │   workflows)          │ ││
│  │  └──────────────┘ └──────────────┘ └───────────────────────┘ ││
│  └──────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Component Boundaries

### Frontend (apps/web)

React + Zustand. Communicates with backend exclusively via WebSocket (typed JSON-RPC requests + push events). Owns:

- All rendering and interaction
- Client-side state derived from server push events
- No direct provider/agent communication
- No direct filesystem access

The frontend is a view. It renders what the backend tells it and sends user actions back. All orchestration decisions happen server-side.

### Backend (apps/server)

Node.js process. Owns:

- **Session lifecycle**: create, assign workflow, track phase progression, persist state
- **Workflow engine**: phase execution, gate evaluation, channel management
- **Provider agents**: Claude Agent SDK, Codex subprocess management
- **Terminal management**: PTY spawning, I/O multiplexing
- **Persistence**: SQLite for events, sessions, channels, transcripts
- **Notification dispatch**: emit events that Electron translates to OS notifications
- **Socket API**: JSON-RPC over Unix socket for external tool integration (CLI, scripts, orc daemon)

### Desktop (apps/desktop)

Electron shell. Minimal. Owns:

- Spawning the backend server process
- Hosting the React app in a BrowserWindow
- Native OS integration (notifications, file dialogs, system tray)
- IPC bridge between frontend and native APIs

### Contracts (packages/contracts)

Shared TypeScript types and schemas. No runtime logic. Defines:

- Session, workflow, phase, channel, agent types
- WebSocket protocol (requests, push events, channels)
- Provider event schemas
- Notification schemas

### Daemon Mode

Same backend binary, no Electron. Runs as a background process. Communicates via:

- Socket API (same JSON-RPC protocol as internal WebSocket)
- OS notifications (via platform-native APIs: terminal-notifier on macOS, notify-send on Linux)
- On Electron app open, daemon hands off state seamlessly

See [07-daemon-mode.md](./07-daemon-mode.md) for details.

## Communication Patterns

### Frontend <-> Backend: WebSocket

Typed protocol inheriting t3-code's pattern:

- **Requests**: `{ id, method, params }` -> `{ id, result }` or `{ id, error }`
- **Push events**: `{ channel, sequence, data }` with monotonic ordering

Push event channels are defined in [13-sessions-first-redesign.md](./13-sessions-first-redesign.md). The canonical set is: `session.event`, `session.bootstrap`, `agent.event`, `channel.message`, `request.event`, `notification.event`.

### Backend <-> Providers: Direct Integration

- **Claude**: `@anthropic-ai/claude-agent-sdk` in-process. Direct function calls, event streams via async iterables.
- **Codex**: Subprocess over JSON-RPC on stdio. Same pattern as t3-code's `CodexAppServerManager`.

### Backend <-> External Tools: Socket API

Unix domain socket with JSON-RPC protocol. Enables:

- CLI commands (`forge status`, `forge correct <session-id> "message"`)
- Script integration (CI triggers, monitoring)
- orc daemon coordination (if daemon mode uses a separate process)

## Data Flow: User Sends Correction

```
User types correction in UI
  -> Frontend sends WebSocket request: { method: "channel.postMessage", params: { sessionId, content } }
  -> Backend receives, validates
  -> Backend persists message to channel in SQLite
  -> Backend evaluates: is there an active agent for this session?
    -> Yes: inject correction into agent context on next turn
  -> Backend emits push event: { channel: "channel.message", data: { sessionId, message } }
  -> Frontend updates channel view
  -> On next agent turn, correction appears in context
  -> Agent response reflects correction
  -> Backend streams agent output as agent events
  -> Frontend renders updated conversation
```

## Data Flow: Two-Agent Deliberation

```
User starts deliberation workflow on a session
  -> Backend creates two child sessions with asymmetric role prompts
  -> Backend creates shared deliberation channel
  -> Agent A posts to channel (via tool call intercepted by backend)
  -> Backend persists message, notifies Agent B
  -> Agent B reads channel, responds
  -> Cycle continues until:
     a) Both agents signal conclusion
     b) Max turns reached
     c) User intervenes with correction or termination
  -> Backend synthesizes findings
  -> If part of larger workflow: proceeds to next phase
  -> If standalone: presents synthesis to user
```

## Key Differences from t3-code

Forge extends t3-code's existing thread infrastructure. The thread model stays, Effect.js stays. New features are additive.

| Aspect                | t3-code                          | Forge (additive)                                                                                                             |
| --------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Primary unit          | Thread (conversation)            | Thread stays as-is; "session" is the user-facing term. Workflows, channels, child threads are new capabilities built on top. |
| Orchestration         | Event-sourced thread lifecycle   | Same event sourcing, extended with workflow lifecycle (phases, gates, loops)                                                 |
| Provider interactions | One per thread                   | One per thread (agent sessions) or many child threads per phase (workflow sessions)                                          |
| Multi-agent           | Not supported                    | First-class (deliberation, review) via child threads and channels                                                            |
| Human interaction     | Chat messages before/after turns | Corrections mid-session, gate approvals (new features)                                                                       |
| Background execution  | None (requires app open)         | Daemon mode with OS notifications (new feature)                                                                              |
| DI framework          | Effect.js                        | Effect.js stays — new services are Effect Layers following existing patterns                                                 |
| State management      | Thread-centric Zustand           | Extended with workflow/channel state alongside existing thread state                                                         |

## Challenges

### Effect.js integration

Effect.js stays. New workflow, channel, and deliberation services are written as Effect Layers following existing patterns (services as Layers, commands through OrchestrationEngine dispatch, event handling through projectors, background work through reactors). See [03-effect-removal.md](./03-effect-removal.md) for the decision and approach.

### Event sourcing extensions

t3-code's event sourcing uses Effect's Queue, Stream, and Layer primitives. The decider/projector pattern is pure and stays as-is. New event types (workflow phases, channels, deliberation) extend the existing aggregate. The runtime (OrchestrationEngine) remains Effect-native.

### Provider adapter statefulness

Claude and Codex adapters maintain complex in-memory state (turn state, pending approvals, prompt queues). This state needs to survive provider crashes and app restarts. t3-code partially handles this via event replay, but gaps exist. Forge needs robust session recovery.

### WebSocket protocol evolution

t3-code's push channels are thread-centric. Forge needs session-centric and channel-centric push events. The protocol needs to evolve while maintaining the typed decode/validate pattern at boundaries.

## Resolved Decisions

1. **RESOLVED: Single process for v1.** See doc 13.

2. **RESOLVED: Same JSON-RPC 2.0 protocol over different transports.** Daemon hosts both WebSocket (for app) and Unix socket (for CLI). See doc 13.

3. **RESOLVED: See doc 06 Provider Recovery Matrix and doc 13 startup sequence.**

## Related Documents

- [00-vision.md](./00-vision.md) - What we're building and why
- [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) - Sessions-first data model
- [03-effect-removal.md](./03-effect-removal.md) - Effect.js decision and patterns
- [07-daemon-mode.md](./07-daemon-mode.md) - Background execution
