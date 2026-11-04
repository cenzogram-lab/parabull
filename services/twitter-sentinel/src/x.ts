/**
 * Posting to X. `CookieX` signs in with the account's web session cookies (auth_token and ct0), the same way
 * elizaOS's client-twitter does, through agent-twitter-client: no X API keys, no API fees. `DryRunX` only logs.
 *
 * Cookie sessions are not X's official API. X can rate-limit or lock an account it sees automating through the web
 * client, and the cookies give full access to the account: keep accounts.json private and use a dedicated account.
 */
import { Scraper, SearchMode } from "agent-twitter-client";
import type { MentionTweet } from "./replies";

export interface XClient {
  readonly username: string;
  readonly live: boolean;
  /** Returns the new post's ID when X reports one. */
  post(text: string, inReplyTo?: string): Promise<string | null>;
  mentions(limit: number): Promise<MentionTweet[]>;
}

export interface XAccount {
  username: string;
  authToken: string;
  ct0: string;
  guestId?: string;
}

export class DryRunX implements XClient {
  readonly live = false;
  readonly sent: { text: string; inReplyTo?: string }[] = [];
  constructor(
    readonly username: string,
    private readonly log: (line: string) => void,
    private readonly fakeMentions: () => MentionTweet[] = () => [],
  ) {}
  async post(text: string, inReplyTo?: string) {
    this.sent.push({ text, inReplyTo });
    this.log(`[dry-run] @${this.username} ${inReplyTo ? `reply to ${inReplyTo}` : "post"}: ${text}`);
    return null;
  }
  async mentions() {
    return this.fakeMentions();
  }
}

export class CookieX implements XClient {
  readonly live = true;
  private readonly scraper = new Scraper();
  private ready: Promise<void> | null = null;
  readonly username: string;

  constructor(private readonly account: XAccount) {
    this.username = account.username.replace(/^@/, "");
  }

  private login(): Promise<void> {
    this.ready ??= (async () => {
      const cookie = (key: string, value: string) => `${key}=${value}; Domain=.twitter.com; Path=/; Secure; HttpOnly; SameSite=Lax`;
      const cookies = [cookie("auth_token", this.account.authToken), cookie("ct0", this.account.ct0)];
      if (this.account.guestId) cookies.push(cookie("guest_id", this.account.guestId));
      await this.scraper.setCookies(cookies);
      if (!(await this.scraper.isLoggedIn())) throw new Error(`X rejected the session cookies for @${this.username}; copy fresh auth_token and ct0 from a signed-in browser`);
    })().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  async post(text: string, inReplyTo?: string) {
    await this.login();
    const res = await this.scraper.sendTweet(text, inReplyTo);
    const body = (await res.json().catch(() => null)) as { errors?: { message?: string }[]; data?: { create_tweet?: { tweet_results?: { result?: { rest_id?: string } } } } } | null;
    if (body?.errors?.length) throw new Error(`X refused the post: ${body.errors.map((e) => e.message).join("; ")}`);
    return body?.data?.create_tweet?.tweet_results?.result?.rest_id ?? null;
  }

  async mentions(limit: number) {
    await this.login();
    // The same query elizaOS's interaction client uses for mentions.
    const { tweets } = await this.scraper.fetchSearchTweets(`@${this.username}`, limit, SearchMode.Latest);
    return tweets
      .filter((t) => t.id && t.text && t.username)
      .map((t) => ({ id: t.id!, text: t.text!, username: t.username!, timeMs: t.timeParsed ? t.timeParsed.getTime() : (t.timestamp ?? 0) * 1000, isRetweet: t.isRetweet }));
  }
}
