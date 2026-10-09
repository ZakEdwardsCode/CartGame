// ============================================================================
// Track model — pure geometry, no rendering. Shared by physics, AI, the
// renderer and the tests.
//
// Frame: x = east, z = -north (three.js convention), y = up.
// Heading h at a sample: forward = (cos h, -sin h), right = (sin h, cos h).
// Lateral offsets are signed: negative = left of the centreline, positive = right.
// ============================================================================

import { TRACK, TRACK_COVERED_AT } from "../track-data.js";

export const N = TRACK.length;
export const COVERED_AT = TRACK_COVERED_AT;
export const wrap = i => ((i % N) + N) % N;

const T = i => TRACK[wrap(i)];
export const cx = i => T(i)[0];
export const cz = i => -T(i)[1];
export const heading = i => T(i)[2];
export const halfWidth = (i, side) => side < 0 ? T(i)[3] : T(i)[4];

export const dAngle = (a, b) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};
export const idxDist = (a, b) => { const d = Math.abs(wrap(a) - wrap(b)); return Math.min(d, N - d); };

// Precomputed per-sample frames
export const FX = new Float32Array(N), FZ = new Float32Array(N);   // forward
export const RX = new Float32Array(N), RZ = new Float32Array(N);   // right
export const ELEV = new Float32Array(N);                           // smoothed elevation
for (let i = 0; i < N; i++) {
  const h = heading(i);
  FX[i] = Math.cos(h); FZ[i] = -Math.sin(h);
  RX[i] = Math.sin(h); RZ[i] = Math.cos(h);
  let s = 0;
  for (let d = -2; d <= 2; d++) s += T(i + d)[5] || 0;
  ELEV[i] = s / 5;
}
export const elevAt = i => ELEV[wrap(i)];
export const gradeAt = i => (ELEV[wrap(i + 4)] - ELEV[wrap(i - 4)]) / 8;

let _mean = 0;
for (let i = 0; i < N; i++) _mean += ELEV[i];
export const ELEV_MEAN = _mean / N;

export const BOUNDS = (() => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < N; i++) {
    x0 = Math.min(x0, cx(i)); x1 = Math.max(x1, cx(i));
    z0 = Math.min(z0, cz(i)); z1 = Math.max(z1, cz(i));
  }
  return { x0, x1, z0, z1, mx: (x0 + x1) / 2, mz: (z0 + z1) / 2 };
})();

// ---------------------------------------------------------------------------
// Spatial hash of centreline samples, for fast global nearest queries
// ---------------------------------------------------------------------------
const CELL = 4;
const grid = new Map();
const key = (gx, gz) => gx * 73856093 ^ gz * 19349663;
for (let i = 0; i < N; i++) {
  const k = key(Math.floor(cx(i) / CELL), Math.floor(cz(i) / CELL));
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(i);
}
// nearest sample to (x,z), optionally excluding samples within `excl` of index `around`
export function nearestGlobal(x, z, around = -1, excl = 0, maxR = 24) {
  const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
  let best = -1, bestD = Infinity;
  const R = Math.ceil(maxR / CELL);
  for (let r = 0; r <= R; r++) {
    for (let ix = gx - r; ix <= gx + r; ix++) for (let iz = gz - r; iz <= gz + r; iz++) {
      if (Math.max(Math.abs(ix - gx), Math.abs(iz - gz)) !== r) continue;
      const cell = grid.get(key(ix, iz));
      if (!cell) continue;
      for (const i of cell) {
        if (around >= 0 && idxDist(i, around) <= excl) continue;
        const dx = cx(i) - x, dz = cz(i) - z, d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    // a hit within the scanned ring radius cannot be beaten by farther rings
    if (best >= 0 && Math.sqrt(bestD) <= r * CELL) break;
  }
  return { i: best, d: Math.sqrt(bestD) };
}

// lowest track elevation within r metres (the ground must stay under every
// nearby section, even where two run side by side at different heights)
export function minElevNear(x, z, r = 9) {
  const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL), R = Math.ceil(r / CELL);
  let m = Infinity;
  for (let ix = gx - R; ix <= gx + R; ix++) for (let iz = gz - R; iz <= gz + R; iz++) {
    const cell = grid.get(key(ix, iz));
    if (!cell) continue;
    for (const i of cell) {
      const dx = cx(i) - x, dz = cz(i) - z;
      if (dx * dx + dz * dz <= r * r && ELEV[i] < m) m = ELEV[i];
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// Projection of a world point onto the track near a hint index.
// Returns index, continuous along-offset, signed lateral offset and elevation.
// ---------------------------------------------------------------------------
export function project(x, z, hint = -1, out = {}) {
  let best = -1, bestD = Infinity;
  if (hint >= 0) {
    for (let d = -8; d <= 8; d++) {
      const i = wrap(hint + d);
      const dx = cx(i) - x, dz = cz(i) - z, dd = dx * dx + dz * dz;
      if (dd < bestD) { bestD = dd; best = i; }
    }
    // the window edge being nearest means we moved further than expected
    if (best === wrap(hint + 8) || best === wrap(hint - 8)) best = -1;
  }
  if (best < 0) best = nearestGlobal(x, z, -1, 0, 60).i;
  if (best < 0) best = 0;
  const dx = x - cx(best), dz = z - cz(best);
  const along = dx * FX[best] + dz * FZ[best];
  const lat = dx * RX[best] + dz * RZ[best];
  const j = along >= 0 ? wrap(best + 1) : wrap(best - 1);
  const t = Math.min(1, Math.abs(along));
  out.i = best;
  out.along = along;
  out.s = best + along;             // continuous distance along the lap (m)
  out.lat = lat;
  out.y = ELEV[best] * (1 - t) + ELEV[j] * t;
  return out;
}

// ---------------------------------------------------------------------------
// Corners & kerbs
// ---------------------------------------------------------------------------
export const CURV = (() => {
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = -6; k <= 6; k++) s += Math.abs(dAngle(heading(i + k), heading(i + k + 1)));
    raw[i] = s;
  }
  let mx = 0;
  for (let i = 0; i < N; i++) mx = Math.max(mx, raw[i]);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = -10; k <= 10; k++) s += raw[wrap(i + k)];
    out[i] = mx > 0 ? (s / 21) / mx : 0;
  }
  return out;
})();

