// ============================================================================
// AI drivers. They drive the same physics as the player — no rubber-banding,
// no extra grip — by following the racing line with pure-pursuit steering and
// a speed profile scaled by skill. They move off the line to pass or avoid.
// ============================================================================

import {
  N, wrap, cx, cz, RX, RZ, LINE, LINE_X, LINE_Z, BAR_L, BAR_R, halfWidth, speedProfile,
} from "./track.js";
import { SPEC, SURFACES } from "./physics.js";

// fraction of the tyre's peak grip a well-driven kart can actually use mid-corner
export let PROFILE_GRIP = 0.95;
export let BRAKE_FRAC = 0.5;
export function tuneAI(g, b) { PROFILE_GRIP = g; BRAKE_FRAC = b; PROFILES.clear(); }

const PROFILES = new Map();
function profileFor(mu) {
  const k = mu.toFixed(3);
  if (!PROFILES.has(k)) {
    PROFILES.set(k, speedProfile({
      mu, vTop: 23,
      aBrake: mu * 9.81 * BRAKE_FRAC,
      accel: v => Math.max(0.5, Math.min(SPEC.maxDrive, SPEC.power / Math.max(v, 1)) / SPEC.mass
        - 0.5 * 1.2 * SPEC.CdA * v * v / SPEC.mass - 0.25),
    }));
  }
  return PROFILES.get(k);
}

export const DIFFICULTY = {
  easy:   { skill: [0.78, 0.84], mistakes: 0.020 },
  medium: { skill: [0.86, 0.91], mistakes: 0.010 },
  hard:   { skill: [0.93, 0.97], mistakes: 0.003 },
  alien:  { skill: [0.985, 1.0], mistakes: 0.0 },
};

export class AIDriver {
  constructor(kart, skill = 0.9, mistakes = 0.01, seed = 1) {
    this.kart = kart;
    this.skill = skill;
    this.mistakes = mistakes;
    this.rand = mulberry32(seed);
    this.v = profileFor(SURFACES.tarmac.mu * PROFILE_GRIP * skill);
    this.offset = 0;          // lateral deviation from the line (passing / avoidance)
    this.offsetTarget = 0;
    this.wobble = 0;
    this.stuck = 0;
    this.lineBias = (this.rand() - 0.5) * 0.5;   // each driver has a slightly personal line
  }

  laneLimits(i) {
    const lo = -(Math.min(halfWidth(i, -1), BAR_L[i]) - 0.9);
    const hi = Math.min(halfWidth(i, 1), BAR_R[i]) - 0.9;
    return [lo, hi];
  }

  update(dt, others) {
    const k = this.kart, inp = k.input;
    const v = Math.max(0, k.vx);
    const i = k.idx;

    // --- traffic: look for a kart close ahead and pick a side
    this.offsetTarget *= Math.pow(0.4, dt);
    let blocked = 1e9;
    for (const o of others) {
      if (o === k || o.ghost) continue;
      let ds = o.s - k.s;
      if (ds < -N / 2) ds += N; if (ds > N / 2) ds -= N;
      if (ds > 0.5 && ds < 9) {
        const dl = o.lat - (k.lat);
        if (Math.abs(dl) < 1.6) {
          const myLine = LINE[i] + this.offset;
          const go = (o.lat > myLine) ? -1 : 1;
          this.offsetTarget = go * 1.7;
          if (ds < 5 && o.vx < k.vx) blocked = Math.min(blocked, o.vx + ds * 0.6);
        }
      }
    }
    this.offset += (this.offsetTarget - this.offset) * Math.min(1, dt * 2.0);

    // --- occasional small mistakes
    if (this.rand() < this.mistakes * dt * 10) this.wobble = (this.rand() - 0.5) * 0.5;
    this.wobble *= Math.pow(0.2, dt);

    // --- pure pursuit on the (offset) racing line
    const look = 2.4 + v * 0.32;
    const ti = wrap(i + Math.round(look));
    const [lo, hi] = this.laneLimits(ti);
    const off = Math.max(lo, Math.min(hi, LINE[ti] + this.offset + this.lineBias * 0.3));
    const tx = cx(ti) + RX[ti] * off, tz = cz(ti) + RZ[ti] * off;
    const dx = tx - k.x, dz = tz - k.z;
    const c = Math.cos(k.yaw), s = Math.sin(k.yaw);
    const fwd = dx * c + dz * (-s);
    const left = dx * (-s) + dz * (-c);
    const ld2 = Math.max(1, dx * dx + dz * dz);
    const wheelbase = k.spec.a + k.spec.b;
    let delta = Math.atan2(2 * wheelbase * left, ld2);
    if (fwd < 0) delta = Math.sign(left || 1) * k.spec.maxSteer;   // target behind us — turn round
    // counter-steer when the rear steps out
    const beta = Math.atan2(k.vy, Math.max(2, Math.abs(k.vx)));
    delta += beta * 0.6;
    inp.steer = Math.max(-1, Math.min(1, delta / k.steerLimit() + this.wobble));

    // --- speed control against the profile, looking ahead by braking distance
    const aB = SURFACES.tarmac.mu * PROFILE_GRIP * 9.81 * BRAKE_FRAC * this.skill;
    let vt = 99;
    const horizon = Math.min(40, 2 + v * v / (2 * aB) + v * 0.25);
    for (let d = 0; d <= horizon; d += 1) {
      const vv = this.v[wrap(i + d)];
      const allowed = Math.sqrt(vv * vv + 2 * aB * Math.max(0, d - v * 0.12));
      if (allowed < vt) vt = allowed;
    }
    vt = Math.min(vt, blocked);
    if (k.offTrack) vt = Math.min(vt, 9);
    const err = vt - v;
    if (err > 0.3) { inp.throttle = Math.min(1, err * 0.8 + 0.4); inp.brake = 0; }
    else if (err < -0.6) { inp.throttle = 0; inp.brake = Math.min(1, -err * 0.35) * (1 - 0.8 * Math.min(1, Math.abs(inp.steer))); }
    else { inp.throttle = 0.35 + err * 0.5; inp.brake = 0; }
    // traction control: ease off when the rear is sliding
    if (k.skid > 0.5) inp.throttle *= 0.6;

    // --- recover if stuck against something
    if (v < 1.0 && inp.throttle > 0.5) this.stuck += dt; else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 2.5) { this.stuck = 0; return true; }   // caller respawns
    return false;
  }
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export { LINE_X, LINE_Z };
