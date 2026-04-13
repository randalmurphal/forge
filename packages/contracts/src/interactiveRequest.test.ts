import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  InteractiveRequest,
  InteractiveRequestPayload,
  InteractiveRequestResolution,
} from "./interactiveRequest";

const decodeInteractiveRequestPayload = Schema.decodeUnknownEffect(InteractiveRequestPayload);
const decodeInteractiveRequestResolution = Schema.decodeUnknownEffect(InteractiveRequestResolution);
const decodeInteractiveRequest = Schema.decodeUnknownEffect(InteractiveRequest);

it.effect("decodes each interactive request payload variant", () =>
  Effect.gen(function* () {
    const approval = yield* decodeInteractiveRequestPayload({
      type: "approval",
      requestType: " file_change_approval ",
      detail: "Need write access to edit a file",
      toolName: " apply_patch ",
      toolInput: {
        path: "/tmp/file.ts",
      },
      suggestions: ["Write:/src/**"],
    });
    const userInput = yield* decodeInteractiveRequestPayload({
      type: "user-input",
      questions: [
        {
          id: " branch ",
          header: " Branch ",
          question: "Which branch should be used?",
          options: [
            {
              label: " main ",
              description: " Main branch ",
            },
            {
              label: " develop ",
              description: " Development branch ",
            },
          ],
        },
      ],
    });
    const permission = yield* decodeInteractiveRequestPayload({
      type: "permission",
      reason: "Need broader workspace access",
      permissions: {
        network: {
          enabled: true,
        },
        fileSystem: {
          read: ["/tmp/project/src"],
          write: ["/tmp/project/out"],
        },
      },
    });
    const mcpElicitation = yield* decodeInteractiveRequestPayload({
      type: "mcp-elicitation",
      mode: "form",
      serverName: " workspace ",
      message: "Choose the sandbox mode",
      meta: {
        source: "forge",
      },
      requestedSchema: {
        type: "object",
      },
      questions: [
        {
          id: " sandbox_mode ",
          header: " Sandbox ",
          question: " Which mode should be used? ",
          options: [
            {
              label: " workspace-write ",
              description: " Allow workspace writes only ",
            },
          ],
        },
      ],
      turnId: " turn-1 ",
    });
    const gate = yield* decodeInteractiveRequestPayload({
      type: "gate",
      gateType: " human-approval ",
      phaseRunId: " phase-run-1 ",
      phaseOutput: "Ready to continue",
      qualityCheckResults: [
        {
          check: " lint ",
          passed: true,
          output: "ok",
        },
      ],
    });
    const bootstrapFailed = yield* decodeInteractiveRequestPayload({
      type: "bootstrap-failed",
      error: "Install failed",
      stdout: "command output",
      command: " bun install ",
    });
    const correctionNeeded = yield* decodeInteractiveRequestPayload({
      type: "correction-needed",
      reason: "Tests failed",
      context: "Fix the failing spec",
    });

    assert.deepStrictEqual(approval, {
      type: "approval",
      requestType: "file_change_approval",
      detail: "Need write access to edit a file",
      toolName: "apply_patch",
      toolInput: {
        path: "/tmp/file.ts",
      },
      suggestions: ["Write:/src/**"],
    });
    assert.deepStrictEqual(userInput, {
      type: "user-input",
      questions: [
        {
          id: "branch",
          header: "Branch",
          question: "Which branch should be used?",
          options: [
            {
              label: "main",
              description: "Main branch",
            },
            {
              label: "develop",
              description: "Development branch",
            },
          ],
        },
      ],
    });
    assert.deepStrictEqual(permission, {
      type: "permission",
      reason: "Need broader workspace access",
      permissions: {
        network: {
          enabled: true,
        },
        fileSystem: {
          read: ["/tmp/project/src"],
          write: ["/tmp/project/out"],
        },
      },
    });
    assert.deepStrictEqual(mcpElicitation, {
      type: "mcp-elicitation",
      mode: "form",
      serverName: "workspace",
      message: "Choose the sandbox mode",
      meta: {
        source: "forge",
      },
      requestedSchema: {
        type: "object",
      },
      questions: [
        {
          id: "sandbox_mode",
          header: "Sandbox",
          question: "Which mode should be used?",
          options: [
            {
              label: "workspace-write",
              description: "Allow workspace writes only",
            },
          ],
        },
      ],
      turnId: "turn-1",
    });
    assert.deepStrictEqual(gate, {
      type: "gate",
      gateType: "human-approval",
      phaseRunId: "phase-run-1",
      phaseOutput: "Ready to continue",
      qualityCheckResults: [
        {
          check: "lint",
          passed: true,
          output: "ok",
        },
      ],
    });
    assert.deepStrictEqual(bootstrapFailed, {
      type: "bootstrap-failed",
      error: "Install failed",
      stdout: "command output",
      command: "bun install",
    });
    assert.deepStrictEqual(correctionNeeded, {
      type: "correction-needed",
      reason: "Tests failed",
      context: "Fix the failing spec",
    });
  }),
);

