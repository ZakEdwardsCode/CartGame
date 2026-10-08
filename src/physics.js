// ============================================================================
// Kart physics — a planar rigid body on a two-axle tyre model.
//
//  * Pacejka-style lateral tyre curve per axle, with load transfer
//  * Solid rear axle drives and brakes (karts have no front brakes)
//  * Friction circle on the rear: power or brake eats into cornering grip,
//    so lifting, trail-braking and power-oversteer all behave like a kart
//  * Surface per axle: tarmac, kerb, grass
//  * Barrier and kart-to-kart collisions with impulses
//
// Pure maths, no rendering. Fixed-step: call World.step(dt) with any dt and
// it sub-steps internally at 240 Hz.
// ============================================================================

import {
  N, wrap, project, halfWidth, barrierAt, gradeAt, KERB, KERB_W,
  RX, RZ, FX, FZ, heading,
} from "./track.js";

const G = 9.81;

export const SPEC = {
  mass: 165,            // kart + driver (kg)
  Iz: 42,               // yaw inertia (kg m^2)
  a: 0.60,              // CG -> front axle (m) — karts carry their weight rearwards
  b: 0.45,              // CG -> rear axle (m)
  cgH: 0.25,            // CG height (m)
  power: 7400,          // at the wheel (W)
  maxDrive: 780,        // traction-side cap on drive force (N)
  maxBrake: 1500,       // total brake force (N)
  brakeFront: 0.40,     // share on the front axle (hire karts brake all four)
  gripF: 0.95,          // narrow fronts
  gripR: 1.08,          // wide rears
  reverseForce: 260,    // gentle reverse (N), capped at reverseTop
  reverseTop: 3.2,
  CdA: 0.72,            // drag area (m^2)
  maxSteer: 0.42,       // front wheel lock (rad)
  steerRate: 5.0,       // how fast the wheels reach the requested angle (rad/s)
  tyreB: 8.5, tyreC: 1.32, tyreE: 0.10,
  radius: 0.62,         // collision circle radius (two per kart)
  circleOff: 0.48,      // fore/aft offset of the collision circles
};

export const SURFACES = {
  tarmac: { mu: 1.38, rr: 0.016, drag: 0,   bump: 0 },
  kerb:   { mu: 1.20, rr: 0.030, drag: 0,   bump: 1 },
  grass:  { mu: 0.62, rr: 0.10,  drag: 1.4, bump: 0.6 },
};

const pacejka = (alpha, s) => {
  const x = s.tyreB * alpha;
  return Math.sin(s.tyreC * Math.atan(x - s.tyreE * (x - Math.atan(x))));
};

function surfaceAt(i, lat) {
  const side = lat < 0 ? -1 : 1;
  const hw = halfWidth(i, side), d = Math.abs(lat);
  if (d <= hw) return SURFACES.tarmac;
  if (d <= hw + KERB_W && KERB[wrap(i)]) return SURFACES.kerb;
  return SURFACES.grass;
}

const _p = {};

export class Kart {
  constructor(id, spec = SPEC) {
    this.id = id;
    this.spec = spec;
    this.input = { steer: 0, throttle: 0, brake: 0 };
    this.remote = false;      // remote karts are positioned by the network
    this.brakeAssist = true;  // ABS-style limit just below lock-up (AI always uses it)
    this.ghost = false;       // ghosts don't collide
    this.reset({ x: 0, z: 0, yaw: 0, i: 0 });
  }

  reset(pose) {
    this.x = pose.x; this.z = pose.z; this.yaw = pose.yaw;
    this.vx = 0; this.vy = 0; this.r = 0;
    this.delta = 0;                         // front wheel angle
    this.brakeP = 0; this.holdT = 0; this.lockF = this.lockR = false;
    this.axF = 0;                           // filtered long. accel for load transfer
    const p = project(this.x, this.z, pose.i ?? -1, _p);
    this.idx = p.i; this.s = p.s; this.lat = p.lat; this.y = p.y;
    this.surfF = this.surfR = SURFACES.tarmac;
    this.slipF = 0; this.slipR = 0; this.skid = 0;
    this.wheelRot = 0; this.roll = 0; this.pitch = 0; this.bump = 0;
    this.hit = 0;                           // last impact strength (decays)
    this.offTrack = false;
  }

