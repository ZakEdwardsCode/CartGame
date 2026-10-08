// ============================================================================
// Race rooms: matchmaking, lobby, start countdown, lap/finish bookkeeping and
// state relay. Each client simulates its own kart; the server relays state at
// the rate clients send it (~20 Hz), owns the race clock and the result.
// ============================================================================

const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 5200;          // lights sequence on the client
const RESULTS_MS = 14000;           // results screen before returning to lobby
const FINISH_GRACE_MS = 45000;      // after the winner, how long others have
const MIN_LAP_MS = 25000;           // anything quicker is not a real lap here
const ALLOWED_LAPS = [1, 3, 5, 8, 10];

const now = () => Date.now();
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const color = c => /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#d8202a";

function code4() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

export class RaceServer {
  constructor({ log = () => {} } = {}) {
    this.rooms = new Map();
    this.nextId = 1;
    this.log = log;
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += r.players.size;
    return { rooms: this.rooms.size, players };
  }

  // -------------------------------------------------------------------------
  connect(ws) {
    const p = {
      id: this.nextId++, ws, name: "Driver", color: "#d8202a", room: null,
      ready: false, racing: false, lapsDone: 0, best: null, finishMs: null,
      lastLapAt: 0, stCount: 0, stWindow: now(),
    };
    ws.on("message", raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== "string") return;
      try { this.handle(p, m); } catch (e) { this.log("handler error", e); }
    });
    ws.on("close", () => this.leave(p));
    return p;
  }

  send(p, m) { if (p.ws.open) p.ws.send(JSON.stringify(m)); }
  broadcast(room, m, except) {
    const s = JSON.stringify(m);
    for (const q of room.players.values()) if (q !== except && q.ws.open) q.ws.send(s);
  }

  handle(p, m) {
    switch (m.t) {
      case "ping": return this.send(p, { t: "pong", c: m.c, s: now() });
      case "hello": return this.join(p, m);
      case "leave": return this.leave(p);
    }
    const room = p.room;
    if (!room) return;
    switch (m.t) {
      case "st": {
        if (!Array.isArray(m.d) || m.d.length > 16) return;
        const t = now();
        if (t - p.stWindow > 1000) { p.stWindow = t; p.stCount = 0; }
        if (++p.stCount > 40) return;
        const d = m.d.map(v => typeof v === "number" && isFinite(v) ? v : 0);
        return this.broadcast(room, { t: "st", id: p.id, d, ts: t }, p);
      }
      case "ready":
        if (room.phase !== "lobby") return;
        p.ready = !!m.v;
        this.roomUpdate(room);
        return this.maybeAutoStart(room);
      case "laps":
        if (p.id !== room.host || room.phase !== "lobby") return;
        if (ALLOWED_LAPS.includes(m.n)) room.laps = m.n;
        return this.roomUpdate(room);
      case "start":
        if (p.id !== room.host || room.phase !== "lobby") return;
        return this.startRace(room);
      case "lap": {
        if (room.phase !== "racing" || !p.racing) return;
        const t = now();
        const ms = Math.round(Number(m.ms));
        if (!(ms >= MIN_LAP_MS) || t - p.lastLapAt < MIN_LAP_MS - 2000) return;
        p.lastLapAt = t;
        p.lapsDone++;
        if (p.best == null || ms < p.best) p.best = ms;
        this.broadcast(room, { t: "lap", id: p.id, n: p.lapsDone, ms });
        if (p.lapsDone >= room.laps) this.finish(room, p, t);
        return;
      }
      case "chat": {
        const text = clean(m.text, 120);
        if (text) this.broadcast(room, { t: "chat", id: p.id, name: p.name, text });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  join(p, m) {
    if (p.room) this.leave(p, true);
    p.name = clean(m.name, 16) || "Driver";
    p.color = color(m.color);
    const want = clean(m.room, 8).toUpperCase();
    let room = null;
    if (want === "NEW") room = this.createRoom(true);
    else if (want) {
      room = this.rooms.get(want);
      if (!room) return this.send(p, { t: "err", msg: `No room called ${want}.` });
      if (room.players.size >= MAX_PLAYERS) return this.send(p, { t: "err", msg: "That room is full." });
    } else {
      for (const r of this.rooms.values()) {
        if (!r.private && r.phase === "lobby" && r.players.size < MAX_PLAYERS) { room = r; break; }
      }
      if (!room) {
        // join a public race in progress as a spectator/practice driver rather than sit alone
        for (const r of this.rooms.values()) if (!r.private && r.players.size < MAX_PLAYERS) { room = r; break; }
      }
      if (!room) room = this.createRoom(false);
    }
    p.room = room;
    p.ready = false; p.racing = false; p.lapsDone = 0; p.best = null; p.finishMs = null;
    room.players.set(p.id, p);
    if (!room.host || !room.players.has(room.host)) room.host = p.id;
    this.send(p, { t: "welcome", id: p.id, room: room.code, private: room.private, s: now() });
    this.broadcast(room, { t: "joined", id: p.id, name: p.name, color: p.color }, p);
    this.roomUpdate(room);
    this.log(`+ ${p.name} (#${p.id}) -> ${room.code} [${room.players.size}]`);
  }

  leave(p, silent) {
    const room = p.room;
    if (!room) return;
    room.players.delete(p.id);
    p.room = null;
    this.broadcast(room, { t: "left", id: p.id });
    if (!silent) this.log(`- ${p.name} (#${p.id}) <- ${room.code} [${room.players.size}]`);
    if (room.players.size === 0) { this.rooms.delete(room.code); return; }
    if (room.host === p.id) room.host = room.players.keys().next().value;
    if (room.phase === "racing" && ![...room.players.values()].some(q => q.racing && q.finishMs == null)) {
      this.endRace(room);
    }
    this.roomUpdate(room);
  }

  createRoom(isPrivate) {
    let code;
    do { code = isPrivate ? code4() : "PUB" + Math.floor(Math.random() * 900 + 100); } while (this.rooms.has(code));
    const room = {
      code, private: isPrivate, players: new Map(), host: null,
      phase: "lobby", laps: 3, startAt: 0, firstFinish: 0, resultsAt: 0, results: null, autoAt: 0,
    };
    this.rooms.set(code, room);
    return room;
  }

  roomUpdate(room) {
    this.broadcast(room, {
      t: "room", code: room.code, private: room.private, phase: room.phase, host: room.host,
      laps: room.laps, startAt: room.startAt, autoAt: room.autoAt,
      players: [...room.players.values()].map(q => ({
        id: q.id, name: q.name, color: q.color, ready: q.ready, racing: q.racing,
        laps: q.lapsDone, best: q.best, fin: q.finishMs,
      })),
      results: room.results,
    });
  }

  maybeAutoStart(room) {
    const ps = [...room.players.values()];
    const allReady = ps.length >= 2 && ps.every(q => q.ready);
    room.autoAt = allReady ? now() + 2500 : 0;
    this.roomUpdate(room);
  }

  startRace(room) {
    const ps = [...room.players.values()];
    // grid: random for the first race, then reverse of the last result
    let order = ps.map(q => q.id);
    if (room.results) {
      const prev = room.results.map(r => r.id).reverse();
      order.sort((a, b) => (prev.indexOf(a) + 1 || 99) - (prev.indexOf(b) + 1 || 99));
    } else {
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    }
    room.phase = "racing";
    room.startAt = now() + COUNTDOWN_MS;
    room.firstFinish = 0; room.results = null; room.autoAt = 0;
    for (const q of ps) { q.racing = true; q.ready = false; q.lapsDone = 0; q.best = null; q.finishMs = null; q.lastLapAt = room.startAt; }
    this.broadcast(room, { t: "go", startAt: room.startAt, laps: room.laps, grid: order, s: now() });
    this.roomUpdate(room);
    this.log(`race ${room.code}: ${ps.length} drivers, ${room.laps} laps`);
  }

  finish(room, p, t) {
    p.finishMs = t - room.startAt;
    if (!room.firstFinish) room.firstFinish = t;
    const pos = [...room.players.values()].filter(q => q.finishMs != null).length;
    this.broadcast(room, { t: "fin", id: p.id, ms: p.finishMs, best: p.best, pos });
    if (![...room.players.values()].some(q => q.racing && q.finishMs == null)) this.endRace(room);
    else this.roomUpdate(room);
  }

  endRace(room) {
    const ps = [...room.players.values()].filter(q => q.racing);
    ps.sort((a, b) => {
      if ((a.finishMs != null) !== (b.finishMs != null)) return a.finishMs != null ? -1 : 1;
      if (a.finishMs != null) return a.finishMs - b.finishMs;
      return b.lapsDone - a.lapsDone;
    });
    room.results = ps.map((q, i) => ({
      id: q.id, name: q.name, color: q.color, pos: i + 1, ms: q.finishMs, best: q.best,
      laps: q.lapsDone, dnf: q.finishMs == null,
    }));
    room.phase = "results";
    room.resultsAt = now() + RESULTS_MS;
    for (const q of room.players.values()) q.racing = false;
    this.broadcast(room, { t: "results", list: room.results });
    this.roomUpdate(room);
  }

  tick() {
    const t = now();
    for (const room of this.rooms.values()) {
      if (room.phase === "lobby" && room.autoAt && t >= room.autoAt) this.startRace(room);
      if (room.phase === "racing" && room.firstFinish && t - room.firstFinish > FINISH_GRACE_MS) this.endRace(room);
      if (room.phase === "racing" && t - room.startAt > 30 * 60 * 1000) this.endRace(room);
      if (room.phase === "results" && t >= room.resultsAt) {
        room.phase = "lobby";
        for (const q of room.players.values()) q.ready = false;
        this.roomUpdate(room);
      }
    }
  }
}
