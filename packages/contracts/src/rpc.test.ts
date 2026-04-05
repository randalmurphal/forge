import assert from "node:assert/strict";

import { it } from "@effect/vitest";

import {
  FORGE_WS_METHODS,
  WS_METHODS,
  WsForgeChannelGetMessagesRpc,
  WsForgeChannelInterveneRpc,
  WsForgeGateApproveRpc,
  WsForgeGateRejectRpc,
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
  WsForgeWorkflowGetRpc,
  WsForgeWorkflowListRpc,
  WsRpcGroup,
  WsSubscribeChannelMessagesRpc,
  WsSubscribeWorkflowEventsRpc,
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
    gateApprove: "gate.approve",
    gateReject: "gate.reject",
    requestResolve: "request.resolve",
    channelGetMessages: "channel.getMessages",
    channelIntervene: "channel.intervene",
    phaseOutputUpdate: "phaseOutput.update",
    workflowList: "workflow.list",
    workflowGet: "workflow.get",
    subscribeWorkflowEvents: "subscribeWorkflowEvents",
    subscribeChannelMessages: "subscribeChannelMessages",
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
});

it("exposes the staged push subscription RPC definitions", () => {
  assert.ok(WsSubscribeWorkflowEventsRpc);
  assert.ok(WsSubscribeChannelMessagesRpc);
});

it("exports the staged Forge websocket RPC definitions without widening the live rpc group", () => {
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
  assert.ok(WsForgeGateApproveRpc);
  assert.ok(WsForgeGateRejectRpc);
  assert.ok(WsForgeRequestResolveRpc);
  assert.ok(WsForgeChannelGetMessagesRpc);
  assert.ok(WsForgeChannelInterveneRpc);
  assert.ok(WsForgePhaseOutputUpdateRpc);
  assert.ok(WsForgeWorkflowListRpc);
  assert.ok(WsForgeWorkflowGetRpc);
});

it("registers staged push subscriptions in the shared websocket RPC group", () => {
  const methods = new Set(WsRpcGroup.requests.keys());

  assert.ok(methods.has(WS_METHODS.subscribeWorkflowEvents));
  assert.ok(methods.has(WS_METHODS.subscribeChannelMessages));
  assert.ok(!methods.has(WS_METHODS.threadCreate));
  assert.ok(!methods.has(WS_METHODS.threadGetTranscript));
  assert.ok(!methods.has(WS_METHODS.channelGetMessages));
  assert.ok(!methods.has(WS_METHODS.workflowGet));
});