export function cornerRuns(threshold) {
  const runs = [];
  let start = -1;
  // begin scanning on a straight so a run never straddles the wrap
  let s0 = 0;
  for (let i = 0; i < N; i++) if (CURV[i] < threshold) { s0 = i; break; }
  for (let k = 0; k <= N; k++) {
    const i = s0 + k;
    const on = k < N && CURV[wrap(i)] >= threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { if (i - start >= 8) runs.push([start, i]); start = -1; }
  }
  return runs.map(([a, b]) => {
    let turn = 0;
    for (let i = a; i < b; i++) turn += dAngle(heading(i), heading(i + 1));
    return { a, b, turn };   // turn > 0 = left-hander
  });
}

export const KERB_W = 0.55;
export const KERB = new Uint8Array(N);   // bit0 = left kerb, bit1 = right kerb
export const KERB_RUNS = cornerRuns(0.30);
for (const { a, b } of KERB_RUNS) for (let i = a; i <= b; i++) KERB[wrap(i)] = 3;

// ---------------------------------------------------------------------------
// Barriers. Sections of this circuit run as close as 6 m apart, so a barrier
// sits on the line equidistant between neighbouring sections (shared), and
// elsewhere at a fixed run-off distance beyond the tarmac edge (perimeter).
// ---------------------------------------------------------------------------
export const RUNOFF = 4.2;
export const BAR_L = new Float32Array(N), BAR_R = new Float32Array(N);
export const SHARED_L = new Int32Array(N).fill(-1), SHARED_R = new Int32Array(N).fill(-1);
{
  const rawL = new Float32Array(N), rawR = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    for (const side of [-1, 1]) {
      const max = halfWidth(i, side) + RUNOFF;
      let bar = max, shared = -1;
      for (let o = 0.5; o <= max; o += 0.1) {
        const x = cx(i) + RX[i] * o * side, z = cz(i) + RZ[i] * o * side;
        const f = nearestGlobal(x, z, i, 24, 12);
        if (f.i >= 0 && f.d <= o) { bar = o; shared = f.i; break; }
      }
      if (side < 0) { rawL[i] = bar; SHARED_L[i] = shared; } else { rawR[i] = bar; SHARED_R[i] = shared; }
    }
  }
  // smooth: local minimum then a short average, so the wall line is clean
  for (const [raw, out] of [[rawL, BAR_L], [rawR, BAR_R]]) {
    const mn = new Float32Array(N);
    for (let i = 0; i < N; i++) { let m = Infinity; for (let d = -2; d <= 2; d++) m = Math.min(m, raw[wrap(i + d)]); mn[i] = m; }
    for (let i = 0; i < N; i++) { let s = 0; for (let d = -2; d <= 2; d++) s += mn[wrap(i + d)]; out[i] = Math.max(2.9, s / 5); }
  }
}
export const barrierAt = (i, side) => side < 0 ? BAR_L[wrap(i)] : BAR_R[wrap(i)];

