/**
 * The CalloutStore Durable Object class (one instance, named CALLOUT_STORE; see wrangler.toml). A thin shell over
 * CalloutStoreCore (src/callouts.ts), which the tests drive directly with node:sqlite.
 */
import { DurableObject } from "cloudflare:workers";
import { CalloutStoreCore } from "./callouts";
import type { SqlStorage } from "./chatRoom";

export class CalloutStore extends DurableObject {
  private readonly core: CalloutStoreCore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.core = new CalloutStoreCore(ctx.storage as unknown as { sql: SqlStorage }, {
      now: () => Date.now(),
      randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }
}
