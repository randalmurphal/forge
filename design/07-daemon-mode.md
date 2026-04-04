# Daemon Mode

## What This Solves

You start a build-loop session. It's going to take 30 minutes across multiple iterations. You close your laptop or switch to another project. Without daemon mode, the agent dies and you lose everything. With daemon mode, the backend keeps running. The agent continues working. When it hits a gate that needs you, your phone buzzes (or your desktop notifies you). You come back, open forge, and everything is where you left it.

Fire-and-forget requires a process that outlives the UI.

## Architecture

The forge backend (Node.js process) can run in two modes:

### App mode (default)
Electron spawns the backend. Backend serves WebSocket to Electron's renderer. When Electron closes, backend stops.

### Daemon mode
Backend runs independently as a background process. No Electron. Communicates via:
- **Socket API**: JSON-RPC over Unix domain socket for CLI tools and the app
- **OS notifications**: Platform-native for attention-needed events
- **App reconnection**: When Electron opens, it discovers the running daemon and connects

```
Daemon Mode:

  forge daemon (background process)
    ├── Workflow engine (running sessions, phases, gates)
    ├── Provider agents (Claude SDK, Codex subprocesses)
    ├── SQLite persistence (events, sessions, transcripts)
    ├── Socket API (Unix domain socket)
    │     ├── CLI: `forge status`, `forge correct <session-id> "message"`
    │     └── App: Electron connects on open
    └── Notification dispatch
          ├── macOS: terminal-notifier or osascript
          ├── Linux: notify-send (libnotify)
          └── Windows/WSL: PowerShell toast

  forge app (Electron, optional)
    ├── Discovers daemon via socket
    ├── Connects via WebSocket (or socket API)
    ├── Renders UI from daemon state
    └── Closes without stopping daemon
```

### Lifecycle

```
User starts forge:
  1. Check if daemon is already running (socket exists + responds to ping)
  2. If daemon running:
     a. App connects to daemon
     b. Hydrates state from daemon
     c. Resumes where user left off
  3. If no daemon:
     a. Start backend in app mode (Electron owns the process)
     b. User can "detach" to daemon mode (backend continues, Electron can close)

User closes forge app:
  1. If sessions are running:
     a. Prompt: "Sessions are still running. Keep running in background?"
     b. If yes: detach to daemon mode (backend stays alive)
     c. If no: pause all sessions, stop backend
  2. If no sessions running:
     a. Stop backend

User runs `forge daemon start`:
  1. Start backend in daemon mode (no Electron)
  2. Write PID file and socket path
  3. Available for CLI and app connections
```

### Daemon Lifecycle Model

The daemon is ALWAYS a separate process. There is no "detach from Electron" — the daemon either exists independently or it doesn't.

**App mode (no daemon running):**
1. User opens Electron app
2. App checks for running daemon (flock/PID/ping) — none found
3. App spawns daemon as a DETACHED background process (not a child)
4. App connects to daemon via WebSocket
5. On app quit: daemon continues running (it was never a child)

**App mode (daemon already running):**
1. User opens Electron app
2. App discovers running daemon via daemon.json
3. App connects to daemon via WebSocket
4. On app quit: daemon continues running

**Daemon-only mode (CLI start):**
1. `forge daemon start` spawns the daemon process
2. CLI tools connect via Unix socket
3. App can connect later

This eliminates the "detach" transition entirely. The daemon is either running or it isn't. The app never owns the daemon's lifecycle — it's a client, not a parent. This prevents:
- Race conditions during detach
- Double-backend scenarios
- stdout/log routing ambiguity
- Auto-updater competing with running daemon

**Auto-update contract:** When a new version is installed, the daemon must be restarted. The app detects version skew (daemon reports its version on connect), shows 'Daemon restart required', and the user triggers `forge daemon restart` (or the app does it automatically with user confirmation). Running sessions are interrupted and recovered on restart.

### Singleton Discovery and Socket Ownership

Only one forge daemon may own ~/.forge/forge.sock at a time.

**Discovery algorithm on startup:**
1. Acquire exclusive flock on `~/.forge/forge.lock`
2. Check if `~/.forge/forge.pid` exists
3. If PID exists and process alive: try `daemon.ping` on socket
   - Ping succeeds → daemon is running, connect as client
   - Ping fails → process wedged, kill it, remove PID + socket, start fresh
4. If PID exists and process dead: remove stale PID + socket, start fresh
5. If no PID: start fresh
6. On fresh start: bind socket (0600 permissions), write PID file, release flock

**Stale socket recovery:** The flock prevents races between two processes trying to bind simultaneously. The loser blocks on flock, re-runs discovery, and connects to the winner's socket.

### Daemon Auth for App Reconnect

The daemon generates a random auth token at startup and writes it to `~/.forge/daemon.json`:

