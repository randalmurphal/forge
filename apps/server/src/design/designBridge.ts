type DesignBridgeResult = string;

export type DesignBridgeAction =
  | {
      readonly action: "render_design";
      readonly html: string;
      readonly title: string;
      readonly description?: string;
    }
  | {
      readonly action: "present_options";
      readonly prompt: string;
      readonly options: ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly description: string;
        readonly html: string;
      }>;
    };

type DesignBridgeHandler = (payload: DesignBridgeAction) => Promise<DesignBridgeResult>;

const designBridgeHandlers = new Map<string, DesignBridgeHandler>();

export const DESIGN_BRIDGE_ROUTE = "/api/internal/design/bridge";

export function registerDesignBridge(handler: DesignBridgeHandler): string {
  const token = crypto.randomUUID();
  designBridgeHandlers.set(token, handler);
  return token;
}

export function hasDesignBridge(token: string): boolean {
  return designBridgeHandlers.has(token);
}

export async function invokeDesignBridge(input: {
  readonly token: string;
  readonly action: DesignBridgeAction;
}): Promise<DesignBridgeResult> {
  const handler = designBridgeHandlers.get(input.token);
  if (!handler) {
    throw new Error(`Design bridge token was not found: ${input.token}`);
  }
  return handler(input.action);
}

export function removeDesignBridge(token: string): void {
  designBridgeHandlers.delete(token);
}
