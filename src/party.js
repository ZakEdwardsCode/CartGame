// ============================================================================
// Parties: race your friends with a 4-letter code and no game server.
//
// Two ways to connect, picked automatically:
//  * inside Claude (the published artifact): Claude's live "room" — everyone
//    who has the page open and joins the same code;
//  * anywhere else (GitHub Pages, itch.io...): direct phone-to-phone WebRTC,
//    introduced by the free public PeerJS broker. The party's creator is the
//    hub and relays everyone's state.
//
// Each player publishes one small state object (name, colour, ready, kart
// state, laps, finish). The creator also publishes the race (id, start time,
// laps, grid). Every client derives the lobby, start, finishes and results
// from those, and PartyNet presents them through the same interface as the
// server-based NetClient, so the game code doesn't care which it is using.
// ============================================================================

import { NetClient } from "./net.js";

const PEERJS = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
const START_DELAY = 6500;      // ms from "start" to green light
const FINISH_GRACE = 45000;
const RESULTS_HOLD = 12000;

// Everything another player's device sends is untrusted: normalise it once,
// here, before any of it reaches the game or the page.
const cleanName = n => String(n ?? "").replace(/[\u0000-\u001f<>&"'`]/g, "").trim().slice(0, 16) || "Driver";
const cleanColor = c => /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#888888";
const cleanInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || 0));
const cleanMs = v => (typeof v === "number" && isFinite(v) && v > 0 && v < 3.6e6) ? Math.round(v) : null;
function cleanState(st) {
  if (!st || typeof st !== "object" || !st.n) return null;
  const out = {
    n: cleanName(st.n), c: cleanColor(st.c), no: cleanInt(st.no, 0, 99), rd: !!st.rd,
    lp: cleanInt(st.lp, 0, 99), b: cleanMs(st.b), f: cleanMs(st.f),
    rid: typeof st.rid === "string" ? st.rid.slice(0, 16) : null,
    L: cleanInt(st.L, 1, 10), host: !!st.host,
    kt: typeof st.kt === "number" && isFinite(st.kt) ? st.kt : 0,
    k: Array.isArray(st.k) ? st.k.slice(0, 16).map(v => (typeof v === "number" && isFinite(v) && Math.abs(v) < 1e5) ? v : 0) : null,
  };
  const h = st.h;
  if (h && typeof h === "object" && typeof h.rid === "string" && Array.isArray(h.grid) && typeof h.at === "number" && isFinite(h.at)) {
    const now = Date.now();
    // a race start more than 30 s ahead or 30 min old is nonsense: ignore it
    if (h.at < now + 30000 && h.at > now - 1.8e6) {
      out.h = {
        rid: h.rid.slice(0, 16), at: h.at, laps: cleanInt(h.laps, 1, 10),
        grid: h.grid.slice(0, 16).filter(id => typeof id === "string").map(id => id.slice(0, 64)),
      };
    }
  }
  return out;
}

export function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// --------------------------------------------------------------------------
// transport: Claude live room
// --------------------------------------------------------------------------
class RoomTransport {
  static async create() {
    if (!window.claude || !window.claude.use) return null;
    try { const ns = await window.claude.use("room"); return ns ? new RoomTransport(ns) : null; } catch { return null; }
  }
  constructor(ns) { this.ns = ns; this.room = null; this.myId = null; this.kind = "room"; }
  async open(code) {
    this.room = await this.ns.join("party-" + code.toLowerCase());
    // our own peer label appears in the room's list shortly after joining
    for (let i = 0; i < 50 && !this.myId; i++) {
      const me = this.room.peers().find(p => p.sameTab);
      if (me) this.myId = me.peer; else await new Promise(r => setTimeout(r, 100));
    }
    if (!this.myId) throw new Error("Couldn't join the party room");
  }
  setState(patch) { return this.room.presence(patch).catch(() => {}); }
  list() {
    return this.room.peers().filter(p => p.kind === "viewer")
      .map(p => ({ id: p.peer, isMe: p.sameTab, state: p.presence || {} }));
  }
  onChange(fn) { return this.room.onPeers(fn, () => this.onClosed && this.onClosed()); }
  close() { try { this.room && this.room.leave(); } catch {} }
}

