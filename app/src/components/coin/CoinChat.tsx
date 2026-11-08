/**
 * A coin's live chat (hooks/useChatRoom.ts): the replayed history and new messages, the reader count, and a composer
 * gated on the wallet. Without a wallet the composer is a "Connect wallet to chat" button; a wallet that can't sign
 * messages is told so; otherwise the first post asks the wallet to sign in to the chat once. Images and GIFs upload
 * to the edge Worker (R2) and go out as attachments.
 * Used by the coin page's Chat tab (desktop and phone) and the /live spotlight.
 */
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ImagePlus, Loader2, MessageSquare, Send, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useChatRoom } from "../../hooks/useChatRoom";
import { useNow } from "../../hooks/useNow";
import { CHAT_MAX_ATTACHMENTS, CHAT_MAX_CHARS, shortWallet, type ChatMessage } from "../../lib/chatMessage";
import { age, compact } from "../../lib/format";
import { MAX_IMAGE_BYTES } from "../../lib/metadata";
import { cx } from "../ui/primitives";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

function Message({ m, mine }: { m: ChatMessage; mine: boolean }) {
  const now = useNow();
  return (
    <li className="text-[13px] leading-5" data-chat-message>
      <span className={cx("font-semibold", mine ? "text-gold" : "text-copper")} title={m.author}>
        {shortWallet(m.author)}
        {mine && <span className="ml-1 rounded bg-gold/15 px-1 text-[10px] font-bold uppercase tracking-wide">you</span>}
      </span>{" "}
      <span className="text-[11px] text-muted">{age(Math.max(0, now - m.ts))}</span>
      {m.text && <p className="whitespace-pre-wrap break-words text-cream/90">{m.text}</p>}
      {m.attachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {m.attachments.map((a) => (
            <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line">
              <img src={a.url} alt={a.kind === "gif" ? "GIF" : "Image"} loading="lazy" className="max-h-40 max-w-[220px] object-contain" />
            </a>
          ))}
        </div>
      )}
    </li>
  );
}

export function CoinChat({ mint, className, header = true }: { mint: string; className?: string; header?: boolean }) {
  const room = useChatRoom(mint);
  const { setVisible } = useWalletModal();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const pinned = useRef(true);
  const file = useRef<HTMLInputElement>(null);
  const now = useNow();
  const [localError, alertError] = useState<string | null>(null);
  const length = [...text].length;
  const cooling = room.cooldownUntil > now;

  // Stay at the bottom while the reader is there; leave them be once they scroll up.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [room.messages]);
  useEffect(() => setPending([]), [mint]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (sending || (!text.trim() && pending.length === 0)) return;
    setSending(true);
    const ok = await room.send(text, pending);
    setSending(false);
    if (ok) {
      setText("");
      setPending([]);
      pinned.current = true;
    }
  };

  const attach = async (f: File | undefined) => {
    if (file.current) file.current.value = "";
    if (!f) return;
    room.clearError();
    if (f.size > MAX_IMAGE_BYTES) return void alertError("Images are at most 5 MB");
    setUploading(true);
    try {
      const url = await room.upload(f);
      setPending((p) => (p.includes(url) ? p : [...p, url].slice(0, CHAT_MAX_ATTACHMENTS)));
    } catch (err) {
      alertError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const error = localError ?? room.error;
  useEffect(() => alertError(null), [text, pending.length]);

  const off = room.status === "off";
  const open = room.status === "open";
  return (
    <section aria-label="Live chat" className={cx("flex min-h-0 flex-col", className)}>
      {header && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-[13.5px] font-semibold">
          <MessageSquare className="h-4 w-4 text-copper" aria-hidden /> Live chat
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-normal text-muted" aria-live="polite">
            <span className={cx("h-1.5 w-1.5 rounded-full", open ? "bg-gold" : off ? "bg-line" : "animate-pulse bg-copper")} aria-hidden />
            {off ? "Not connected" : open ? (room.online !== null ? `${compact(room.online)} in chat` : "Connected") : room.status === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
      )}

      <ul
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3"
        aria-label="Messages"
      >
        {off ? (
          <li className="py-6 text-center text-[13px] text-muted">Live chat isn't connected in this build.</li>
        ) : room.messages.length === 0 ? (
          <li className="py-6 text-center text-[13px] text-muted">{open ? "No messages yet. Say gm." : "Loading chat…"}</li>
        ) : (
          room.messages.map((m) => <Message key={m.id} m={m} mine={!!room.wallet && m.author === room.wallet} />)
        )}
      </ul>

      {!off && (
        <div className="border-t border-line p-3">
          {!room.wallet ? (
            <button type="button" onClick={() => setVisible(true)} className="btn-gold h-10 w-full text-sm max-md:h-11">
              Connect wallet to chat
            </button>
          ) : !room.canSign ? (
            <p className="text-center text-[12.5px] text-muted">This wallet can't sign messages, so it can't post here. Reading works.</p>
          ) : (
            <form onSubmit={submit}>
              {pending.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {pending.map((url) => (
                    <span key={url} className="relative">
                      <img src={url} alt="Attachment" className="h-12 w-12 rounded-lg border border-line object-cover" />
                      <button type="button" onClick={() => setPending((p) => p.filter((u) => u !== url))} aria-label="Remove attachment" className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-canvas text-muted ring-1 ring-line hover:text-cream">
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => file.current?.click()}
                  disabled={uploading || pending.length >= CHAT_MAX_ATTACHMENTS}
                  className="btn-icon h-10 w-10 shrink-0 border border-line disabled:opacity-50 max-md:h-11 max-md:w-11"
                  aria-label="Attach an image or GIF"
                >
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ImagePlus className="h-4 w-4" aria-hidden />}
                </button>
                <input ref={file} type="file" accept={ACCEPT} className="hidden" onChange={(e) => void attach(e.target.files?.[0])} />
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={room.signedInAs === room.wallet ? "Say something" : "Say something (your wallet signs in once)"}
                  aria-label="Message"
                  className="input h-10 min-w-0 flex-1 text-sm max-md:h-11 max-md:text-[16px]"
                  enterKeyHint="send"
                />
                <button
                  type="submit"
                  disabled={sending || cooling || !open || length > CHAT_MAX_CHARS || (!text.trim() && pending.length === 0)}
                  className="btn-gold h-10 w-10 shrink-0 disabled:opacity-50 max-md:h-11 max-md:w-11"
                  aria-label="Send message"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                </button>
              </div>
              <div className="mt-1.5 flex min-h-4 items-center gap-2 text-[11.5px]">
                <span className={cx("min-w-0 flex-1 truncate", error ? "text-ember" : "text-muted")} role={error ? "alert" : undefined}>
                  {error ?? (room.signingIn ? "Sign the message in your wallet to start chatting…" : !open ? "Reconnecting…" : room.signedInAs === room.wallet ? `Chatting as ${shortWallet(room.wallet)}` : "")}
                </span>
                {length > CHAT_MAX_CHARS - 40 && <span className={cx("num shrink-0", length > CHAT_MAX_CHARS ? "text-ember" : "text-muted")}>{CHAT_MAX_CHARS - length}</span>}
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
