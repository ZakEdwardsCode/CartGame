// ============================================================================
// Lap & position bookkeeping for one kart. Pure logic (no DOM / rendering).
//
// Karts start behind the line. The first forward crossing starts lap 1; each
// later crossing completes a lap if every sector checkpoint was passed in
// order. Driving back over the line un-counts the crossing.
// ============================================================================

import { N } from "./track.js";

export const SECTORS = 8;
const CP = Array.from({ length: SECTORS }, (_, k) => Math.floor(k * N / SECTORS));

export class LapTracker {
  constructor(laps = Infinity) {
    this.laps = laps;
    this.reset();
  }

  reset() {
    this.crossings = 0;
    this.lapsDone = 0;
    this.lapStart = 0;
    this.lastLap = null;
    this.bestLap = null;
    this.lapTimes = [];
    this.cp = 1;              // next checkpoint index expected (0 = the line)
    this.cpOk = true;
    this.prevIdx = null;
    this.backedOver = 0;
    this.finished = false;
    this.finishTime = null;
    this.dist = -N;           // race distance in metres (negative before the line)
    this.events = [];
  }

  // t = race clock (s since the start), idx = track sample, along = sub-metre
  update(t, idx, along = 0) {
    this.events.length = 0;
    const p = this.prevIdx;
    if (p != null) {
      if (p > N - 40 && idx < 40) this._cross(t, +1);
      else if (p < 40 && idx > N - 40) this._cross(t, -1);
    }
    this.prevIdx = idx;
    // checkpoints in order
    if (this.crossings > 0 && this.cp < SECTORS) {
      const c = CP[this.cp];
      if (idx >= c && idx - c < 30) this.cp++;
    }
    const s = idx + Math.max(-0.5, Math.min(0.5, along));
    if (!this.finished) this.dist = this.crossings > 0 ? (this.crossings - 1) * N + s : s - N;
    return this.events;
  }

  _cross(t, dir) {
    if (dir < 0) {
      // backed over the line: undo the crossing; re-crossing just restores it
      if (this.crossings > 0) { this.crossings--; this.backedOver++; }
      return;
    }
    if (this.backedOver > 0) { this.backedOver--; this.crossings++; return; }
    this.crossings++;
    if (this.crossings === 1) {
      this.lapStart = t; this.cp = 1;
      this.events.push({ type: "start" });
      return;
    }
    const lap = t - this.lapStart;
    const valid = this.cp >= SECTORS;
    this.lapStart = t;
    this.cp = 1;
    this.lastLap = lap;
    this.lapTimes.push({ t: lap, valid });
    if (valid) {
      this.lapsDone++;
      const pb = this.bestLap == null || lap < this.bestLap;
      if (pb) this.bestLap = lap;
      this.events.push({ type: "lap", time: lap, valid, best: pb, n: this.lapsDone });
      if (this.lapsDone >= this.laps && !this.finished) {
        this.finished = true;
        this.finishTime = t;
        this.events.push({ type: "finish", time: t });
      }
    } else {
      // an invalid lap still advances the lap counter in a race, but not the best
      this.lapsDone++;
      this.events.push({ type: "lap", time: lap, valid, best: false, n: this.lapsDone });
      if (this.lapsDone >= this.laps && !this.finished) {
        this.finished = true; this.finishTime = t;
        this.events.push({ type: "finish", time: t });
      }
    }
  }

  // respawns move the kart without driving there
  teleport(idx) { this.prevIdx = idx; }

  currentLapTime(t) { return this.crossings > 0 && !this.finished ? t - this.lapStart : null; }
}

// sort comparator for race order
export function byRaceOrder(a, b) {
  const fa = a.tracker.finished, fb = b.tracker.finished;
  if (fa !== fb) return fa ? -1 : 1;
  if (fa) return a.tracker.finishTime - b.tracker.finishTime;
  return b.tracker.dist - a.tracker.dist;
}

// Gap timing: remember when the leader reached each metre of race distance.
export class GapClock {
  constructor() { this.t = new Map(); this.maxDist = -Infinity; }
  reset() { this.t.clear(); this.maxDist = -Infinity; }
  record(dist, time) {
    const m = Math.floor(dist);
    if (m > this.maxDist) {
      for (let k = Math.max(this.maxDist + 1, m - 5); k <= m; k++) this.t.set(k, time);
      this.maxDist = m;
    }
  }
  gap(dist, time) {
    const lt = this.t.get(Math.floor(dist));
    return lt == null ? null : time - lt;
  }
}
