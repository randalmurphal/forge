import assert from "node:assert/strict";

import { it } from "@effect/vitest";

import {
  FORGE_WS_METHODS,
  WS_METHODS,
  WsForgeChannelGetChannelRpc,
  WsForgeChannelGetMessagesRpc,
  WsForgeChannelInterveneRpc,
  WsForgeGateApproveRpc,
  WsForgeGateRejectRpc,
  WsForgePhaseOutputGetRpc,
  WsForgePhaseRunGetRpc,
  WsForgePhaseRunListRpc,
  WsForgeSessionGetChildrenRpc,
  WsForgeSessionGetTranscriptRpc,
  WsForgePhaseOutputUpdateRpc,
  WsForgeRequestResolveRpc,
  WsForgeThreadArchiveRpc,
  WsForgeThreadCancelRpc,
  WsForgeThreadCorrectRpc,
  WsForgeThreadCreateRpc,
  WsForgeThreadGetChildrenRpc,
  WsForgeThreadGetTranscriptRpc,
  WsForgeThreadPauseRpc,
  WsForgeThreadResumeRpc,
  WsForgeThreadSendTurnRpc,
  WsForgeThreadUnarchiveRpc,
  WsForgeWorkflowCreateRpc,
  WsForgeWorkflowGetRpc,
  WsForgeWorkflowListRpc,
  WsForgeWorkflowUpdateRpc,
  WsRpcGroup,
  WsSubscribeChannelMessageRpc,
  WsSubscribeChannelMessagesRpc,
  WsSubscribeWorkflowBootstrapRpc,
  WsSubscribeWorkflowEventsRpc,
  WsSubscribeWorkflowGateRpc,
  WsSubscribeWorkflowPhaseRpc,
  WsSubscribeWorkflowQualityChecksRpc,
} from "./rpc";

it("exports the staged Forge websocket method registry", () => {
  assert.deepStrictEqual(FORGE_WS_METHODS, {
    threadCreate: "thread.create",
    threadCorrect: "thread.correct",
    threadPause: "thread.pause",
    threadResume: "thread.resume",
    threadCancel: "thread.cancel",
    threadArchive: "thread.archive",
    threadUnarchive: "thread.unarchive",
    threadSendTurn: "thread.sendTurn",
    threadGetTranscript: "thread.getTranscript",
    threadGetChildren: "thread.getChildren",
    sessionGetTranscript: "session.getTranscript",
    sessionGetChildren: "session.getChildren",
    gateApprove: "gate.approve",
    gateReject: "gate.reject",
    requestResolve: "request.resolve",
    channelGetMessages: "channel.getMessages",
    channelGetChannel: "channel.getChannel",
    channelIntervene: "channel.intervene",
    phaseRunList: "phaseRun.list",
    phaseRunGet: "phaseRun.get",
    phaseOutputGet: "phaseOutput.get",
    phaseOutputUpdate: "phaseOutput.update",
    workflowList: "workflow.list",
    workflowGet: "workflow.get",
    workflowCreate: "workflow.create",
    workflowUpdate: "workflow.update",
    subscribeWorkflowEvents: "subscribeWorkflowEvents",
    subscribeChannelMessages: "subscribeChannelMessages",
    subscribeWorkflowPhase: "workflow.phase",
    subscribeWorkflowQualityChecks: "workflow.quality-check",
    subscribeWorkflowBootstrap: "workflow.bootstrap",
    subscribeWorkflowGate: "workflow.gate",
    subscribeChannelMessage: "channel.message",
  });
});

it("merges Forge websocket methods into the shared websocket registry", () => {
  assert.strictEqual(WS_METHODS.threadCreate, FORGE_WS_METHODS.threadCreate);
  assert.strictEqual(WS_METHODS.workflowGet, FORGE_WS_METHODS.workflowGet);
  assert.strictEqual(WS_METHODS.subscribeWorkflowEvents, FORGE_WS_METHODS.subscribeWorkflowEvents);
  assert.strictEqual(
    WS_METHODS.subscribeChannelMessages,
    FORGE_WS_METHODS.subscribeChannelMessages,
  );
  assert.strictEqual(WS_METHODS.sessionGetTranscript, FORGE_WS_METHODS.sessionGetTranscript);
  assert.strictEqual(WS_METHODS.phaseRunGet, FORGE_WS_METHODS.phaseRunGet);
});

