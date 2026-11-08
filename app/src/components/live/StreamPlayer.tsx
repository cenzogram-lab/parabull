/**
 * Cloudflare Stream live player: a <video> fed by hls.js (loaded on demand, the light build: live video and audio,
 * no subtitles or DRM), or by the browser's own HLS where there is no Media Source Extensions (iOS Safari).
 *
 * - Starts muted (browsers only autoplay muted video) with a "Tap to unmute" pill; play/pause, mute, live badge and
 *   fullscreen controls (44px on a phone).
 * - A manifest that fails (the broadcast ended or hasn't started, or the network dropped) shows "Stream offline" and
 *   is retried every 10 seconds; a decode error is recovered in place.
 * - Only ever loads `src` (the caller builds it from VITE_STREAM_HOST; the CSP allows that host and nothing else).
 */
import { Loader2, Maximize, Pause, Play, Radio, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../ui/primitives";

type PlayerState = "loading" | "playing" | "paused" | "offline" | "unsupported";
const RETRY_MS = 10_000;

export function StreamPlayer({ src, title, poster, className }: { src: string; title: string; poster?: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<PlayerState>("loading");
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let cancelled = false;
    let retry: number | undefined;
    let destroy = () => {};
    setState("loading");

    const start = async () => {
      const { default: Hls } = await import("hls.js/light");
      if (cancelled) return;
      if (Hls.isSupported()) {
        const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
        destroy = () => hls.destroy();
        hls.on(Hls.Events.MANIFEST_PARSED, () => void v.play().catch(() => setState("paused")));
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
          // The manifest or segments can't be had: offline (or a network drop). Try again shortly.
          setState("offline");
          window.clearTimeout(retry);
          retry = window.setTimeout(() => {
            hls.loadSource(src);
            hls.startLoad();
          }, RETRY_MS);
        });
        hls.loadSource(src);
        hls.attachMedia(v);
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        const load = () => {
          v.src = src;
          void v.play().catch(() => setState("paused"));
        };
        const onError = () => {
          setState("offline");
          window.clearTimeout(retry);
          retry = window.setTimeout(load, RETRY_MS);
        };
        v.addEventListener("error", onError);
        destroy = () => v.removeEventListener("error", onError);
        load();
      } else setState("unsupported");
    };
    void start();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      destroy();
      v.removeAttribute("src");
      v.load();
    };
  }, [src]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };
  const toggleMute = () => {
    const v = video.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };
  const fullscreen = () => {
    const el = box.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => undefined);
    if (el?.requestFullscreen) return void el.requestFullscreen().catch(() => undefined);
    // iPhone: only the video element itself can go fullscreen.
    v?.webkitEnterFullscreen?.();
  };

  const btn = "flex h-9 w-9 items-center justify-center rounded-lg bg-canvas/70 text-cream backdrop-blur transition-colors hover:bg-canvas/90 max-md:h-11 max-md:w-11";
  return (
    <div ref={box} className={cx("group relative overflow-hidden bg-black", className)} data-stream-player data-state={state}>
      <video
        ref={video}
        className="aspect-video h-full w-full object-contain"
        poster={poster}
        muted={muted}
        autoPlay
        playsInline
        aria-label={`${title} (live)`}
        onPlaying={() => setState("playing")}
        onPause={() => setState((s) => (s === "offline" ? s : "paused"))}
        onClick={toggle}
      />

      {(state === "loading" || state === "offline" || state === "unsupported") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas/60 px-6 text-center" role="status">
          {state === "loading" ? (
            <>
              <Loader2 className="h-6 w-6 animate-spin text-gold" aria-hidden />
              <span className="text-[13px] text-muted">Connecting to the stream…</span>
            </>
          ) : state === "offline" ? (
            <>
              <Radio className="h-6 w-6 text-muted" aria-hidden />
              <span className="text-[14px] font-semibold text-cream">Stream offline</span>
              <span className="text-[12.5px] text-muted">Waiting for the broadcast. Trying again every few seconds.</span>
            </>
          ) : (
            <span className="text-[13px] text-muted">This browser can't play live video.</span>
          )}
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2">
        <span className={cx("inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide", state === "playing" ? "bg-candle-down text-cream shadow-[inset_0_0_0_1px_#B5503A]" : "bg-canvas/80 text-muted")}>
          <span className={cx("h-1.5 w-1.5 rounded-full", state === "playing" ? "animate-pulse bg-ember" : "bg-muted")} aria-hidden />
          Live
        </span>
      </div>

      {state === "playing" && muted && (
        <button type="button" onClick={toggleMute} className="absolute right-3 top-3 inline-flex h-9 items-center gap-1.5 rounded-full bg-canvas/80 px-3 text-xs font-semibold text-cream backdrop-blur max-md:h-11">
          <VolumeX className="h-4 w-4" aria-hidden /> Tap to unmute
        </button>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-3 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        <button type="button" onClick={toggle} className={btn} aria-label={state === "playing" ? "Pause" : "Play"} disabled={state === "offline" || state === "unsupported"}>
          {state === "playing" ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
        </button>
        <button type="button" onClick={toggleMute} className={btn} aria-label={muted ? "Unmute" : "Mute"} aria-pressed={!muted}>
          {muted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
        </button>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-cream/90">{title}</span>
        <button type="button" onClick={fullscreen} className={btn} aria-label="Full screen">
          <Maximize className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