// --------------------------------------------------------------------------
// transport: WebRTC via PeerJS (host relays)
// --------------------------------------------------------------------------
function loadPeerJS() {
  if (window.Peer) return Promise.resolve(window.Peer);
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = PEERJS;
    s.onload = () => window.Peer ? res(window.Peer) : rej(new Error("Party service didn't load"));
    s.onerror = () => rej(new Error("Party service didn't load — check your connection"));
    document.head.appendChild(s);
  });
}

class PeerTransport {
  constructor() { this.kind = "webrtc"; this.states = new Map(); this.mine = {}; this.conns = new Map(); this.listeners = []; }
  static create() { return typeof RTCPeerConnection === "function" ? new PeerTransport() : null; }

  async open(code, isHost) {
    const Peer = await loadPeerJS();
    const hostId = "c2ckart-" + code.toLowerCase();
    this.isHost = isHost;
    this.peer = await new Promise((res, rej) => {
      const p = isHost ? new Peer(hostId) : new Peer();
      const to = setTimeout(() => rej(new Error("The party service didn't answer")), 12000);
      p.on("open", () => { clearTimeout(to); res(p); });
      p.on("error", e => {
        clearTimeout(to);
        rej(new Error(e.type === "unavailable-id" ? "code-taken" : e.type === "network" || e.type === "server-error" ? "Couldn't reach the party service" : (e.message || e.type)));
      });
    });
    this.myId = this.peer.id;
    this.peer.on("error", e => { if (e.type === "peer-unavailable" && this._joinReject) this._joinReject(new Error(`No party called ${code}`)); });
    this.peer.on("disconnected", () => { try { this.peer.reconnect(); } catch {} });
    if (isHost) {
      this.peer.on("connection", conn => {
        conn.on("data", m => {
          if (!m || !m.p || typeof m.p !== "object") return;
          if (!this.conns.has(conn.peer) && this.conns.size >= 15) { conn.close(); return; }   // party full
          const st = cleanState(m.p);
          if (!st) return;
          st.host = false; delete st.h;           // only the host itself can be host
          this.states.set(conn.peer, st); this.conns.set(conn.peer, conn); this.emit();
        });
        conn.on("close", () => { this.states.delete(conn.peer); this.conns.delete(conn.peer); this.emit(); });
        conn.on("error", () => {});
      });
      this.timer = setInterval(() => {
        const all = { [this.myId]: this.mine };
        for (const [id, st] of this.states) all[id] = st;
        for (const c of this.conns.values()) if (c.open) { try { c.send({ all }); } catch {} }
      }, 50);
    } else {
      await new Promise((res, rej) => {
        this._joinReject = rej;
        const conn = this.peer.connect(hostId, { reliable: false });
        const to = setTimeout(() => rej(new Error(`No party called ${code}`)), 12000);
        conn.on("open", () => { clearTimeout(to); this.conn = conn; res(); });
        conn.on("data", m => {
          if (!m || !m.all || typeof m.all !== "object") return;
          this.states = new Map(Object.entries(m.all).filter(([id]) => id !== this.myId));
          this.emit();
        });
        conn.on("close", () => this.onClosed && this.onClosed());
        conn.on("error", () => {});
      });
      this.timer = setInterval(() => { if (this.conn && this.conn.open) { try { this.conn.send({ p: this.mine }); } catch {} } }, 50);
    }
  }
  setState(patch) {
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete this.mine[k]; else this.mine[k] = v; }
    this.emit();
  }
  list() {
    const out = [{ id: this.myId, isMe: true, state: this.mine }];
    for (const [id, st] of this.states) out.push({ id, isMe: false, state: st });
    return out;
  }
  onChange(fn) { this.listeners.push(fn); }
  emit() { for (const f of this.listeners) f(); }
  close() {
    clearInterval(this.timer);
    try { this.conn && this.conn.close(); } catch {}
    try { this.peer && this.peer.destroy(); } catch {}
  }
}

// --------------------------------------------------------------------------
// PartyNet: the NetClient interface on top of a transport
// --------------------------------------------------------------------------
export class PartyNet extends NetClient {
  constructor() {
    super("");
    this.transport = null;
    this.code = "";
    this.isHost = false;
    this.mine = {};
    this.seenRid = null;
    this.raceInfo = null;
    this.announced = new Set();
    this.firstFinAt = 0;
    this.resultsFor = null;
    this.resultsAt = 0;
    this.autoAt = 0;
    this.known = new Map();          // id -> name, for joined/left toasts
    this.lastKt = new Map();
    this.lastRoomJson = "";
    this.myNo = 1 + Math.floor(Math.random() * 98);
    this.lastHostSeen = Date.now();
  }

