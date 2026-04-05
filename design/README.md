# Forge Design Documents

Planning documents for the forge project. These describe what we're building, how, and the challenges we expect to face. They are living documents - updated as we make decisions and discover new constraints.

## Reading Order

Start with the vision, then architecture and the sessions-first redesign (doc 13). The rest can be read in any order based on what you're working on.

| Document                                                         | Summary                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [00-vision.md](./00-vision.md)                                   | What forge is, what problem it solves, design principles                                                              |
| [01-architecture.md](./01-architecture.md)                       | System shape, component boundaries, communication patterns                                                            |
| [02-data-model.md](./02-data-model.md)                           | _(Superseded by doc 13)_ Tasks, workflows, phases, sessions, channels                                                 |
| [03-effect-removal.md](./03-effect-removal.md)                   | Effect.js decision: keeping it, patterns for new code                                                                 |
| [04-workflow-engine.md](./04-workflow-engine.md)                 | Phase execution, gates, loops, built-in workflows                                                                     |
| [05-workspace-ux.md](./05-workspace-ux.md)                       | Sidebar, session views, notifications, keyboard shortcuts                                                             |
| [06-agent-integration.md](./06-agent-integration.md)             | Claude/Codex agents, channel tools, corrections, context                                                              |
| [07-daemon-mode.md](./07-daemon-mode.md)                         | Background execution, socket API, CLI, notifications                                                                  |
| [08-deliberation.md](./08-deliberation.md)                       | Multi-agent patterns from HerdingLlamas                                                                               |
| [09-open-questions.md](./09-open-questions.md)                   | Cross-cutting decisions, research needed, future ideas                                                                |
| [10-schemas.md](./10-schemas.md)                                 | _(Schemas superseded by doc 13)_ Startup sequence, shutdown policy, state ownership, quality checks, daemon transport |
| [11-channel-tool-contract.md](./11-channel-tool-contract.md)     | MCP integration (Claude), turn injection (Codex), idempotency, liveness                                               |
| [12-channel-chat-mode.md](./12-channel-chat-mode.md)             | Standalone deliberation chat, pattern templates, promotion to sessions                                                |
| [13-sessions-first-redesign.md](./13-sessions-first-redesign.md) | Sessions-first redesign: extending the thread model with workflows, channels, child threads                           |

## Sequencing

Not everything can be built at once. Here's the dependency order:

**Foundation (extend existing codebase):**

1. Extend thread model with new columns/tables for workflows, channels, child threads (13)
2. Basic workspace UI (05) - session sidebar + session view

**Core features (build on foundation):** 3. Workflow engine (04) - phases, gates, basic loops 4. Correction system (06) - guidance channels, context injection 5. Notifications (07) - OS-native, in-app

**Advanced features (build on core):** 6. Deliberation (08) - multi-agent, channel tools 7. Channel system and deliberation (11, 12) 8. Daemon mode (07) - background execution, socket API, CLI 9. Build loop workflow (04) - quality checks, iteration context

**Polish (after core works):** 10. Workflow editor UI (05) 11. Workflow templates and customization 12. Cost tracking and budget controls 13. Agent recovery and replay

## Conventions

Each document follows this structure:

- **What/why**: What is this about and why it matters
- **Design**: The proposed approach with enough detail to implement
- **Challenges**: What's hard, what could go wrong, what we're unsure about
- **Open questions**: Decisions that need answers before or during implementation

Documents reference each other by filename. Open questions that span multiple documents live in [09-open-questions.md](./09-open-questions.md).
