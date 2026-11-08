/**
 * The few Workers runtime types src/chatRoomDO.ts and src/index.ts use, declared here so the package needs no
 * @cloudflare/workers-types dependency. The tests never load these modules: they drive ChatRoomCore and the router.
 */
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

interface DurableObjectState {
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void;
  /** The object's storage; its `sql` (SQLite) is what ChatRoomCore and CalloutStoreCore use. */
  storage: unknown;
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}
