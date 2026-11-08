/**
 * parabull-edge Worker entry: the request router (src/router.ts) and the ChatRoom and CalloutStore Durable Object
 * classes, which the runtime looks up by these export names (wrangler.toml [[durable_objects.bindings]]).
 */
import { handle, type Env } from "./router";

export { ChatRoom } from "./chatRoomDO";
export { CalloutStore } from "./calloutStoreDO";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env).catch((e) => {
      console.error("parabull-edge:", e);
      return new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    });
  },
};