  get speed() { return this.vx; }
  get speedAbs() { return Math.hypot(this.vx, this.vy); }

  steerLimit() {
    // a little speed-sensitivity, so full lock is not twitchy at 45 mph
    return this.spec.maxSteer / (1 + Math.abs(this.vx) / 26);
  }

  substep(h) {
    const S = this.spec, m = S.mass, L = S.a + S.b;
    const inp = this.input;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);

    // --- where are we on the track
    const p = project(this.x, this.z, this.idx, _p);
    this.idx = p.i; this.s = p.s; this.lat = p.lat; this.y = p.y;
    // axle lateral positions (forward vector projected onto track right)
    const fr = c * RX[p.i] - s * RZ[p.i];
    this.surfF = surfaceAt(p.i, p.lat + fr * S.a);
    this.surfR = surfaceAt(p.i, p.lat - fr * S.b);
    this.offTrack = this.surfF === SURFACES.grass && this.surfR === SURFACES.grass;

    // --- steering
    const target = Math.max(-1, Math.min(1, inp.steer)) * this.steerLimit();
    const dmax = S.steerRate * h;
    this.delta += Math.max(-dmax, Math.min(dmax, target - this.delta));
    const d = this.delta, cd = Math.cos(d), sd = Math.sin(d);

    // --- loads with longitudinal transfer
    let Fzf = m * G * S.b / L - m * this.axF * S.cgH / L;
    let Fzr = m * G * S.a / L + m * this.axF * S.cgH / L;
    Fzf = Math.max(0.12 * m * G, Fzf); Fzr = Math.max(0.12 * m * G, Fzr);

    // --- slip angles (low-speed safe)
    const vx = this.vx, vy = this.vy, r = this.r;
    const vxd = Math.max(Math.abs(vx), 2.5);
    const dir = vx < -0.2 ? -1 : 1;
    const aF = Math.atan2(vy + S.a * r, vxd) - d * dir;
    const aR = Math.atan2(vy - S.b * r, vxd);
    const muF = this.surfF.mu * S.gripF, muR = this.surfR.mu * S.gripR;
    let Fyf = -muF * Fzf * pacejka(aF, S);
    let Fyr = -muR * Fzr * pacejka(aR, S);

    // --- brakes: hydraulic pressure builds and bleeds off over ~0.15 s
    const thr = Math.max(0, Math.min(1, inp.throttle));
    const brk = Math.max(0, Math.min(1, inp.brake));
    const dp = brk - this.brakeP;
    this.brakeP += Math.max(-10 * h, Math.min(7 * h, dp));
    const bp = this.brakeP;

    // sliding velocity of each axle's contact patch (body frame)
    const vfx = vx, vfy = vy + S.a * r;
    const vrx = vx, vry = vy - S.b * r;
    const capF = muF * Fzf, capR = muR * Fzr;

