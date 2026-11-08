/**
 * WHIP (WebRTC-HTTP Ingestion Protocol) publishing, as Cloudflare Stream takes it for browser broadcasts: POST the
 * SDP offer to the live input's webRTC URL, apply the SDP answer, and DELETE the session resource (the Location
 * header) to stop. Browser-only (RTCPeerConnection); exercised end to end in the broadcast browser test.
 */

export interface WhipSession {
  pc: RTCPeerConnection;
  /** Ends the broadcast: closes the connection and deletes the WHIP session. */
  stop(): Promise<void>;
}

/** Waits for ICE gathering to finish (Cloudflare's WHIP takes a complete offer), at most `ms`. */
function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    pc.addEventListener("icegatheringstatechange", check);
    window.setTimeout(done, ms);
  });
}

export async function publishWhip(url: string, stream: MediaStream, opts: { iceServers?: RTCIceServer[]; fetchImpl?: typeof fetch } = {}): Promise<WhipSession> {
  const f = opts.fetchImpl ?? fetch;
  const pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
  try {
    for (const track of stream.getTracks()) pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 2_000);
    const res = await f(url, { method: "POST", headers: { "content-type": "application/sdp" }, body: pc.localDescription!.sdp });
    if (res.status !== 201 && res.status !== 200) throw new Error(`The stream server refused the broadcast (${res.status})`);
    const answer = await res.text();
    const location = res.headers.get("location");
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
    const resource = location ? new URL(location, url).href : null;
    return {
      pc,
      async stop() {
        pc.getSenders().forEach((s) => s.track?.stop());
        pc.close();
        if (resource) await f(resource, { method: "DELETE" }).catch(() => undefined);
      },
    };
  } catch (e) {
    pc.close();
    throw e;
  }
}