// ---------------------------------------------------------------------------
// Racing line: an elastic band relaxed within the usable width — close to a
// minimum-curvature line — then a speed profile along it.
// ---------------------------------------------------------------------------
export const LINE = new Float32Array(N);     // lateral offset of the racing line
export const LINE_X = new Float32Array(N), LINE_Z = new Float32Array(N);
export const LINE_K = new Float32Array(N);   // signed curvature (1/m), + = left
{
  const MARGIN = 0.85;
  const lo = new Float32Array(N), hi = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    lo[i] = -(Math.min(halfWidth(i, -1), BAR_L[i]) - MARGIN);
    hi[i] = Math.min(halfWidth(i, 1), BAR_R[i]) - MARGIN;
  }
  const px = new Float32Array(N), pz = new Float32Array(N);
  const place = i => { px[i] = cx(i) + RX[i] * LINE[i]; pz[i] = cz(i) + RZ[i] * LINE[i]; };
  for (let i = 0; i < N; i++) place(i);
  // biharmonic relaxation (minimises squared curvature) at decreasing scales
  for (const [k, iters] of [[12, 400], [6, 600]]) {
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < N; i++) {
        const a = wrap(i - 2 * k), b = wrap(i - k), c = wrap(i + k), d = wrap(i + 2 * k);
        const mx = (4 * (px[b] + px[c]) - px[a] - px[d]) / 6;
        const mz = (4 * (pz[b] + pz[c]) - pz[a] - pz[d]) / 6;
        const off = (mx - cx(i)) * RX[i] + (mz - cz(i)) * RZ[i];
        LINE[i] = Math.max(lo[i], Math.min(hi[i], LINE[i] + 0.5 * (off - LINE[i])));
        place(i);
      }
    }
  }
  for (let i = 0; i < N; i++) { LINE_X[i] = px[i]; LINE_Z[i] = pz[i]; }
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = wrap(i - 5), b = wrap(i + 5);
    const ax = px[i] - px[a], az = pz[i] - pz[a], bx = px[b] - px[i], bz = pz[b] - pz[i];
    const cross = ax * bz - az * bx;                // + = turning right in (x,z)
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz), lc = Math.hypot(px[b] - px[a], pz[b] - pz[a]);
    raw[i] = -2 * cross / Math.max(1e-6, la * lb * lc);
  }
  for (let i = 0; i < N; i++) { let s = 0; for (let d = -3; d <= 3; d++) s += raw[wrap(i + d)]; LINE_K[i] = s / 7; }
}

// Speed profile for a given grip and acceleration envelope.
export function speedProfile({ mu = 1.0, vTop = 21, aBrake = 6, accel = v => 4 } = {}) {
  const v = new Float32Array(N);
  for (let i = 0; i < N; i++) v[i] = Math.min(vTop, Math.sqrt(mu * 9.81 / Math.max(1e-4, Math.abs(LINE_K[i]))));
  const ds = i => Math.hypot(LINE_X[wrap(i + 1)] - LINE_X[i], LINE_Z[wrap(i + 1)] - LINE_Z[i]);
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 2 * N; k >= 0; k--) {
      const i = wrap(k), j = wrap(k + 1);
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * aBrake * ds(i)));
    }
    for (let k = 0; k <= 2 * N; k++) {
      const i = wrap(k), j = wrap(k - 1);
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * accel(v[j]) * ds(j)));
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// Start grid: staggered two-wide, behind the line.
// ---------------------------------------------------------------------------
export function gridSlot(k) {
  const row = Math.floor(k / 2), side = (k % 2) ? 1 : -1;
  const i = wrap(-5 - row * 4 - (k % 2) * 2);
  const lat = side * 1.55;
  return { x: cx(i) + RX[i] * lat, z: cz(i) + RZ[i] * lat, yaw: heading(i), i };
}

// Fresh spot on the racing line at (or slightly before) index i.
export function respawnPose(i) {
  i = wrap(i);
  if (i >= 3) i -= 2;              // never put a kart back across the line
  const lat = Math.max(-1.6, Math.min(1.6, LINE[i]));
  return { x: cx(i) + RX[i] * lat, z: cz(i) + RZ[i] * lat, yaw: heading(i), i };
}

export const LAP_LENGTH = (() => {
  let s = 0;
  for (let i = 0; i < N; i++) s += Math.hypot(cx(i + 1) - cx(i), cz(i + 1) - cz(i));
  return s;
})();
