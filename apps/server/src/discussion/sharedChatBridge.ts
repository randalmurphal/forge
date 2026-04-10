type SharedChatBridgeResult = {
  readonly content: string;
  readonly success: boolean;
};

type SharedChatBridgeHandler = (input: {
  readonly message: string;
}) => Promise<SharedChatBridgeResult>;

const sharedChatBridgeHandlers = new Map<string, SharedChatBridgeHandler>();

export const SHARED_CHAT_BRIDGE_ROUTE = "/api/internal/discussion/shared-chat/post";

export function registerSharedChatBridge(handler: SharedChatBridgeHandler): string {
  const token = crypto.randomUUID();
  sharedChatBridgeHandlers.set(token, handler);
  return token;
}

export function hasSharedChatBridge(token: string): boolean {
  return sharedChatBridgeHandlers.has(token);
}

export async function invokeSharedChatBridge(input: {
  readonly token: string;
  readonly message: string;
}): Promise<SharedChatBridgeResult> {
  const handler = sharedChatBridgeHandlers.get(input.token);
  if (!handler) {
    return {
      content: "Shared chat bridge token was not found.",
      success: false,
    };
  }

  return await handler({ message: input.message });
}

export function removeSharedChatBridge(token: string): void {
  sharedChatBridgeHandlers.delete(token);
}
