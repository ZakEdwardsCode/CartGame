// Multiplayer server: handshake, matchmaking, relay, race start, laps, results.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { attachWebSocket } from "../server/ws.js";
import { RaceServer } from "../server/race.js";

function startServer() {
  const server = http.createServer((q, r) => { r.writeHead(404); r.end(); });
  const race = new RaceServer();
  attachWebSocket(server, "/ws", ws => race.connect(ws));
  return new Promise(res => server.listen(0, () => res({ server, race, port: server.address().port })));
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  };
  const c = {
    ws, inbox,
    open: () => new Promise(r => ws.addEventListener("open", r, { once: true })),
    send: m => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 3000) => {
      const hit = inbox.find(pred);
      if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((res, rej) => {
        const w = { pred, res: m => { inbox.splice(inbox.indexOf(m), 1); res(m); } };
        waiters.push(w);
        setTimeout(() => rej(new Error("timeout waiting")), ms);
      });
    },
  };
  return c;
}

test("two players meet in a public room, relay state and race", async () => {
  const { server, race, port } = await startServer();
  const a = client(port), b = client(port);
  await Promise.all([a.open(), b.open()]);

  a.send({ t: "ping", c: 1 });
  const pong = await a.wait(m => m.t === "pong");
  assert.equal(pong.c, 1);

  a.send({ t: "hello", name: "Alice<script>", color: "#00ff00" });
  const wa = await a.wait(m => m.t === "welcome");
  b.send({ t: "hello", name: "Bob", color: "nope" });
  const wb = await b.wait(m => m.t === "welcome");
  assert.equal(wa.room, wb.room, "matchmade into the same public room");

  const room = await b.wait(m => m.t === "room" && m.players.length === 2);
  assert.equal(room.host, wa.id);
  assert.equal(room.players.find(p => p.id === wa.id).name, "Alicescript");
  assert.equal(room.players.find(p => p.id === wb.id).color, "#d8202a");

  // state relay goes to the other player only, stamped by the server
  a.send({ t: "st", d: [1, 2, 3, "x", 5] });
  const st = await b.wait(m => m.t === "st");
  assert.equal(st.id, wa.id);
  assert.deepEqual(st.d, [1, 2, 3, 0, 5]);
  assert.ok(st.ts > 0);

  // non-host can't start; host can
  b.send({ t: "start" });
  a.send({ t: "laps", n: 1 });
  await a.wait(m => m.t === "room" && m.laps === 1);
  a.send({ t: "start" });
  const go = await b.wait(m => m.t === "go");
  assert.equal(go.laps, 1);
  assert.equal(go.grid.length, 2);

  // impossible lap rejected
  const rs = race.rooms.get(wa.room);
  a.send({ t: "lap", ms: 1000 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(rs.players.get(wa.id).lapsDone, 0);

  // fast-forward the clock: pretend the race started a minute ago
  rs.startAt -= 60000;
  for (const p of rs.players.values()) p.lastLapAt -= 60000;
  a.send({ t: "lap", ms: 51234 });
  const fin = await b.wait(m => m.t === "fin");
  assert.equal(fin.id, wa.id);
  assert.equal(fin.pos, 1);

  // the other driver leaving ends the race
  b.ws.close();
  const res = await a.wait(m => m.t === "results");
  assert.equal(res.list[0].id, wa.id);
  assert.equal(res.list[0].dnf, false);

  a.ws.close();
  race.stop();
  server.close();
});

test("private rooms by code", async () => {
  const { server, race, port } = await startServer();
  const a = client(port), b = client(port), c = client(port);
  await Promise.all([a.open(), b.open(), c.open()]);
  a.send({ t: "hello", name: "A", room: "new" });
  const wa = await a.wait(m => m.t === "welcome");
  assert.equal(wa.private, true);
  assert.match(wa.room, /^[A-Z]{4}$/);
  b.send({ t: "hello", name: "B", room: wa.room.toLowerCase() });
  const wb = await b.wait(m => m.t === "welcome");
  assert.equal(wb.room, wa.room);
  c.send({ t: "hello", name: "C" });
  const wc = await c.wait(m => m.t === "welcome");
  assert.notEqual(wc.room, wa.room, "public matchmaking never lands in a private room");
  c.send({ t: "hello", name: "C", room: "ZZZZ" });
  const err = await c.wait(m => m.t === "err");
  assert.match(err.msg, /No room/);

  // everyone ready -> automatic start
  a.send({ t: "ready", v: true });
  b.send({ t: "ready", v: true });
  await a.wait(m => m.t === "go", 5000);
  for (const x of [a, b, c]) x.ws.close();
  race.stop();
  server.close();
});

test("large and fragmented-size frames are handled", async () => {
  const { server, race, port } = await startServer();
  const a = client(port);
  await a.open();
  a.send({ t: "hello", name: "x".repeat(5000) });   // >125 bytes -> 16-bit length frame
  const w = await a.wait(m => m.t === "welcome");
  assert.ok(w.id);
  a.ws.close();
  race.stop();
  server.close();
});