```json
{
  "pid": 12345,
  "wsPort": 47829,
  "wsToken": "<random-256-bit-hex>",
  "socketPath": "~/.forge/forge.sock",
  "startedAt": "2026-04-03T20:00:00Z"
}
```

File permissions: 0600 (owner-only). On app startup, after daemon discovery (flock/PID/ping), the app reads daemon.json for both port and token, then connects to `ws://127.0.0.1:{wsPort}/?token={wsToken}`.

Token rotation: new token on each daemon startup, never reused. Stale daemon.json (PID dead) is deleted and regenerated on fresh start.

The daemon hosts BOTH transports: WebSocket on 127.0.0.1:{port} for the app renderer, and Unix socket at ~/.forge/forge.sock for CLI tools. Port discovery uses daemon.json. The renderer connects to WebSocket exactly as the current t3-code app does — the only change is reading the URL from daemon.json instead of receiving it via Electron IPC.

**Desktop single-instance:** Use Electron's `requestSingleInstanceLock()`. Second instance sends argv to first via `second-instance` event, then exits. First instance focuses window and processes the command.

**Protocol handler:** Use Electron's `setAsDefaultProtocolClient('forge')`. On `open-url` event, parse `forge://session/{id}` and navigate to that session in the UI. This enables notification click-through: OS notification → `forge://session/47` → app focuses and shows session 47.

## Socket API

The socket API is the contract between daemon, CLI, and app. JSON-RPC over Unix domain socket.

```typescript
// Socket path: ~/.forge/forge.sock (configurable)

interface SocketAPI {
  // Health
  "daemon.ping": () => { status: "ok"; uptime: number }
  "daemon.stop": () => void

  // Sessions (see doc 13 Socket API → Command Mapping for full enrichment)
  "session.list": () => Session[]
  "session.get": (params: { sessionId: string }) => Session
  "session.create": (params: { title: string; type: string; workflow?: string; projectPath: string }) => Session
  "session.pause": (params: { sessionId: string }) => void
  "session.resume": (params: { sessionId: string }) => void
  "session.cancel": (params: { sessionId: string }) => void

  // Corrections and channel interaction
  "session.correct": (params: { sessionId: string; content: string }) => void
  "channel.intervene": (params: { channelId: string; content: string }) => void

  // Gates
  "gate.approve": (params: { sessionId: string; phaseRunId: string }) => void
  "gate.reject": (params: { sessionId: string; phaseRunId: string; reason?: string }) => void

  // Interactive requests
  "request.resolve": (params: { requestId: string; resolution: Record<string, unknown> }) => void

  // Events (subscription)
  "events.subscribe": (params: { filter?: EventFilter }) => AsyncIterable<ForgeEvent>

  // Child sessions
  "session.getChildren": (params: { sessionId: string }) => Session[]
  "session.getTranscript": (params: { sessionId: string; limit?: number }) => TranscriptEntry[]
}
```

### CLI Commands

```bash
# Daemon management
forge daemon start           # start daemon in background
forge daemon stop            # stop daemon gracefully
forge daemon status          # show daemon status, running sessions

# Session management
forge list                   # list all sessions with status
forge status [session-id]    # detailed session status
forge create "title" --type workflow --workflow build-loop --project . --model claude:claude-sonnet-4-5
forge pause <session-id>
forge resume <session-id>
forge cancel <session-id>

# Interaction
forge correct <session-id> 'message'            # post correction to guidance channel -> session.correct
forge approve <session-id>                     # approve current gate -> gate.approve
forge reject <session-id> "reason"             # reject current gate -> gate.reject
forge answer <request-id> --input '...'        # resolve interactive request -> request.resolve
forge bootstrap-retry <session-id>             # retry failed bootstrap -> find pending request -> request.resolve { action: 'retry' }
forge bootstrap-skip <session-id>              # skip bootstrap -> find pending request -> request.resolve { action: 'skip' }
forge intervene <channel-id> 'message'         # post to deliberation channel -> channel.intervene

# Monitoring
forge watch                  # live-updating session status (like htop)
forge logs <session-id>      # stream transcript output
forge events                 # stream all events (for scripting)
```

The CLI is a thin client over the socket API. Every CLI command maps to one or more socket API calls.

## Notification Dispatch

### Notification Safety

Notifications MUST use argv-based process spawning (execFile/spawn with argument arrays), NOT shell string interpolation. User-derived content (session titles, error messages) can contain quotes, backticks, dollar signs, and newlines that would break shell commands.

Platform probing order:
1. macOS: check for `terminal-notifier` in PATH -> `osascript` fallback
2. Linux: check for `notify-send` in PATH
3. If no notifier found: log warning, in-app badge/toast only

Failure semantics: notification dispatch failure is NEVER fatal. Log the error, fall back to in-app notification. The daemon continues operating regardless of notification backend availability.

### Platform-specific implementations

All implementations use argv arrays. Never pass user content through a shell.

