import assert from "node:assert/strict";

import { it } from "@effect/vitest";

import {
  FORGE_WS_METHODS,
  WS_METHODS,
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

it("registers staged push subscriptions in the shared websocket RPC group", () => {
  const methods = new Set(WsRpcGroup.requests.keys());

  assert.ok(methods.has(WS_METHODS.subscribeWorkflowEvents));
  assert.ok(methods.has(WS_METHODS.subscribeChannelMessages));
});