    let Fx = 0;                  // rear longitudinal (drive or brake), body x
    let FbF = 0;                 // front brake force along the wheel
    this.lockF = this.lockR = false;
    if (vx > 0.5 && bp > 0.01) {
      // moving forwards with the pedal on
      let bR = bp * S.maxBrake * (1 - S.brakeFront);
      let bF = bp * S.maxBrake * S.brakeFront;
      const drive = thr * Math.min(S.maxDrive, S.power / Math.max(vx, 1));
      if (this.brakeAssist) {
        // assist (like ABS): never more brake than the tyre can take next to its cornering load
        bR = Math.min(bR, 0.96 * Math.sqrt(Math.max(0, capR * capR - Fyr * Fyr)) + drive);
        bF = Math.min(bF, 0.96 * Math.sqrt(Math.max(0, capF * capF - Fyf * Fyf)));
      }
      // a wheel locks when the brake out-torques the grip (and unlocks a little below it)
      const netR = bR - drive;
      this.lockR = netR > capR * (this._wasLockR ? 0.85 : 1.0) && Math.hypot(vrx, vry) > 1;
      this.lockF = bF > capF * (this._wasLockF ? 0.85 : 1.0) && Math.hypot(vfx, vfy) > 1;
      Fx = -netR;
      FbF = -bF;
      this.holdT = 0;
    } else if (bp > 0.05 && Math.abs(vx) <= 0.5 && thr < 0.05) {
      // stopped with the brake on: the kart is held; keep holding to creep backwards
      this.holdT = (this.holdT || 0) + h;
      if (this.holdT > 0.6 && vx > -S.reverseTop) Fx = -bp * S.reverseForce;
    } else if (vx < -0.5 && bp > 0.05) {
      Fx = -bp * S.reverseForce;            // already reversing
    } else if (thr > 0.02) {
      if (vx < -0.4) Fx = thr * S.maxBrake * 0.6;          // stop rolling back first
      else Fx = thr * Math.min(S.maxDrive, S.power / Math.max(vx, 1));
      this.holdT = 0;
    } else this.holdT = 0;
    this._wasLockF = this.lockF; this._wasLockR = this.lockR;

    // --- tyre forces in body axes, through each axle's friction circle
    const muSlide = 0.82;          // a locked, sliding tyre grips less than a rolling one
    let Ffx, Ffy, Frx, Fry, rearSlide = 0;
    if (this.lockR) {
      // locked rear: force simply opposes the patch's sliding direction
      const v = Math.hypot(vrx, vry) || 1;
      Frx = -capR * muSlide * vrx / v; Fry = -capR * muSlide * vry / v;
      rearSlide = 1;
    } else {
      Frx = Fx; Fry = Fyr;
      const tot = Math.hypot(Frx, Fry);
      if (tot > capR) { const k = capR / tot; Frx *= k; Fry *= k; rearSlide = 1 - k; }
    }
    if (this.lockF) {
      // locked fronts don't steer: the kart ploughs on in the direction it's sliding
      const v = Math.hypot(vfx, vfy) || 1;
      Ffx = -capF * muSlide * vfx / v; Ffy = -capF * muSlide * vfy / v;
    } else {
      let fb = FbF, fy = Fyf;
      const tot = Math.hypot(fb, fy);
      if (tot > capF) { const k = capF / tot; fb *= k; fy *= k; }
      Ffx = fb * cd - fy * sd; Ffy = fy * cd + fb * sd;
    }

    // --- resistances
    const sp = Math.hypot(vx, vy);
    const rr = (this.surfF.rr * Fzf + this.surfR.rr * Fzr);
    const grassDrag = (this.surfF.drag + this.surfR.drag) * 0.5 * m * Math.min(1, sp / 4);
    const drag = 0.5 * 1.2 * S.CdA * sp * sp;
    const resist = rr + grassDrag + drag;
    const grade = -m * G * gradeAt(p.i) * (c * FX[p.i] + (-s) * FZ[p.i]);

    // --- integrate (body frame)
    const along = (Frx + Ffx + grade) / m;   // true longitudinal accel
    const ax = along + vy * r;
    const ay = (Fry + Ffy) / m - vx * r;
    const rdot = (S.a * Ffy - S.b * Fry) / S.Iz;

    // resistances act against the velocity, without reversing it
    if (sp > 1e-4) {
      const rx = resist * vx / sp / m, ry = resist * vy / sp / m;
      this.vx += (ax - rx) * h; this.vy += (ay - ry) * h;
      if (Math.sign(this.vx) !== Math.sign(vx) && Math.abs(Fx) < 1 && thr < 0.02) this.vx = 0;
      // brakes never push you backwards: stopping is where they end
      if (vx > 0 && this.vx < 0 && thr < 0.02 && (this.holdT || 0) <= 0.6) this.vx = 0;
    } else {
      this.vx += ax * h; this.vy += ay * h;
    }
    this.r += rdot * h;