```typescript
interface NotificationDispatcher {
  send(notification: ForgeNotification): Promise<void>
}

// macOS
class MacOSNotificationDispatcher implements NotificationDispatcher {
  async send(n: ForgeNotification): Promise<void> {
    // Option 1: terminal-notifier (if installed)
    // Option 2: osascript via execFile with argv array (NOT shell interpolation)
    await execFile('osascript', [
      '-e', `display notification ${JSON.stringify(n.body)} with title ${JSON.stringify(n.title)} subtitle ${JSON.stringify(n.subtitle)}`
    ])
  }
}

// Linux
class LinuxNotificationDispatcher implements NotificationDispatcher {
  async send(n: ForgeNotification): Promise<void> {
    await execFile('notify-send', [n.title, n.body, '--icon=forge'])
  }
}
```

v1: macOS + Linux only. The Electron app on Windows uses in-app notifications only (no daemon mode, no OS notifications).

### What triggers notifications

| Event | Notification? | Default |
|-------|--------------|---------|
| Session needs attention (gate, error) | Yes | On |
| Session completed | Yes | On |
| Deliberation concluded | Yes | On |
| Phase transition | Optional | Off |
| Agent posted to channel | Optional | Off |
| Token budget warning | Yes | On |
| Daemon started/stopped | Optional | Off |

### Click-to-focus
When a notification is clicked, it should open forge app and navigate to the relevant session. Implementation:
- macOS: use `terminal-notifier -execute "forge open <session-id>"` or URL scheme `forge://session/<session-id>`
- Linux: notification action with `forge open <session-id>` command
- URL scheme registration in Electron for `forge://` protocol

## Challenges

### Provider session persistence across daemon restarts
If the daemon crashes, Claude SDK child sessions are lost (in-memory). Codex child sessions may survive (subprocess). Recovery:
- Transcript is in SQLite. Can replay as context for a new child session.
- But replaying a long transcript is expensive (tokens, time).
- Alternative: checkpoint child session state periodically (serialize the key context, not every message).
- Need clear recovery semantics: "child session was interrupted, resuming from last checkpoint with context summary."

### Resource management
A daemon running multiple child sessions consumes:
- Memory: Claude SDK sessions, Codex subprocesses, SQLite connections
- CPU: minimal (mostly waiting on I/O)
- Network: LLM API calls
- Disk: transcript storage, git worktrees

Need resource limits:
- Max concurrent child sessions (configurable, default 3?)
- Max total memory (monitor and warn)
- Disk cleanup for completed session worktrees

### App-daemon handoff
When the app connects to a running daemon, it needs to hydrate state:
1. Fetch all sessions and their current state
2. Subscribe to event stream
3. Replay any events that happened while app was disconnected
4. Resume rendering where the user left off

This is similar to t3-code's `server.welcome` pattern but more complex because the daemon may have processed many events while the app was away. Need efficient state transfer (snapshot + delta), not full event replay.

### Multiple app instances
What if the user opens forge on two monitors? Or opens the app while the CLI is also connected?
- Multiple readers are fine (all see the same state).
- Multiple writers need conflict resolution (two corrections at the same time).
- Simplest: last-write-wins for corrections, serialize gate approvals.
- For v1: support one app + one CLI, but design the socket API for multiple clients.

### Daemon discovery
The app needs to find the daemon. Options:
- Well-known socket path (`~/.forge/forge.sock`)
- PID file (`~/.forge/forge.pid`)
- Socket + PID: check PID file exists, process is alive, socket responds to ping

Need to handle stale PID files (process crashed, PID file left behind).

## Open Questions

1. **Should the daemon auto-start?** When the user opens the app, should it always start a daemon (that persists after app close)? Or should daemon mode be explicit (`forge daemon start`)? Auto-start is more seamless but may surprise users with background processes.

2. **Daemon auto-shutdown?** When all sessions are complete and no agents are running, should the daemon shut itself down? Or stay alive waiting for new work? Probably: shut down after configurable idle timeout (default 30 minutes).

3. **How does the daemon interact with shell environment?** Agents need environment variables (PATH, API keys, node versions). The daemon inherits the environment from where it was started. If started from the app, it gets the app's environment. If started from CLI, it gets the shell's environment. These might differ. Need a way to configure the execution environment explicitly.

4. **Should the daemon manage git worktrees?** Creating and cleaning up worktrees is a side effect that could conflict with the user's manual git operations. Need clear ownership: daemon creates worktrees in a known location (`~/.forge/worktrees/` or `.forge/worktrees/` in the project), cleans up on session completion. Never touches the user's main working tree.

5. **System service integration?** Should forge support running as a systemd service (Linux) or launchd agent (macOS)? This provides auto-start on login, crash recovery, and log management. But adds packaging complexity. Probably a stretch goal.

## Related Documents

- [01-architecture.md](./01-architecture.md) - System architecture
- [06-agent-integration.md](./06-agent-integration.md) - Provider session lifecycle