it("exposes the staged push subscription RPC definitions", () => {
  assert.ok(WsSubscribeWorkflowEventsRpc);
  assert.ok(WsSubscribeChannelMessagesRpc);
  assert.ok(WsSubscribeWorkflowPhaseRpc);
  assert.ok(WsSubscribeWorkflowQualityChecksRpc);
  assert.ok(WsSubscribeWorkflowBootstrapRpc);
  assert.ok(WsSubscribeWorkflowGateRpc);
  assert.ok(WsSubscribeChannelMessageRpc);
});

it("exports the Forge websocket RPC definitions", () => {
  assert.ok(WsForgeThreadCreateRpc);
  assert.ok(WsForgeThreadCorrectRpc);
  assert.ok(WsForgeThreadPauseRpc);
  assert.ok(WsForgeThreadResumeRpc);
  assert.ok(WsForgeThreadCancelRpc);
  assert.ok(WsForgeThreadArchiveRpc);
  assert.ok(WsForgeThreadUnarchiveRpc);
  assert.ok(WsForgeThreadSendTurnRpc);
  assert.ok(WsForgeThreadGetTranscriptRpc);
  assert.ok(WsForgeThreadGetChildrenRpc);
  assert.ok(WsForgeSessionGetTranscriptRpc);
  assert.ok(WsForgeSessionGetChildrenRpc);
  assert.ok(WsForgeGateApproveRpc);
  assert.ok(WsForgeGateRejectRpc);
  assert.ok(WsForgeRequestResolveRpc);
  assert.ok(WsForgeChannelGetMessagesRpc);
  assert.ok(WsForgeChannelGetChannelRpc);
  assert.ok(WsForgeChannelInterveneRpc);
  assert.ok(WsForgePhaseRunListRpc);
  assert.ok(WsForgePhaseRunGetRpc);
  assert.ok(WsForgePhaseOutputGetRpc);
  assert.ok(WsForgePhaseOutputUpdateRpc);
  assert.ok(WsForgeWorkflowListRpc);
  assert.ok(WsForgeWorkflowGetRpc);
  assert.ok(WsForgeWorkflowCreateRpc);
  assert.ok(WsForgeWorkflowUpdateRpc);
});

it("registers workflow, phase, channel, and session rpc methods in the shared websocket RPC group", () => {
  const methods = new Set(WsRpcGroup.requests.keys());

  assert.ok(methods.has(WS_METHODS.subscribeWorkflowEvents));
  assert.ok(methods.has(WS_METHODS.subscribeChannelMessages));
  assert.ok(methods.has(WS_METHODS.subscribeWorkflowPhase));
  assert.ok(methods.has(WS_METHODS.subscribeWorkflowQualityChecks));
  assert.ok(methods.has(WS_METHODS.subscribeWorkflowBootstrap));
  assert.ok(methods.has(WS_METHODS.subscribeWorkflowGate));
  assert.ok(methods.has(WS_METHODS.subscribeChannelMessage));
  assert.ok(methods.has(WS_METHODS.sessionGetTranscript));
  assert.ok(methods.has(WS_METHODS.sessionGetChildren));
  assert.ok(methods.has(WS_METHODS.channelGetMessages));
  assert.ok(methods.has(WS_METHODS.channelGetChannel));
  assert.ok(methods.has(WS_METHODS.phaseRunList));
  assert.ok(methods.has(WS_METHODS.phaseRunGet));
  assert.ok(methods.has(WS_METHODS.phaseOutputGet));
  assert.ok(methods.has(WS_METHODS.workflowList));
  assert.ok(methods.has(WS_METHODS.workflowGet));
  assert.ok(methods.has(WS_METHODS.workflowCreate));
  assert.ok(methods.has(WS_METHODS.workflowUpdate));
  assert.ok(!methods.has(WS_METHODS.threadCreate));
  assert.ok(methods.has(WS_METHODS.threadGetTranscript));
  assert.ok(methods.has(WS_METHODS.threadGetChildren));
});