    // held on the brake: stay put
    if (bp > 0.05 && Math.abs(this.vx) <= 0.5 && thr < 0.05 && (this.holdT || 0) <= 0.6) {
      this.vx *= Math.max(0, 1 - 25 * h); this.vy *= Math.max(0, 1 - 25 * h); this.r *= Math.max(0, 1 - 25 * h);
    }
    // settle completely at rest
    if (Math.abs(this.vx) < 0.05 && thr < 0.02 && brk < 0.02) {
      this.vx *= 0.9; this.vy *= 0.9; this.r *= 0.9;
    }
    // damp lateral creep at walking pace (tyre model is singular near 0)
    if (sp < 1.5) { this.vy *= 1 - 6 * h; this.r *= 1 - 4 * h * (1 - sp / 1.5); }

    this.axF += (along - this.axF) * Math.min(1, h * 12);

    // --- move
    this.yaw += this.r * h;
    this.x += (this.vx * c - this.vy * s) * h;
    this.z += (-this.vx * s - this.vy * c) * h;

    // --- visuals / feedback channels
    this.slipF = Math.abs(aF); this.slipR = Math.abs(aR);
    const skidLat = Math.max(0, Math.abs(aR) - 0.09) * 6;
    this.skid = Math.min(1, skidLat + rearSlide * 1.5 + (this.lockF ? 1 : 0)) * Math.min(1, sp / 6);
    this.wheelRot += vx / 0.25 * h;
    this.roll += ((-ay / G) * 0.045 - this.roll) * Math.min(1, h * 10);
    this.pitch += ((ax / G) * 0.03 - this.pitch) * Math.min(1, h * 10);
    const bumpy = Math.max(this.surfF.bump, this.surfR.bump);
    this.bump = bumpy ? bumpy * Math.min(1, sp / 10) : 0;
  }

  collideBarrier() {
    const S = this.spec;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    let worst = 0;
    for (const off of [S.circleOff, -S.circleOff]) {
      const px = this.x + c * off, pz = this.z - s * off;
      const p = project(px, pz, this.idx, _p);
      const side = p.lat < 0 ? -1 : 1;
      const limit = barrierAt(p.i, side) - S.radius;
      const pen = Math.abs(p.lat) - limit;
      if (pen <= 0) continue;
      const nx = RX[p.i] * side, nz = RZ[p.i] * side;           // outward normal
      this.x -= nx * pen; this.z -= nz * pen;
      // world velocity at the contact point
      const wvx = this.vx * c - this.vy * s, wvz = -this.vx * s - this.vy * c;
      const lx = c * off, lz = -s * off;                          // lever arm
      const pvx = wvx + (-this.r) * (-lz), pvz = wvz + (-this.r) * lx; // r about +y is -r in (x,z)
      const vn = pvx * nx + pvz * nz;
      if (vn <= 0) continue;
      const e = 0.28;
      // effective mass including rotation
      const cr = lx * nz - lz * nx;
      const kInv = 1 / this.spec.mass + cr * cr / this.spec.Iz;
      const j = (1 + e) * vn / kInv;
      // tangential scrub
      const tx = -nz, tz = nx;
      const vt = pvx * tx + pvz * tz;
      const jt = Math.max(-0.35 * j, Math.min(0.35 * j, vt / kInv));
      const ix = -(j * nx + jt * tx), iz = -(j * nz + jt * tz);
      this.applyImpulse(ix, iz, lx, lz);
      worst = Math.max(worst, j / this.spec.mass);
    }
    if (worst > 0) this.hit = Math.max(this.hit, worst);
  }

  // impulse (ix,iz) in world, applied at lever (lx,lz) from the CG
  applyImpulse(ix, iz, lx, lz) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const m = this.spec.mass;
    let wvx = this.vx * c - this.vy * s, wvz = -this.vx * s - this.vy * c;
    wvx += ix / m; wvz += iz / m;
    // torque about +y in (x,z): tau_y = lz*ix - lx*iz ; yaw rate r is CCW-from-above = +y
    this.r += (lz * ix - lx * iz) / this.spec.Iz;
    this.vx = wvx * c - wvz * s;
    this.vy = -wvx * s - wvz * c;
  }

  worldVel() {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return [this.vx * c - this.vy * s, -this.vx * s - this.vy * c];
  }
}

