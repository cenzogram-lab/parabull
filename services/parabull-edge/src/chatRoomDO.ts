/**
 * The ChatRoom Durable Object class Cloudflare instantiates (one per coin mint, see wrangler.toml). A thin shell over
 * ChatRoomCore (src/chatRoom.ts): it supplies the runtime pieces (WebSocketPair, the 101 response, the clock) and
 * forwards the Hibernation API handlers, which the runtime calls on a fresh instance after the object wakes.
 */
import { DurableObject } from "cloudflare:workers";
import { ChatRoomCore, type RoomEnv, type RoomSocket, type RoomState } from "./chatRoom";

export class ChatRoom extends DurableObject<RoomEnv> {
  private readonly core: ChatRoomCore;

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    // Keepalive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.core = new ChatRoomCore(ctx as unknown as RoomState, env, {
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      newPair: () => {
        const pair = new WebSocketPair();
        return { client: pair[0], server: pair[1] as unknown as RoomSocket };
      },
      // Workers' ResponseInit takes the client end of the pair; Node's typings don't know the field.
      upgradeResponse: (client) => new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit),
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.core.webSocketMessage(ws as unknown as RoomSocket, message);
  }

  webSocketClose(ws: WebSocket, code: number): void {
    this.core.webSocketClose(ws as unknown as RoomSocket, code);
  }

  webSocketError(ws: WebSocket): void {
    this.core.webSocketError(ws as unknown as RoomSocket);
  }
}