  serverNow() { return Date.now(); }

  // hello = { name, color, room: "new" | CODE }
  async connect(hello) {
    let t = await RoomTransport.create();
    if (!t) t = PeerTransport.create();
    if (!t) throw new Error("This browser can't do party play");
    this.isHost = hello.room === "new";
    let code = this.isHost ? newCode() : String(hello.room).toUpperCase();
    for (let tries = 0; ; tries++) {
      try { await t.open(code, this.isHost); break; }
      catch (e) {
        if (e.message === "code-taken" && tries < 4) { code = newCode(); continue; }
        try { t.close(); } catch {}
        throw e;
      }
    }
    if (t.kind === "room" && this.isHost && t.list().some(p => !p.isMe && p.state && p.state.host)) {
      // someone is already hosting under this code: take a fresh one
      t.close();
      return this.connect(hello);
    }
    this.transport = t;
    this.code = code;
    this.id = t.myId;
    this.connected = true;
    this.mine = { n: String(hello.name || "Driver").slice(0, 16), c: hello.color, no: this.myNo, rd: false, lp: 0, b: null, f: null, rid: null, L: 3 };
    if (this.isHost) this.mine.host = true;
    t.setState(this.mine);
    t.onClosed = () => this.lost();
    t.onChange(() => this.refresh());
    this.timer = setInterval(() => this.refresh(), 100);
    this.refresh();
    return { id: this.id, room: code, private: true, s: Date.now() };
  }

  lost() {
    if (!this.connected) return;
    this.connected = false;
    clearInterval(this.timer);
    this.dispatchEvent(new CustomEvent("close"));
  }

  close() {
    clearInterval(this.timer);
    this.connected = false;
    if (this.transport) this.transport.close();
    this.transport = null;
    this.remotes.clear();
  }

  set(patch) { Object.assign(this.mine, patch); if (this.transport) this.transport.setState(patch); }

  send(m) {
    switch (m.t) {
      case "st": this.set({ k: m.d, kt: Date.now() }); return;
      case "ready": this.set({ rd: !!m.v }); this.refresh(); return;
      case "laps": if (this.isHost) { this.set({ L: m.n }); this.refresh(); } return;
      case "start": if (this.isHost) this.startRace(); return;
      case "lap": {
        const r = this.raceInfo;
        if (!r) return;
        const lp = (this.mine.lp || 0) + 1;
        const ms = Math.round(Number(m.ms));
        const b = this.mine.b == null || ms < this.mine.b ? ms : this.mine.b;
        const patch = { lp, b };
        if (lp >= r.laps && this.mine.f == null) patch.f = Date.now() - r.at;
        this.set(patch);
        this.refresh();
        return;
      }
      case "leave": this.close(); return;
    }
  }