// ---------------------------------------------------------------------------
// Kart-to-kart contact: two circles per kart, impulse with friction.
// Remote karts are immovable from our side (their owner resolves their half).
// ---------------------------------------------------------------------------
function collidePair(A, B) {
  const SA = A.spec, SB = B.spec;
  const ca = Math.cos(A.yaw), sa = Math.sin(A.yaw), cb = Math.cos(B.yaw), sb = Math.sin(B.yaw);
  const dx0 = B.x - A.x, dz0 = B.z - A.z;
  if (dx0 * dx0 + dz0 * dz0 > 9) return 0;
  let strength = 0;
  for (const oa of [SA.circleOff, -SA.circleOff]) for (const ob of [SB.circleOff, -SB.circleOff]) {
    const ax = A.x + ca * oa, az = A.z - sa * oa;
    const bx = B.x + cb * ob, bz = B.z - sb * ob;
    const dx = bx - ax, dz = bz - az, dist = Math.hypot(dx, dz);
    const minD = SA.radius + SB.radius;
    if (dist >= minD || dist < 1e-6) continue;
    const nx = dx / dist, nz = dz / dist, pen = minD - dist;
    const aMov = !A.remote, bMov = !B.remote;
    const wA = aMov ? 1 : 0, wB = bMov ? 1 : 0;
    if (wA + wB === 0) continue;
    const share = 1 / (wA + wB);
    if (aMov) { A.x -= nx * pen * share; A.z -= nz * pen * share; }
    if (bMov) { B.x += nx * pen * share; B.z += nz * pen * share; }
    const [avx, avz] = A.worldVel(), [bvx, bvz] = B.worldVel();
    const vn = (bvx - avx) * nx + (bvz - avz) * nz;
    if (vn >= 0) continue;
    const e = 0.35;
    const mA = SA.mass, mB = SB.mass;
    const invA = aMov ? 1 / mA : 0, invB = bMov ? 1 / mB : 0;
    // a remote kart acts as an equal-mass body for the local share
    const effInv = (aMov && bMov) ? invA + invB : 2 / (aMov ? mA : mB);
    const j = -(1 + e) * vn / effInv;
    if (aMov) A.applyImpulse(-j * nx, -j * nz, ca * oa, -sa * oa);
    if (bMov) B.applyImpulse(j * nx, j * nz, cb * ob, -sb * ob);
    strength = Math.max(strength, Math.abs(j) / 165);
  }
  if (strength > 0) { A.hit = Math.max(A.hit, strength); B.hit = Math.max(B.hit, strength); }
  return strength;
}

export class World {
  constructor() {
    this.karts = [];
    this.acc = 0;
    this.H = 1 / 240;
  }
  add(k) { this.karts.push(k); return k; }
  remove(k) { this.karts = this.karts.filter(x => x !== k); }

  step(dt) {
    this.acc += Math.min(dt, 0.1);
    let n = 0;
    while (this.acc >= this.H) {
      this.acc -= this.H;
      for (const k of this.karts) if (!k.remote && !k.frozen) k.substep(this.H);
      for (const k of this.karts) if (!k.remote && !k.frozen) k.collideBarrier();
      const ks = this.karts;
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
        if (ks[i].ghost || ks[j].ghost) continue;
        if (ks[i].frozen && ks[j].frozen) continue;
        collidePair(ks[i], ks[j]);
      }
      n++;
    }
    for (const k of this.karts) k.hit *= Math.pow(0.02, dt);
    return n;
  }
}

export { heading };
