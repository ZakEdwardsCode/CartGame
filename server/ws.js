// ============================================================================
// Minimal RFC 6455 WebSocket server on Node built-ins (no dependencies).
// Text frames only, which is all the game protocol uses. Handles fragmented
// messages, ping/pong, close, and a payload size cap.
// ============================================================================

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 64 * 1024;

export class WSConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.open = true;
    this.lastSeen = Date.now();
    socket.setNoDelay(true);
    socket.on("data", d => this._onData(d));
    socket.on("close", () => this._closed());
    socket.on("error", () => this._closed());
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit("close");
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2);
        if (hi !== 0) return this.close(1009);
        len = b.readUInt32BE(6); off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      if (!masked) return this.close(1002);           // clients must mask
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (op === 0x8) { this.close(1000); return; }
      if (op === 0x9) { this._send(0xA, data); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.fragments.push(data);
        if (!fin) {
          if (this.fragments.reduce((s, f) => s + f.length, 0) > MAX_PAYLOAD) return this.close(1009);
          continue;
        }
        const msg = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.emit("message", msg);
        continue;
      }
      return this.close(1002);
    }
  }

  _send(op, payload) {
    if (!this.open) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    head[0] = 0x80 | op;
    try { this.socket.write(Buffer.concat([head, payload])); } catch { this._closed(); }
  }

  send(text) { this._send(0x1, Buffer.from(text, "utf8")); }
  ping() { this._send(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code, 0);
    this._send(0x8, p);
    this.open = false;
    try { this.socket.end(); } catch {}
    setTimeout(() => { try { this.socket.destroy(); } catch {} }, 1000);
    this.emit("close");
  }
}

// Attach to an http.Server. onConnection(ws) is called for each upgrade on `path`.
export function attachWebSocket(server, path, onConnection) {
  server.on("upgrade", (req, socket) => {
    const url = (req.url || "").split("?")[0];
    const key = req.headers["sec-websocket-key"];
    if (url !== path || !key || (req.headers.upgrade || "").toLowerCase() !== "websocket") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    onConnection(new WSConnection(socket, req));
  });
}