  startRace() {
    const ids = this.transport.list().filter(p => p.state && p.state.n).map(p => p.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    this.set({ h: { rid: Math.random().toString(36).slice(2, 9), at: Date.now() + START_DELAY, laps: this.mine.L || 3, grid: ids } });
    this.autoAt = 0;
    this.refresh();
  }

  refresh() {
    const t = this.transport;
    if (!t) return;
    const now = Date.now();
    const peers = t.list().map(p => ({ id: String(p.id).slice(0, 64), isMe: p.isMe, state: cleanState(p.state) })).filter(p => p.state);
    const host = peers.find(p => p.state.host);
    if (host) this.lastHostSeen = now;
    else if (!this.isHost && now - this.lastHostSeen > 6000) { this.lost(); return; }

    // --- remote karts
    for (const p of peers) {
      if (p.isMe) continue;
      const st = p.state;
      let r = this.remotes.get(p.id);
      if (!r) {
        r = { id: p.id, name: st.n, color: st.c, no: st.no, racing: false, buf: [] };
        this.remotes.set(p.id, r);
      }
      r.name = st.n; r.color = st.c; r.no = st.no;
      if (Array.isArray(st.k) && st.kt !== this.lastKt.get(p.id)) {
        this.lastKt.set(p.id, st.kt);
        r.buf.push({ t: now, d: st.k });
        if (r.buf.length > 30) r.buf.shift();
      }
      if (!this.known.has(p.id)) { this.known.set(p.id, r.name); this.dispatchEvent(new CustomEvent("joined", { detail: { id: p.id, name: r.name } })); }
    }
    for (const id of [...this.remotes.keys()]) {
      if (!peers.some(p => p.id === id)) {
        this.remotes.delete(id); this.known.delete(id);
        this.dispatchEvent(new CustomEvent("left", { detail: { id } }));
      }
    }

    // --- the race, as published by the host
    const h = host && host.state.h;
    const race = h || null;
    if (race && race.rid !== this.seenRid) {
      this.seenRid = race.rid;
      this.raceInfo = { rid: race.rid, at: race.at, laps: Math.max(1, Math.min(10, race.laps | 0)), grid: race.grid };
      this.announced.clear(); this.firstFinAt = 0; this.resultsFor = null;
      this.set({ rid: race.rid, lp: 0, b: null, f: null, rd: false });
      if (race.grid.includes(this.id)) {
        this.dispatchEvent(new CustomEvent("go", { detail: { startAt: race.at, laps: this.raceInfo.laps, grid: race.grid, s: now } }));
      }
    }
    const ri = this.raceInfo;
    let phase = "lobby";
    if (ri) {
      const racers = peers.filter(p => ri.grid.includes(p.id));
      const inRace = p => p.state.rid === ri.rid;
      // finishes
      const fins = racers.filter(p => inRace(p) && p.state.f != null).sort((a, b) => a.state.f - b.state.f);
      fins.forEach((p, i) => {
        if (this.announced.has(p.id)) return;
        this.announced.add(p.id);
        if (!this.firstFinAt) this.firstFinAt = now;
        this.dispatchEvent(new CustomEvent("fin", { detail: { id: p.id, ms: p.state.f, best: p.state.b, pos: i + 1 } }));
      });
      const allDone = racers.length > 0 && racers.every(p => inRace(p) && p.state.f != null);
      const mine = ri.grid.includes(this.id);
      if (!mine && this.resultsFor !== ri.rid && (allDone || racers.length === 0)) { this.resultsFor = ri.rid; this.resultsAt = now - RESULTS_HOLD; }
      if (this.resultsFor !== ri.rid && (allDone || (this.firstFinAt && now - this.firstFinAt > FINISH_GRACE) || racers.length === 0)) {
        this.resultsFor = ri.rid;
        this.resultsAt = now;
        const order = [...racers].sort((a, b) => {
          const fa = inRace(a) && a.state.f != null, fb = inRace(b) && b.state.f != null;
          if (fa !== fb) return fa ? -1 : 1;
          if (fa) return a.state.f - b.state.f;
          return (b.state.lp || 0) - (a.state.lp || 0);
        });
        const list = order.map((p, i) => ({
          id: p.id, name: p.state.n, color: p.state.c, pos: i + 1,
          ms: inRace(p) ? p.state.f : null, best: inRace(p) ? p.state.b : null, laps: inRace(p) ? p.state.lp || 0 : 0,
          dnf: !(inRace(p) && p.state.f != null),
        }));
        this.dispatchEvent(new CustomEvent("results", { detail: { list } }));
      }
      if (this.resultsFor === ri.rid) phase = now - this.resultsAt < RESULTS_HOLD ? "results" : "lobby";
      else phase = "racing";
    }

    // --- host: start automatically when everyone's ready
    if (this.isHost && phase === "lobby") {
      const allReady = peers.length >= 2 && peers.every(p => p.state.rd);
      if (allReady && !this.autoAt) this.autoAt = now + 2500;
      if (!allReady) this.autoAt = 0;
      if (this.autoAt && now >= this.autoAt) this.startRace();
    }

    // --- lobby snapshot in the server's shape
    const room = {
      t: "room", code: this.code, private: true, phase, host: host ? host.id : null,
      laps: (host && host.state.L) || 3, autoAt: this.autoAt || (phase === "lobby" && peers.length >= 2 && peers.every(p => p.state.rd) ? 1 : 0),
      players: peers.map(p => ({
        id: p.id, name: p.state.n, color: p.state.c, ready: !!p.state.rd,
        racing: phase === "racing" && !!ri && ri.grid.includes(p.id), laps: p.state.lp || 0, best: p.state.b ?? null, fin: p.state.f ?? null,
      })),
    };
    for (const pl of room.players) { const r = this.remotes.get(pl.id); if (r) r.racing = pl.racing; }
    const json = JSON.stringify(room);
    if (json !== this.lastRoomJson) {
      this.lastRoomJson = json;
      this.room = room;
      this.dispatchEvent(new CustomEvent("room", { detail: room }));
    }
  }
}
