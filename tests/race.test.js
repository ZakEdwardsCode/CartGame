// Lap counting, physics sanity and AI race completion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { N, gridSlot, respawnPose, BAR_L, BAR_R, LINE, LAP_LENGTH } from "../src/track.js";
import { Kart, World } from "../src/physics.js";
import { AIDriver } from "../src/ai.js";
import { LapTracker, byRaceOrder } from "../src/race.js";

test("track model is sane", () => {
  assert.equal(N, 719);
  assert.ok(Math.abs(LAP_LENGTH - 719) < 2);
  for (let i = 0; i < N; i++) {
    assert.ok(BAR_L[i] >= 2.9 && BAR_R[i] >= 2.9, `barrier too close at ${i}`);
    assert.ok(Math.abs(LINE[i]) < 3.6, `racing line off the tarmac at ${i}`);
  }
});

test("lap tracker: start, laps, reversing over the line", () => {
  const t = new LapTracker(2);
  let time = 0;
  const drive = (from, to) => { for (let i = from; i <= to; i++) { time += 0.07; t.update(time, ((i % N) + N) % N); } };
  drive(N - 10, N - 1);            // on the grid, behind the line
  assert.equal(t.crossings, 0);
  assert.ok(t.dist < 0);
  drive(N, N + 50);                // over the line: lap 1 starts
  assert.equal(t.crossings, 1);
  assert.equal(t.lapsDone, 0);
  // back over the line and forward again must not count a lap
  for (let i = 50; i >= -5; i--) { time += 0.07; t.update(time, ((i % N) + N) % N); }
  drive(-4, 60);
  assert.equal(t.lapsDone, 0);
  drive(61, N + 5);                // completes lap 1
  assert.equal(t.lapsDone, 1);
  assert.ok(t.bestLap > 0);
  drive(6, N + 5);
  assert.equal(t.lapsDone, 2);
  assert.ok(t.finished);
});

test("respawn never crosses the line backwards", () => {
  for (const i of [0, 1, 2, 3, 400]) {
    const p = respawnPose(i);
    assert.ok(!(i < 40 && p.i > N - 40));
  }
});

test("a kart at rest stays at rest; full throttle reaches a kart-like top speed", () => {
  const w = new World();
  const k = w.add(new Kart(0));
  k.reset(gridSlot(0));
  for (let f = 0; f < 120; f++) w.step(1 / 60);
  assert.ok(Math.hypot(k.vx, k.vy) < 0.01);
  k.input.throttle = 1;
  let top = 0;
  for (let f = 0; f < 60 * 6; f++) { w.step(1 / 60); top = Math.max(top, k.vx); }
  assert.ok(top > 12 && top < 26, `top ${top}`);
});

test("AI field completes a 3-lap race without getting stuck", () => {
  const w = new World();
  const entries = [];
  for (let n = 0; n < 6; n++) {
    const k = w.add(new Kart(n));
    k.reset(gridSlot(n));
    entries.push({ kart: k, ai: new AIDriver(k, 0.85 + n * 0.02, 0.01, n + 3), tracker: new LapTracker(3) });
  }
  let t = 0, respawns = 0;
  for (let f = 0; f < 60 * 300 && !entries.every(e => e.tracker.finished); f++) {
    for (const e of entries) if (e.ai.update(1 / 60, w.karts)) { respawns++; e.kart.reset(respawnPose(e.kart.idx)); e.tracker.teleport(e.kart.idx); }
    w.step(1 / 60);
    t += 1 / 60;
    for (const e of entries) e.tracker.update(t, e.kart.idx, 0);
  }
  assert.ok(entries.every(e => e.tracker.finished), "everyone finished");
  const order = [...entries].sort(byRaceOrder);
  assert.ok(order[0].tracker.finishTime < 3 * 70, `winner time ${order[0].tracker.finishTime}`);
  assert.ok(respawns <= 2, `respawns ${respawns}`);
  for (const e of entries) for (const l of e.tracker.lapTimes) assert.ok(l.valid);
});