it.effect("decodes each interactive request resolution variant", () =>
  Effect.gen(function* () {
    const approval = yield* decodeInteractiveRequestResolution({
      decision: "acceptForSession",
      updatedPermissions: ["Write:/src/**"],
    });
    const userInput = yield* decodeInteractiveRequestResolution({
      answers: {
        branch: "main",
        targets: ["web", "server"],
      },
    });
    const permission = yield* decodeInteractiveRequestResolution({
      scope: "session",
      permissions: {
        network: {
          enabled: true,
        },
      },
    });
    const mcpElicitation = yield* decodeInteractiveRequestResolution({
      action: "accept",
      content: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
      meta: {
        source: "forge",
      },
    });
    const gate = yield* decodeInteractiveRequestResolution({
      decision: "reject",
      correction: "Address the failing checks first",
    });
    const bootstrapFailed = yield* decodeInteractiveRequestResolution({
      action: "retry",
    });
    const correctionNeeded = yield* decodeInteractiveRequestResolution({
      correction: "Add the missing migration",
    });

    assert.deepStrictEqual(approval, {
      decision: "acceptForSession",
      updatedPermissions: ["Write:/src/**"],
    });
    assert.deepStrictEqual(userInput, {
      answers: {
        branch: "main",
        targets: ["web", "server"],
      },
    });
    assert.deepStrictEqual(permission, {
      scope: "session",
      permissions: {
        network: {
          enabled: true,
        },
      },
    });
    assert.deepStrictEqual(mcpElicitation, {
      action: "accept",
      content: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
      meta: {
        source: "forge",
      },
    });
    assert.deepStrictEqual(gate, {
      decision: "reject",
      correction: "Address the failing checks first",
    });
    assert.deepStrictEqual(bootstrapFailed, {
      action: "retry",
    });
    assert.deepStrictEqual(correctionNeeded, {
      correction: "Add the missing migration",
    });
  }),
);

it.effect("decodes interactive request entities with typed payload and resolution", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeInteractiveRequest({
      id: " request-1 ",
      threadId: " thread-1 ",
      childThreadId: " child-thread-1 ",
      phaseRunId: " phase-run-1 ",
      type: "gate",
      status: "resolved",
      payload: {
        type: "gate",
        gateType: " human-approval ",
        phaseRunId: " phase-run-1 ",
        phaseOutput: "Looks good",
      },
      resolvedWith: {
        decision: "approve",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-01T00:05:00.000Z",
    });

    assert.deepStrictEqual(parsed, {
      id: "request-1",
      threadId: "thread-1",
      childThreadId: "child-thread-1",
      phaseRunId: "phase-run-1",
      type: "gate",
      status: "resolved",
      payload: {
        type: "gate",
        gateType: "human-approval",
        phaseRunId: "phase-run-1",
        phaseOutput: "Looks good",
      },
      resolvedWith: {
        decision: "approve",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: "2026-01-01T00:05:00.000Z",
    });
  }),
);
