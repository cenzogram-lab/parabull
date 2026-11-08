/**
 * A minimal WebSocket server (RFC 6455) for the push stream: the indexer only ever sends text frames; from clients it
 * reads close and ping (answered with pong) and drops anything else. Client frames must be masked and small; a
 * misbehaving client is disconnected. A ping every 30 s keeps proxies from closing idle sockets, and a client that
 * can't keep up (more than 1 MB queued) is dropped rather than buffered without bound.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_CLIENT_FRAME = 4096;
const MAX_QUEUED = 1 << 20;

export interface WsConn {
  send(text: string): void;
  close(code?: number): void;
  readonly open: boolean;
  onClose(f: () => void): void;
}

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
  })()]);
  return Buffer.concat([head, payload]);
}

/** Completes the handshake and returns the connection, or answers 400 and returns null. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): WsConn | null {
  const key = req.headers["sec-websocket-key"];
  if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));

  let open = true;
  let buf = Buffer.alloc(0);
  const closers: (() => void)[] = [];
  const finish = () => {
    if (!open) return;
    open = false;
    clearInterval(ping);
    socket.destroy();
    for (const f of closers) f();
  };
  const write = (b: Buffer) => {
    if (!open) return;
    if ((socket as Duplex & { writableLength: number }).writableLength > MAX_QUEUED) return finish();
    socket.write(b);
  };
  const conn: WsConn = {
    send: (text) => write(frame(1, Buffer.from(text))),
    close: (code = 1000) => {
      if (!open) return;
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code);
      socket.write(frame(8, p));
      finish();
    },
    get open() {
      return open;
    },
    onClose: (f) => void closers.push(f),
  };
  const ping = setInterval(() => write(frame(9, Buffer.alloc(0))), 30_000);
  ping.unref?.();

  socket.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) return conn.close(1009);
      if (!masked || len > MAX_CLIENT_FRAME) return conn.close(1002);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return conn.close(1000);
      if (op === 9) write(frame(10, payload));
    }
  });
  socket.on("close", finish);
  socket.on("error", finish);
  return conn;
}
