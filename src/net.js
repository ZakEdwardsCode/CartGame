// ============================================================================
// Online client: connection, clock sync with the server, and buffered
// interpolation of remote karts (rendered ~120 ms in the past so motion is
// smooth even with jittery packets).
// ============================================================================

const INTERP_DELAY = 120;
const SEND_HZ = 20;

export function defaultServerUrl() {
  const q = new URLSearchParams(location.search).get("server");
  if (q) return q;
  const cfg = window.C2C_CONFIG && window.C2C_CONFIG.server;
  if (cfg) return cfg;
  // same origin as the page, when the page is served by server.js
  if (location.protocol === "http:" || location.protocol === "https:") {
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  }
  return "";
}

export class NetClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.room = null;           // latest room snapshot
    this.offset = 0;            // serverTime ≈ Date.now() + offset
    this.bestRtt = Infinity;
    this.rtt = 0;
    this.remotes = new Map();   // id -> { name, color, buf: [{t, d}] }
    this.sendAcc = 0;
    this.connected = false;
  }

  connect(hello) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      this.ws = ws;
      const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error("Server didn't answer")); try { ws.close(); } catch {} } }, 8000);
      ws.onopen = () => {
        this.connected = true;
        this.ping();
        this.send({ t: "hello", ...hello });
      };
      ws.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === "welcome" && !settled) { settled = true; clearTimeout(to); resolve(m); }
        if (m.t === "err" && !settled) { settled = true; clearTimeout(to); reject(new Error(m.msg)); }
        this.onMessage(m);
      };
      ws.onclose = () => {
        this.connected = false;
        clearInterval(this.pingTimer);
        if (!settled) { settled = true; clearTimeout(to); reject(new Error("Couldn't connect")); }
        this.dispatchEvent(new CustomEvent("close"));
      };
      ws.onerror = () => {};
      this.pingTimer = setInterval(() => this.ping(), 2000);
    });
  }

  close() {
    clearInterval(this.pingTimer);
    if (this.ws) { try { this.send({ t: "leave" }); this.ws.close(); } catch {} }
    this.ws = null; this.connected = false; this.remotes.clear();
  }

  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  ping() { this.send({ t: "ping", c: Date.now() }); }
  serverNow() { return Date.now() + this.offset; }

  onMessage(m) {
    switch (m.t) {
      case "pong": {
        const t = Date.now(), rtt = t - m.c;
        this.rtt = rtt;
        // trust the sample with the lowest round trip
        if (rtt <= this.bestRtt * 1.2 || this.bestRtt === Infinity) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          const off = m.s - (m.c + rtt / 2);
          this.offset = this.bestRtt === Infinity ? off : this.offset * 0.7 + off * 0.3;
          if (!this._synced) { this.offset = off; this._synced = true; }
        }
        return;
      }
      case "welcome": this.id = m.id; this.offset = m.s - Date.now(); break;
      case "room": {
        this.room = m;
        for (const p of m.players) {
          if (p.id === this.id) continue;
          const r = this.remotes.get(p.id);
          if (r) { r.name = p.name; r.color = p.color; r.racing = p.racing; }
          else this.remotes.set(p.id, { id: p.id, name: p.name, color: p.color, racing: p.racing, buf: [] });
        }
        for (const id of [...this.remotes.keys()]) if (!m.players.some(p => p.id === id)) this.remotes.delete(id);
        break;
      }
      case "st": {
        const r = this.remotes.get(m.id);
        if (!r) return;
        r.buf.push({ t: m.ts, d: m.d });
        if (r.buf.length > 30) r.buf.shift();
        return;
      }
      case "left": this.remotes.delete(m.id); break;
    }
    this.dispatchEvent(new CustomEvent(m.t, { detail: m }));
  }

  // state of our kart, throttled to SEND_HZ
  sendState(dt, d) {
    this.sendAcc += dt;
    if (this.sendAcc < 1 / SEND_HZ) return;
    this.sendAcc = 0;
    this.send({ t: "st", d });
  }

  // interpolated snapshot of a remote at render time
  sample(r) {
    const b = r.buf;
    if (!b.length) return null;
    const t = this.serverNow() - INTERP_DELAY;
    if (t <= b[0].t) return b[0].d;
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].t <= t) {
        const a = b[i], c = b[i + 1];
        if (!c) {
          // extrapolate briefly from the last two samples
          const p = b[i - 1];
          const ex = Math.min(0.2, (t - a.t) / 1000);
          if (!p) return a.d;
          const span = Math.max(1, a.t - p.t) / 1000;
          return a.d.map((v, k) => k <= 2 ? v + (v - p.d[k]) / span * ex : v);
        }
        const f = (t - a.t) / Math.max(1, c.t - a.t);
        return a.d.map((v, k) => {
          if (k === 3) { // yaw: shortest way round
            let dd = c.d[k] - v; while (dd > Math.PI) dd -= 2 * Math.PI; while (dd < -Math.PI) dd += 2 * Math.PI;
            return v + dd * f;
          }
          return v + (c.d[k] - v) * f;
        });
      }
    }
    return b[b.length - 1].d;
  }
}

// state vector layout shared with the server relay
export const ST = { X: 0, Z: 1, Y: 2, YAW: 3, VX: 4, VY: 5, STEER: 6, PROG: 7, LAPS: 8, FLAGS: 9, R: 10 };
