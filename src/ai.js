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

    // --- racecraft: keep a safe gap, pass only where there's room, and
    // never move across into a kart that's alongside
    const aBr = SURFACES.tarmac.mu * PROFILE_GRIP * 9.81 * BRAKE_FRAC * 0.85;
    let follow = 1e9;                 // speed that keeps us off the gearbox of the kart ahead
    let latMin = -1e9, latMax = 1e9;  // lateral corridor left by karts alongside
    let ahead = null, aheadDs = 1e9;
    for (const o of others) {
      if (o === k || o.ghost) continue;
      let ds = o.s - k.s;
      if (ds < -N / 2) ds += N; if (ds > N / 2) ds -= N;
      const dl = o.lat - k.lat;                      // + = they're to our right
      // alongside (any overlap, with a margin): leave them a kart's width
      if (Math.abs(ds) < 2.9 && Math.abs(dl) < 3.2) {
        if (dl > 0) latMax = Math.min(latMax, o.lat - 1.75);
        else latMin = Math.max(latMin, o.lat + 1.75);
      }
      // ahead and in our path
      if (ds > 0.3 && ds < 6 + v * 1.4 && Math.abs(dl) < 1.75) {
        const gap = 2.3 + v * 0.12;
        const room = Math.max(0, ds - gap);
        const ov = Math.max(0, o.vx);
        follow = Math.min(follow, Math.sqrt(ov * ov + 2 * aBr * room));
        if (ds < aheadDs) { aheadDs = ds; ahead = o; }
      }
    }
    // pass when we're genuinely quicker and there's space on one side
    this.passT = Math.max(0, (this.passT || 0) - dt);
    if (ahead && aheadDs < 12 && this.v[i] * 0.98 > ahead.vx + 0.4 && this.passT <= 0) {
      const [lo, hi] = this.laneLimits(wrap(i + Math.round(aheadDs)));
      const roomL = (ahead.lat - 1.85) - lo, roomR = hi - (ahead.lat + 1.85);
      const side = roomL > roomR ? -1 : 1;
      if (Math.max(roomL, roomR) > 0) {
        this.passSide = side;
        this.passLat = ahead.lat + side * 1.85;
        this.passT = 1.2;                      // commit to the move for a moment
      }
    }
    if (this.passT > 0 && this.passLat != null) this.offsetTarget = this.passLat - LINE[i];
    else this.offsetTarget *= Math.pow(0.35, dt);
    this.offset += (this.offsetTarget - this.offset) * Math.min(1, dt * 1.8);
    this.latMin = latMin; this.latMax = latMax;
    // boxed in alongside with nowhere to go: back out rather than lean on them
    const squeezed = latMin > latMax - 0.2;

    // --- occasional small mistakes
    if (this.rand() < this.mistakes * dt * 10) this.wobble = (this.rand() - 0.5) * 0.5;
    this.wobble *= Math.pow(0.2, dt);

    // --- pure pursuit on the (offset) racing line
    const look = 1.8 + v * 0.25;
    const ti = wrap(i + Math.round(look));
    const [lo, hi] = this.laneLimits(ti);
    let off = Math.max(lo, Math.min(hi, LINE[ti] + this.offset + this.lineBias * 0.3));
    // stay inside the corridor the karts alongside leave us
    off = Math.max(this.latMin, Math.min(this.latMax, off));
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
    // too close alongside: ease away now rather than waiting for the line to
    let away = 0;
    if (k.lat > this.latMax - 0.25) away += Math.min(0.5, (k.lat - this.latMax + 0.25) * 0.6);   // move left
    if (k.lat < this.latMin + 0.25) away -= Math.min(0.5, (this.latMin + 0.25 - k.lat) * 0.6);   // move right
    inp.steer = Math.max(-1, Math.min(1, delta / k.steerLimit() + this.wobble + away));

    // --- speed control against the profile, looking ahead by braking distance
    const aB = SURFACES.tarmac.mu * PROFILE_GRIP * 9.81 * BRAKE_FRAC * this.skill;
    let vt = 99;
    const horizon = Math.min(40, 2 + v * v / (2 * aB) + v * 0.25);
    for (let d = 0; d <= horizon; d += 1) {
      const vv = this.v[wrap(i + d)];
      const allowed = Math.sqrt(vv * vv + 2 * aB * Math.max(0, d - v * 0.12));
      if (allowed < vt) vt = allowed;
    }
    // giving way alongside only applies at racing speed: at the start, or crawling,
    // two karts side by side must not both wait for the other forever
    const crawl = 4;
    vt = Math.min(vt, follow);
    if (v > crawl) {
      if (squeezed) vt = Math.min(vt, v - 1.5);
      if (this.latMin > -1e8 || this.latMax < 1e8) {
        const tight = Math.min(k.lat - this.latMin, this.latMax - k.lat);
        if (tight < 0.15) vt = Math.min(vt, v - 1.0);
      }
    }
    // never sit still unless something is genuinely right in front
    if (follow > crawl) vt = Math.max(vt, Math.min(crawl, this.v[i]));
    if (k.offTrack) vt = Math.min(vt, 9);
    const err = vt - v;
    if (err > 0.3) { inp.throttle = Math.min(1, err * 0.8 + 0.4); inp.brake = 0; }
    else if (err < -0.6) { inp.throttle = 0; inp.brake = Math.min(1, -err * 0.8) * (1 - 0.8 * Math.min(1, Math.abs(inp.steer))); }
    else { inp.throttle = Math.max(0, Math.min(1, 0.8 + err * 0.5)); inp.brake = 0; }
    // traction control: ease off when the rear is sliding
    if (k.skid > 0.8) inp.throttle *= 0.85;

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
