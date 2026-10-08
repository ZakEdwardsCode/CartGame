// ============================================================================
// The circuit and its surroundings: sky, light, terrain, tarmac with a
// rubbered-in racing line, kerbs, barriers with banner belts, fencing, the
// covered bridge, start gantry with working lights, clubhouse, grandstand,
// pit shelter, trees and Cornish hedges.
// ============================================================================

import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import {
  N, wrap, cx, cz, heading, halfWidth, ELEV, ELEV_MEAN, RX, RZ, FX, FZ, CURV, KERB_RUNS, KERB_W,
  BAR_L, BAR_R, SHARED_L, SHARED_R, LINE, COVERED_AT, BOUNDS, nearestGlobal, gridSlot,
} from "./track.js";
import { buildKart } from "./kart-model.js";
import { mulberry32 } from "./ai.js";

const PH = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k";

export const QUALITY = {
  low:    { pixelRatio: 1.0, shadow: 1024, ssao: false, bloom: false, smaa: false, trees: 90,  tufts: 0,    aniso: 2, terrain: 110 },
  medium: { pixelRatio: 1.5, shadow: 2048, ssao: false, bloom: true,  smaa: true,  trees: 260, tufts: 2500, aniso: 8 },
  high:   { pixelRatio: 2.0, shadow: 4096, ssao: true,  bloom: true,  smaa: true,  trees: 420, tufts: 7000, aniso: 16 },
};

// ---------------------------------------------------------------------------
// textures
// ---------------------------------------------------------------------------
function canvasTex(w, h, draw, srgb = true, repeat = true) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function speckle(g, w, h, base, n, cols, size = 2) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  const r = mulberry32(7);
  for (let i = 0; i < n; i++) {
    g.fillStyle = cols[Math.floor(r() * cols.length)];
    g.fillRect(r() * w, r() * h, 1 + r() * size, 1 + r() * size);
  }
}
const FALLBACK = {
  asphalt_04: () => ({ map: canvasTex(256, 256, (g, w, h) => speckle(g, w, h, "#55565a", 9000, ["#3e3f43", "#6a6b70", "#47484c", "#7c7d80"])) }),
  aerial_grass_rock: () => ({ map: canvasTex(256, 256, (g, w, h) => speckle(g, w, h, "#5d7a3a", 12000, ["#4d6a2e", "#6e8b45", "#56733a", "#7a9450", "#43602a"], 3)) }),
  concrete_wall_008: () => ({ map: canvasTex(256, 256, (g, w, h) => speckle(g, w, h, "#a4a29b", 6000, ["#94928b", "#b3b1aa", "#8c8a84"])) }),
};

export function makeTextureLoader(renderer, onProgress) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin("anonymous");
  const aniso = renderer.capabilities.getMaxAnisotropy();
  let total = 0, done = 0;
  const one = (url, srgb) => {
    total++;
    return new Promise(resolve => {
      loader.load(url, t => {
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = aniso;
        done++; onProgress?.(done / total); resolve(t);
      }, undefined, () => { done++; onProgress?.(done / total); resolve(null); });
    });
  };
  return async function loadPBR(name, rx, ry) {
    const base = `${PH}/${name}/${name}`;
    let [map, normalMap, roughnessMap] = await Promise.all([
      one(`${base}_diff_1k.jpg`, true), one(`${base}_nor_gl_1k.jpg`, false), one(`${base}_rough_1k.jpg`, false),
    ]);
    if (!map) {  // offline / blocked CDN: procedural stand-ins
      const fb = FALLBACK[name] ? FALLBACK[name]() : {};
      map = fb.map || null;
      if (map) map.anisotropy = aniso;
    }
    const out = {};
    for (const [k, t] of Object.entries({ map, normalMap, roughnessMap })) {
      if (t) { t.repeat.set(rx, ry); out[k] = t; }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const clearance = (x, z) => nearestGlobal(x, z, -1, 0, 60).d;
const barOf = (i, side) => side < 0 ? BAR_L[wrap(i)] : BAR_R[wrap(i)];
const sharedOf = (i, side) => side < 0 ? SHARED_L[wrap(i)] : SHARED_R[wrap(i)];
const usable = (i, side) => Math.min(halfWidth(i, side), barOf(i, side));
const P = (i, off) => [cx(i) + RX[wrap(i)] * off, cz(i) + RZ[wrap(i)] * off];

function ribbon(points, heights, uvScale = 1) {
  // vertical ribbon along a list of [x,z,y] points; heights = [bottom, top]
  const pos = [], uv = [], idx = [];
  let run = 0;
  for (let k = 0; k < points.length; k++) {
    const [x, z, y] = points[k];
    if (k > 0) run += Math.hypot(x - points[k - 1][0], z - points[k - 1][1]);
    pos.push(x, y + heights[0], z, x, y + heights[1], z);
    uv.push(run * uvScale, 0, run * uvScale, 1);
    if (k > 0) { const a = (k - 1) * 2, b = k * 2; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// split a per-sample predicate into contiguous runs (handles the wrap)
function runsWhere(pred, minLen = 3) {
  let s0 = -1;
  for (let i = 0; i < N; i++) if (!pred(i)) { s0 = i; break; }
  if (s0 < 0) return [[0, N]];
  const out = [];
  let start = -1;
  for (let k = 1; k <= N; k++) {
    const i = s0 + k;
    const on = k < N && pred(wrap(i));
    if (on && start < 0) start = i;
    if (!on && start >= 0) { if (i - start >= minLen) out.push([start, i]); start = -1; }
  }
  return out;
}

// ---------------------------------------------------------------------------
export class TrackWorld {
  constructor(scene, renderer, quality) {
    this.scene = scene;
    this.renderer = renderer;
    this.q = QUALITY[quality] || QUALITY.medium;
    this.aniso = Math.min(this.q.aniso, renderer.capabilities.getMaxAnisotropy());
  }

  async build(onProgress, onStage) {
    this.buildSkyAndLight();
    onStage?.("fetching track surfaces…");
    const loadPBR = makeTextureLoader(this.renderer, onProgress);
    const [asphalt, grass, concrete] = await Promise.all([
      loadPBR("asphalt_04", 2, 1), loadPBR("aerial_grass_rock", 90, 90), loadPBR("concrete_wall_008", 2, 1),
    ]);
    onStage?.("building the circuit…");
    this.buildTerrain(grass);
    this.buildRoad(asphalt);
    this.buildLines();
    this.buildKerbs();
    this.buildBarriers();
    this.buildStart();
    this.buildBridge(concrete);
    onStage?.("planting the hedges…");
    this.buildFacilities(concrete);
    this.buildTrees();
    this.buildHedges(grass);
    if (this.q.tufts) this.buildTufts();
  }

  // --- sky, sun, environment --------------------------------------------------
  buildSkyAndLight() {
    const scene = this.scene;
    const sky = new Sky();
    sky.scale.setScalar(9000);
    const u = sky.material.uniforms;
    u.turbidity.value = 3.2; u.rayleigh.value = 1.4; u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;
    const sunPos = new THREE.Vector3();
    sunPos.setFromSphericalCoords(1, Math.PI / 2 - 38 * Math.PI / 180, 150 * Math.PI / 180);
    u.sunPosition.value.copy(sunPos);
    scene.add(sky);
    this.sunPos = sunPos;

    const sun = new THREE.DirectionalLight(0xfff1dc, 2.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.q.shadow, this.q.shadow);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.025;
    const c = sun.shadow.camera;
    c.left = -55; c.right = 55; c.top = 55; c.bottom = -55; c.near = 1; c.far = 400;
    scene.add(sun, sun.target);
    this.sun = sun;
    scene.add(new THREE.HemisphereLight(0xc4dcf4, 0x55663f, 0.35));

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    envSky.scale.setScalar(9000);
    Object.assign(envSky.material.uniforms.turbidity, { value: 3.2 });
    envSky.material.uniforms.rayleigh.value = 1.4;
    envSky.material.uniforms.sunPosition.value.copy(sunPos);
    envScene.add(envSky);
    scene.environment = pmrem.fromScene(envScene).texture;
    pmrem.dispose();
    scene.fog = new THREE.FogExp2(0xc3d2df, 0.0021);
  }

  // shadow camera follows the action
  follow(x, y, z) {
    this.sun.target.position.set(x, y, z);
    this.sun.position.copy(this.sunPos).multiplyScalar(200).add(this.sun.target.position);
  }

  // --- terrain ---------------------------------------------------------------
  buildTerrain(pbr) {
    const SIZE = 900, SEG = this.q.terrain || 220;
    const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const { mx, mz } = BOUNDS;
    const nearTrack = (x, z) => {
      // cheap reject for the far field before the spatial-hash query
      const ox = Math.max(BOUNDS.x0 - x, 0, x - BOUNDS.x1), oz = Math.max(BOUNDS.z0 - z, 0, z - BOUNDS.z1);
      if (ox * ox + oz * oz > 45 * 45) return { i: -1, d: 999 };
      return nearestGlobal(x, z, -1, 0, 40);
    };
    const rnd = (x, z) => Math.sin(x * 0.021 + z * 0.013) * 0.5 + Math.sin(x * 0.007 - z * 0.011) * 1.2 + Math.sin(z * 0.031) * 0.3;
    for (let v = 0; v < p.count; v++) {
      const x = p.getX(v) + mx, z = p.getZ(v) + mz;
      const n = nearTrack(x, z);
      const d = n.i >= 0 ? n.d : 999;
      const near = n.i >= 0 ? ELEV[n.i] : ELEV_MEAN;
      const t = Math.min(1, Math.max(0, (d - 12) / 90));
      const e = t * t * (3 - 2 * t);
      // flat near the circuit, rolling Cornish fields further out
      const far = Math.max(0, Math.hypot(x - mx, z - mz) - 150);
      const hills = rnd(x, z) * e + far * far * 0.00012 + Math.max(0, far - 80) * 0.03 * (1 + Math.sin(x * 0.01));
      p.setY(v, near * (1 - e) + ELEV_MEAN * e + hills - 0.06);
      p.setX(v, x); p.setZ(v, z);
      // mowing stripes inside the venue, rougher grass beyond
      const stripe = Math.floor((x * 0.8 + z * 0.6) / 5) & 1;
      const venue = 1 - Math.min(1, Math.max(0, (d - 20) / 25));
      let shade = 1 + (stripe ? 0.07 : -0.03) * venue + (rnd(x * 3, z * 3) * 0.04);
      const rough = 1 - venue;
      col[v * 3] = shade * (1 + rough * 0.08); col[v * 3 + 1] = shade * (1 - rough * 0.04); col[v * 3 + 2] = shade * (1 - rough * 0.12);
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8fa070, roughness: 1, metalness: 0, vertexColors: true, ...pbr });
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    this.scene.add(m);
    this.terrainHeight = (x, z) => {
      const n = nearTrack(x, z);
      const d = n.i >= 0 ? n.d : 999, near = n.i >= 0 ? ELEV[n.i] : ELEV_MEAN;
      const t = Math.min(1, Math.max(0, (d - 12) / 90)), e = t * t * (3 - 2 * t);
      const far = Math.max(0, Math.hypot(x - mx, z - mz) - 150);
      return near * (1 - e) + ELEV_MEAN * e + rnd(x, z) * e + far * far * 0.00012 + Math.max(0, far - 80) * 0.03 * (1 + Math.sin(x * 0.01)) - 0.06;
    };
  }

  // --- tarmac ----------------------------------------------------------------
  buildRoad(pbr) {
    const SHOULDER = 0.6, LANES = 11;
    const pos = [], uv = [], idx = [], col = [];
    let run = 0;
    for (let i = 0; i < N; i++) {
      const l = usable(i, -1), r = usable(i, 1), y = ELEV[i];
      const sl = BAR_L[i] - l > 0.9 ? SHOULDER : 0.05, sr = BAR_R[i] - r > 0.9 ? SHOULDER : 0.05;
      if (i > 0) run += Math.hypot(cx(i) - cx(i - 1), cz(i) - cz(i - 1));
      const patch = 0.95 + 0.05 * Math.sin(i * 0.031) + 0.03 * Math.sin(i * 0.13);
      for (let k = 0; k < LANES; k++) {
        let off, yy, shade;
        if (k === 0) { off = -(l + sl); yy = y - 0.09; shade = 0.85; }
        else if (k === LANES - 1) { off = r + sr; yy = y - 0.09; shade = 0.85; }
        else {
          const f = (k - 1) / (LANES - 3);
          off = -l + f * (l + r);
          yy = y + 0.04 * Math.sin(f * Math.PI);    // crown
          shade = 1.0;
        }
        const [x, z] = P(i, off);
        pos.push(x, yy, z);
        uv.push((off + 3.6) / 3.6, run / 3.6);
        const dl = Math.abs(off - LINE[i]);
        const rubber = Math.exp(-(dl * dl) / 0.8) * (0.16 + 0.22 * Math.min(1, CURV[i] * 1.8));
        const v = patch * shade * (1 - rubber);
        col.push(v, v, v * 1.01);
      }
    }
    for (let i = 0; i < N; i++) {
      const a = i * LANES, b = ((i + 1) % N) * LANES;
      for (let k = 0; k < LANES - 1; k++) idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x9a9a98, roughness: 0.95, metalness: 0, vertexColors: true, ...pbr });
    if (mat.normalScale) mat.normalScale.set(1.2, 1.2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  buildLines() {
    const W = 0.09;
    const mat = new THREE.MeshStandardMaterial({ color: 0xeeeee8, roughness: 0.7 });
    for (const side of [-1, 1]) {
      const pos = [], idx = [];
      for (let i = 0; i < N; i++) {
        const hw = usable(i, side) - 0.25, y = ELEV[i] + 0.012;
        for (const o of [hw - W, hw + W]) { const [x, z] = P(i, o * side); pos.push(x, y, z); }
      }
      for (let i = 0; i < N; i++) { const a = i * 2, b = ((i + 1) % N) * 2; idx.push(a, a + 1, b, a + 1, b + 1, b); }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }

  buildKerbs() {
    const tex = canvasTex(64, 256, (g) => {
      for (let i = 0; i < 4; i++) { g.fillStyle = (i % 2) ? "#e4e0d4" : "#c0342a"; g.fillRect(0, i * 64, 64, 64); }
      const r = mulberry32(3);
      for (let i = 0; i < 2500; i++) { g.fillStyle = r() < 0.5 ? "rgba(40,36,30,0.25)" : "rgba(255,255,255,0.08)"; g.fillRect(r() * 64, r() * 256, 1 + r() * 2, 1 + r() * 2); }
    });
    tex.anisotropy = this.aniso;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 });
    for (const { a, b } of KERB_RUNS) {
      for (const side of [-1, 1]) {
        // only where there's room before the barrier
        const pos = [], uv = [], idx = [];
        let rows = 0, vRun = 0, prev = null;
        const flush = () => {
          if (rows >= 2) {
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
            g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
            g.setIndex(idx);
            g.computeVertexNormals();
            const m = new THREE.Mesh(g, mat);
            m.receiveShadow = true; m.castShadow = true;
            this.scene.add(m);
          }
          pos.length = 0; uv.length = 0; idx.length = 0; rows = 0;
        };
        for (let i = a; i <= b; i++) {
          const hw = halfWidth(i, side);
          if (barOf(i, side) < hw + KERB_W + 0.2) { flush(); prev = null; continue; }
          const y = ELEV[wrap(i)];
          const [x0, z0] = P(i, hw * side);
          if (prev) vRun += Math.hypot(x0 - prev[0], z0 - prev[1]);
          prev = [x0, z0];
          for (const [off, dy, u] of [[hw - 0.02, 0.006, 0], [hw + KERB_W * 0.5, 0.055, 0.5], [hw + KERB_W, 0.02, 1]]) {
            const [x, z] = P(i, off * side);
            pos.push(x, y + dy, z); uv.push(u, vRun / 2);
          }
          if (rows > 0) { const p = (rows - 1) * 3, q = rows * 3; for (let l = 0; l < 2; l++) idx.push(p + l, p + l + 1, q + l, p + l + 1, q + l + 1, q + l); }
          rows++;
        }
        flush();
      }
    }
  }

  // --- barriers --------------------------------------------------------------
  buildBarriers() {
    // banner belt texture for the tyre walls
    const words = ["COAST 2 COAST KARTING", "HAYLE", "ST ERTH · CORNWALL", "C2C", "RACE DAY"];
    const belt = canvasTex(1024, 64, (g, w, h) => {
      const cols = ["#163a7a", "#c0342a", "#1b1b1f", "#e6a417", "#0f6b4a"];
      let x = 0, k = 0;
      while (x < w) {
        const text = words[k % words.length], bw = 70 + text.length * 17;
        g.fillStyle = cols[k % cols.length]; g.fillRect(x, 0, bw, h);
        g.fillStyle = k % cols.length === 3 ? "#111" : "#fff";
        g.font = "800 30px system-ui, Arial, sans-serif"; g.textBaseline = "middle";
        g.fillText(text, x + 30, h / 2 + 1);
        x += bw; k++;
      }
    });
    belt.anisotropy = this.aniso;
    const beltMat = new THREE.MeshStandardMaterial({ map: belt, roughness: 0.7, side: THREE.DoubleSide });

    const tyreGeo = new THREE.TorusGeometry(0.25, 0.11, 8, 16); tyreGeo.rotateX(Math.PI / 2);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.95 });
    const blockGeo = new THREE.BoxGeometry(0.42, 0.62, 1.0);
    blockGeo.translate(0, 0.31, 0);
    const blockMat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0 });
    const tyres = [], blocks = [], blockCols = [];
    const fencePosts = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s1 = new THREE.Vector3(1, 1, 1);
    const red = new THREE.Color(0xc8322a), white = new THREE.Color(0xeeeeea);

    for (const side of [-1, 1]) {
      // shared: plastic barrier blocks (draw each shared line once)
      let n = 0;
      for (let i = 0; i < N; i++) {
        const sh = sharedOf(i, side);
        if (sh < 0 || sh < i) continue;
        const b = barOf(i, side);
        const [x, z] = P(i, b * side);
        q.setFromAxisAngle(up, heading(i) + Math.PI / 2);
        m4.compose(new THREE.Vector3(x, ELEV[i] - 0.02, z), q, s1);
        blocks.push(m4.clone());
        blockCols.push((n++ % 2) ? white : red);
      }
      // perimeter: tyre wall with a belt in front, fence behind if it's the outside world
      const runs = runsWhere(i => sharedOf(i, side) < 0, 4);
      for (const [a, b] of runs) {
        const front = [], fence = [];
        for (let k = a; k <= b; k++) {
          const i = wrap(k), bar = barOf(i, side);
          const [x, z] = P(i, (bar + 0.25) * side);
          const [fx, fz] = P(i, (bar - 0.08) * side);
          front.push([fx, fz, ELEV[i]]);
          if (k % 1 === 0) for (const h of [0.12, 0.36]) {
            m4.compose(new THREE.Vector3(x, ELEV[i] + h, z), q.identity(), s1);
            tyres.push(m4.clone());
          }
          // outside world? nothing else within 30 m beyond the wall
          const [ox, oz] = P(i, (bar + 14) * side);
          if (nearestGlobal(ox, oz, -1, 0, 16).i < 0) fence.push(k);
        }
        const g = ribbon(front, [0.02, 0.56], 1 / 10.5);
        const belt = new THREE.Mesh(g, beltMat);
        belt.castShadow = true; belt.receiveShadow = true;
        this.scene.add(belt);
        // fence runs
        let fr = [];
        const flushFence = () => {
          if (fr.length > 3) {
            const pts = fr.map(k => { const i = wrap(k), [x, z] = P(i, (barOf(i, side) + 2.4) * side); return [x, z, ELEV[i]]; });
            this.addFence(pts, fencePosts);
          }
          fr = [];
        };
        for (const k of fence) { if (fr.length && k !== fr[fr.length - 1] + 1) flushFence(); fr.push(k); }
        flushFence();
      }
    }
    const tyreInst = new THREE.InstancedMesh(tyreGeo, tyreMat, tyres.length);
    tyres.forEach((m, k) => tyreInst.setMatrixAt(k, m));
    tyreInst.castShadow = true; tyreInst.receiveShadow = true;
    this.scene.add(tyreInst);
    const blockInst = new THREE.InstancedMesh(blockGeo, blockMat, blocks.length);
    blocks.forEach((m, k) => { blockInst.setMatrixAt(k, m); blockInst.setColorAt(k, blockCols[k]); });
    blockInst.castShadow = true; blockInst.receiveShadow = true;
    this.scene.add(blockInst);
    const postGeo = new THREE.CylinderGeometry(0.035, 0.035, 2.2, 6); postGeo.translate(0, 1.1, 0);
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x6d7378, roughness: 0.5, metalness: 0.7 }), fencePosts.length);
    fencePosts.forEach((m, k) => posts.setMatrixAt(k, m));
    posts.castShadow = true;
    this.scene.add(posts);
  }

  addFence(pts, posts) {
    if (!this.fenceMat) {
      const t = canvasTex(64, 64, (g, w, h) => {
        g.clearRect(0, 0, w, h);
        g.strokeStyle = "rgba(170,178,184,1)"; g.lineWidth = 2.2;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();
      }, true);
      this.fenceMat = new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5 });
      this.fenceMat.map.repeat.set(1, 1);
    }
    const g = ribbon(pts, [0, 2.0], 1 / 0.16);
    // uv v spans 0..1 over 2 m; repeat the diamond every 0.16 m vertically too
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) * 12.5);
    const m = new THREE.Mesh(g, this.fenceMat);
    this.scene.add(m);
    const m4 = new THREE.Matrix4();
    let acc = 99;
    for (let k = 1; k < pts.length; k++) {
      acc += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (acc >= 3) { acc = 0; m4.makeTranslation(pts[k][0], pts[k][2] - 0.05, pts[k][1]); posts.push(m4.clone()); }
    }
  }

  // --- start / finish ---------------------------------------------------------
  buildStart() {
    const i = 0, h = heading(0);
    // group-local +x is the track's LEFT, so the usable span's centre is at (l - r) / 2
    const l = usable(0, -1), r = usable(0, 1), w = l + r, mid = (l - r) / 2;
    const grp = new THREE.Group();
    const chk = canvasTex(512, 64, (g) => {
      for (let a = 0; a < 16; a++) for (let b = 0; b < 2; b++) { g.fillStyle = ((a + b) % 2) ? "#f2f2ef" : "#17171a"; g.fillRect(a * 32, b * 32, 32, 32); }
    }, true, false);
    chk.anisotropy = this.aniso;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.2), new THREE.MeshStandardMaterial({ map: chk, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2 }));
    line.rotation.x = -Math.PI / 2; line.position.set(mid, 0.05, 0);
    line.receiveShadow = true;
    grp.add(line);

    // gantry
    const steel = new THREE.MeshStandardMaterial({ color: 0xd5d8db, roughness: 0.35, metalness: 0.8 });
    const span = w + 2.2;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 4.6, 0.22), steel);
      post.position.set(mid + s * span / 2, 2.3, 0); post.castShadow = true; grp.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span + 0.3, 0.7, 0.3), new THREE.MeshStandardMaterial({ color: 0x1d2a44, roughness: 0.5 }));
    beam.position.set(mid, 4.35, 0); beam.castShadow = true; grp.add(beam);
    const sign = canvasTex(512, 64, (g, W, H) => {
      g.fillStyle = "#1d2a44"; g.fillRect(0, 0, W, H);
      g.fillStyle = "#ffb020"; g.font = "900 40px system-ui, Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("COAST 2 COAST KARTING", W / 2, H / 2 + 2);
    }, true, false);
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(span * 0.9, 0.55), new THREE.MeshStandardMaterial({ map: sign, roughness: 0.6 }));
      p.position.set(mid, 4.35, s * 0.16); if (s < 0) p.rotation.y = Math.PI; grp.add(p);
    }
    // start lights: 5 pods, each with two red lamps
    this.lights = [];
    const pod = new THREE.BoxGeometry(0.34, 0.62, 0.22), lamp = new THREE.SphereGeometry(0.1, 14, 10);
    const podMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.6 });
    for (let k = 0; k < 5; k++) {
      const pm = new THREE.Mesh(pod, podMat);
      const x = mid + (k - 2) * 0.48;
      pm.position.set(x, 3.65, -0.05); pm.castShadow = true; grp.add(pm);
      const lamps = [];
      for (const dy of [0.14, -0.14]) {
        const lm = new THREE.Mesh(lamp, new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1a10, emissiveIntensity: 0 }));
        lm.position.set(x, 3.65 + dy, -0.17); grp.add(lm); lamps.push(lm);
      }
      this.lights.push(lamps);
    }
    // grid boxes
    const gridMat = new THREE.MeshStandardMaterial({ color: 0xeeeee8, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 });
    grp.position.set(cx(i), ELEV[i], cz(i));
    grp.rotation.y = h + Math.PI / 2;
    this.scene.add(grp);
    for (let k = 0; k < 8; k++) {
      const s = gridSlot(k);
      const box = new THREE.Group();
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.1), gridMat);
      bar.rotation.x = -Math.PI / 2; bar.position.set(0, 0.03, 1.35); box.add(bar);
      for (const sx of [-0.65, 0.65]) {
        const leg = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.6), gridMat);
        leg.rotation.x = -Math.PI / 2; leg.position.set(sx, 0.03, 1.05); box.add(leg);
      }
      box.position.set(s.x, ELEV[s.i], s.z);
      box.rotation.y = s.yaw + Math.PI / 2;
      this.scene.add(box);
    }
  }

  // n = how many red pods are lit (0..5); green=true clears them
  setStartLights(n) {
    if (!this.lights) return;
    this.lights.forEach((lamps, k) => lamps.forEach(l => {
      l.material.emissiveIntensity = k < n ? 5 : 0;
      l.material.color.setHex(k < n ? 0xff2010 : 0x220000);
    }));
  }

  // --- the covered section ----------------------------------------------------
  buildBridge(pbr) {
    if (typeof COVERED_AT !== "number") return;
    const i = COVERED_AT, h = heading(i);
    const l = usable(i, -1), r = usable(i, 1), w = l + r, mid = (l - r) / 2;
    const SPAN = w + 3.0, DEPTH = 6.0, CLEAR = 3.3;
    const grp = new THREE.Group();
    const conc = new THREE.MeshStandardMaterial({ color: 0xb0ada5, roughness: 0.92, ...pbr });
    const timber = new THREE.MeshStandardMaterial({ color: 0x6b4f35, roughness: 0.85 });
    for (const s of [-1, 1]) {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(1.0, CLEAR, DEPTH), conc);
      pier.position.set(mid + s * (w / 2 + 0.6), CLEAR / 2, 0);
      pier.castShadow = pier.receiveShadow = true; grp.add(pier);
    }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(SPAN, 0.7, DEPTH), conc);
    deck.position.set(mid, CLEAR + 0.35, 0); deck.castShadow = deck.receiveShadow = true; grp.add(deck);
    // a timber-clad viewing room on top, like the building mapped over the track
    const room = new THREE.Mesh(new THREE.BoxGeometry(SPAN - 0.6, 2.4, DEPTH - 1.2), timber);
    room.position.set(mid, CLEAR + 1.9, 0); room.castShadow = room.receiveShadow = true; grp.add(room);
    const glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.05, metalness: 0.9 });
    for (const s of [-1, 1]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(SPAN - 1.6, 1.0), glass);
      win.position.set(mid, CLEAR + 2.1, s * (DEPTH / 2 - 0.59)); if (s < 0) win.rotation.y = Math.PI; grp.add(win);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(SPAN + 0.4, 0.18, DEPTH + 0.2), new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.6, metalness: 0.4 }));
    roof.position.set(mid, CLEAR + 3.2, 0); roof.castShadow = true; grp.add(roof);
    // the underside is dark
    const shade = new THREE.Mesh(new THREE.PlaneGeometry(w + 1.0, DEPTH), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }));
    shade.rotation.x = -Math.PI / 2; shade.position.set(mid, 0.06, 0); grp.add(shade);
    grp.position.set(cx(i), ELEV[i], cz(i));
    grp.rotation.y = h + Math.PI / 2;
    this.scene.add(grp);
  }

  // --- clubhouse, grandstand, pit shelter -------------------------------------
  buildFacilities(concretePbr) {
    // nearest roomy spot to the start line, then face the nearest straight
    const sx = cx(0), sz = cz(0);
    let best = null;
    for (let x = sx - 90; x <= sx + 90; x += 2) for (let z = sz - 90; z <= sz + 90; z += 2) {
      if (clearance(x, z) < 15) continue;
      // the whole footprint must be clear
      let ok = true;
      for (const [dx, dz] of [[-9, -6], [9, -6], [-9, 6], [9, 6]]) if (clearance(x + dx, z + dz) < 7) { ok = false; break; }
      if (!ok) continue;
      const d = Math.hypot(x - sx, z - sz);
      if (!best || d < best.d) best = { x, z, d };
    }
    if (!best) return;
    const n = nearestGlobal(best.x, best.z, -1, 0, 80).i;
    // face the track: building's front (+z local) points at the nearest sample
    const ang = Math.atan2(cx(n) - best.x, cz(n) - best.z);
    const y = this.terrainHeight(best.x, best.z);
    const grp = new THREE.Group();
    grp.position.set(best.x, y, best.z);
    grp.rotation.y = ang;
    this.scene.add(grp);

    const wall = new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.9 });
    const clad = new THREE.MeshStandardMaterial({ color: 0x24456e, roughness: 0.6, metalness: 0.3 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1e2a36, roughness: 0.04, metalness: 0.95 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(22, 0.2, 16), new THREE.MeshStandardMaterial({ color: 0x5a5b5e, roughness: 0.9, ...concretePbr }));
    slab.position.set(0, 0.0, 0); slab.receiveShadow = true; grp.add(slab);

    // clubhouse: two storeys, glazed front, sign
    const club = new THREE.Group(); club.position.set(-3, 0, -3); grp.add(club);
    const body = new THREE.Mesh(new THREE.BoxGeometry(12, 5.4, 7), wall);
    body.position.y = 2.7; body.castShadow = body.receiveShadow = true; club.add(body);
    const band = new THREE.Mesh(new THREE.BoxGeometry(12.2, 1.0, 7.2), clad);
    band.position.y = 5.0; band.castShadow = true; club.add(band);
    for (const yy of [1.35, 3.6]) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 1.5), glass);
      win.position.set(0, yy, 3.51); club.add(win);
    }
    const signTex = canvasTex(1024, 128, (g, W, H) => {
      g.fillStyle = "#24456e"; g.fillRect(0, 0, W, H);
      g.fillStyle = "#ffffff"; g.font = "900 72px system-ui, Arial, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("COAST 2 COAST KARTING", W / 2, H / 2 + 4);
    }, true, false);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(11, 1.0), new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.5 }));
    sign.position.set(0, 5.0, 3.62); club.add(sign);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(13, 0.25, 8), new THREE.MeshStandardMaterial({ color: 0x2f3338, roughness: 0.7 }));
    roof.position.y = 5.6; roof.castShadow = true; club.add(roof);
    // balcony
    const balc = new THREE.Mesh(new THREE.BoxGeometry(12, 0.15, 1.6), wall);
    balc.position.set(0, 2.9, 4.3); balc.castShadow = true; club.add(balc);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(12, 0.9, 0.05), glass);
    rail.position.set(0, 3.4, 5.08); club.add(rail);

    // grandstand: stepped bench seating in front of the clubhouse
    const stand = new THREE.Group(); stand.position.set(-3, 0, 5.2); grp.add(stand);
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x8b8f94, roughness: 0.7, metalness: 0.3 });
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x1f6fb2, roughness: 0.5 });
    for (let row = 0; row < 4; row++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(10, 0.45 * (row + 1), 0.8), seatMat);
      step.position.set(0, 0.225 * (row + 1), -row * 0.8); step.castShadow = step.receiveShadow = true; stand.add(step);
      const bench = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.08, 0.35), benchMat);
      bench.position.set(0, 0.45 * (row + 1) + 0.04, -row * 0.8 - 0.1); stand.add(bench);
    }

    // pit shelter with parked karts
    const pits = new THREE.Group(); pits.position.set(7.5, 0, -1); grp.add(pits);
    const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, roughness: 0.4, metalness: 0.8 });
    for (const [px, pz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3, 8), steel);
      post.position.set(px, 1.5, pz); post.castShadow = true; pits.add(post);
    }
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(7, 0.15, 7.2), new THREE.MeshStandardMaterial({ color: 0xc0342a, roughness: 0.6 }));
    canopy.position.set(0, 3.05, 0); canopy.rotation.x = 0.06; canopy.castShadow = true; pits.add(canopy);
    const liveries = ["#d8202a", "#1f6fb2", "#e6a417", "#2a9d5b", "#7a3fb8", "#f06d1a"];
    for (let k = 0; k < 6; k++) {
      const kart = buildKart({ color: liveries[k], number: 20 + k });
      kart.userData.driver.visible = false;
      kart.position.set(-2.4 + (k % 3) * 2.4, 0.01, k < 3 ? -1.4 : 1.4);
      kart.rotation.y = Math.PI;
      pits.add(kart);
    }
    this.facility = { x: best.x, z: best.z, r: 16 };
  }

  // --- vegetation -------------------------------------------------------------
  buildTrees() {
    const r = mulberry32(42);
    const { mx, mz } = BOUNDS;
    const spots = [];
    let tries = 0;
    while (spots.length < this.q.trees && tries < this.q.trees * 60) {
      tries++;
      const a = r() * Math.PI * 2, d = 60 + Math.pow(r(), 0.7) * 230;
      const x = mx + Math.cos(a) * d * 1.15, z = mz + Math.sin(a) * d;
      if (clearance(x, z) < 16) continue;
      if (this.facility && Math.hypot(x - this.facility.x, z - this.facility.z) < this.facility.r) continue;
      spots.push([x, z]);
    }
    // clumps inside the infield pockets too, where there's room
    for (let k = 0; k < 400 && spots.length < this.q.trees * 1.1; k++) {
      const x = BOUNDS.x0 + r() * (BOUNDS.x1 - BOUNDS.x0), z = BOUNDS.z0 + r() * (BOUNDS.z1 - BOUNDS.z0);
      if (clearance(x, z) < 13) continue;
      if (this.facility && Math.hypot(x - this.facility.x, z - this.facility.z) < this.facility.r) continue;
      spots.push([x, z]);
    }
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 3.2, 7); trunkGeo.translate(0, 1.6, 0);
    const leafGeo = new THREE.IcosahedronGeometry(1.8, 2);
    {
      const p = leafGeo.attributes.position, v = new THREE.Vector3();
      for (let k = 0; k < p.count; k++) {
        v.fromBufferAttribute(p, k);
        const n = 1 + 0.18 * Math.sin(v.x * 3.1 + v.y * 1.7) + 0.12 * Math.sin(v.z * 4.3 - v.y * 2.1);
        v.multiplyScalar(n); v.y *= 0.85;
        p.setXYZ(k, v.x, v.y, v.z);
      }
      leafGeo.computeVertexNormals();
    }
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.95 }), spots.length);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }), spots.length * 2);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const greens = [0x3f6a2c, 0x4b7a31, 0x35592a, 0x5a7f38, 0x2f4f25].map(c => new THREE.Color(c));
    spots.forEach(([x, z], k) => {
      const y = this.terrainHeight(x, z);
      const sc = 0.8 + r() * 0.9;
      q.setFromAxisAngle(up, r() * 6.28);
      s.set(sc, sc * (0.9 + r() * 0.4), sc);
      m4.compose(new THREE.Vector3(x, y, z), q, s); trunks.setMatrixAt(k, m4);
      for (let j = 0; j < 2; j++) {
        const ls = sc * (j ? 0.75 : 1.05);
        s.set(ls * (1 + r() * 0.3), ls, ls * (1 + r() * 0.3));
        m4.compose(new THREE.Vector3(x + (r() - 0.5) * 0.8 * sc, y + sc * (3.4 + j * 1.3), z + (r() - 0.5) * 0.8 * sc), q, s);
        leaves.setMatrixAt(k * 2 + j, m4);
        leaves.setColorAt(k * 2 + j, greens[Math.floor(r() * greens.length)]);
      }
    });
    for (const im of [trunks, leaves]) { im.castShadow = true; im.receiveShadow = true; this.scene.add(im); }
  }

  buildHedges(grassPbr) {
    // a Cornish hedge (earth bank) around the venue, as an offset of the
    // bounding box with rounded corners
    const { x0, x1, z0, z1 } = BOUNDS, M = 22, R = 14;
    const pts = [];
    const corner = (cx_, cz_, a0) => { for (let k = 0; k <= 8; k++) { const a = a0 + k / 8 * Math.PI / 2; pts.push([cx_ + Math.cos(a) * R, cz_ + Math.sin(a) * R]); } };
    corner(x1 + M - R, z1 + M - R, 0);
    corner(x0 - M + R, z1 + M - R, Math.PI / 2);
    corner(x0 - M + R, z0 - M + R, Math.PI);
    corner(x1 + M - R, z0 - M + R, Math.PI * 1.5);
    // resample + profile sweep
    const path = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(d / 2));
      for (let j = 0; j < n; j++) path.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]);
    }
    const prof = [[-1.4, 0], [-1.0, 0.9], [-0.5, 1.5], [0, 1.65], [0.5, 1.5], [1.0, 0.9], [1.4, 0]];
    const pos = [], uv = [], idx = [];
    const r = mulberry32(5);
    path.forEach(([x, z], k) => {
      const [nx2, nz2] = path[(k + 1) % path.length];
      let dx = nx2 - x, dz = nz2 - z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const rx = -dz, rz = dx, y = this.terrainHeight(x, z), wob = 0.85 + r() * 0.3;
      prof.forEach(([o, h], j) => { pos.push(x + rx * o, y + h * wob, z + rz * o); uv.push(j / 2, k / 2); });
    });
    const P2 = prof.length;
    for (let k = 0; k < path.length; k++) {
      const a = k * P2, b = ((k + 1) % path.length) * P2;
      for (let j = 0; j < P2 - 1; j++) idx.push(a + j, b + j, a + j + 1, a + j + 1, b + j, b + j + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x5f7e3c, roughness: 1, map: grassPbr.map ? grassPbr.map.clone() : null, side: THREE.DoubleSide });
    if (mat.map) { mat.map.repeat.set(1, 1); mat.map.needsUpdate = true; }
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true; m.receiveShadow = true;
    this.scene.add(m);
  }

  buildTufts() {
    // small crossed-quad grass tufts scattered on the verges
    const tex = canvasTex(64, 64, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      const r = mulberry32(11);
      for (let k = 0; k < 26; k++) {
        const x = 8 + r() * 48, lean = (r() - 0.5) * 14;
        g.strokeStyle = `rgba(${70 + r() * 40 | 0},${110 + r() * 50 | 0},${40 + r() * 20 | 0},1)`;
        g.lineWidth = 2; g.beginPath(); g.moveTo(x, h); g.quadraticCurveTo(x + lean * 0.3, h * 0.5, x + lean, 6 + r() * 20); g.stroke();
      }
    }, true, false);
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 1 });
    const geo = new THREE.BufferGeometry();
    const a = new THREE.PlaneGeometry(0.6, 0.35); a.translate(0, 0.17, 0);
    const b = a.clone(); b.rotateY(Math.PI / 2);
    geo.copy(mergeTwo(a, b));
    const r = mulberry32(99);
    const list = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3();
    for (let k = 0; k < this.q.tufts * 4 && list.length < this.q.tufts; k++) {
      const i = Math.floor(r() * N), side = r() < 0.5 ? -1 : 1;
      const hw = usable(i, side), bar = barOf(i, side);
      if (bar - hw < 1.2) continue;
      const off = hw + 0.7 + r() * (bar - hw - 0.9);
      const [x, z] = P(i, off * side);
      q.setFromAxisAngle(up, r() * 6.28);
      const sc = 0.7 + r() * 0.8;
      s.set(sc, sc, sc);
      m4.compose(new THREE.Vector3(x, ELEV[i] - 0.05, z), q, s);
      list.push(m4.clone());
    }
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, k) => im.setMatrixAt(k, m));
    im.receiveShadow = true;
    this.scene.add(im);
  }
}

function mergeTwo(a, b) {
  const g = new THREE.BufferGeometry();
  const pa = a.attributes.position.array, pb = b.attributes.position.array;
  const na = a.attributes.normal.array, nb = b.attributes.normal.array;
  const ua = a.attributes.uv.array, ub = b.attributes.uv.array;
  const ia = a.index.array, ib = b.index.array;
  const off = a.attributes.position.count;
  g.setAttribute("position", new THREE.Float32BufferAttribute([...pa, ...pb], 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute([...na, ...nb], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([...ua, ...ub], 2));
  g.setIndex([...ia, ...Array.from(ib, v => v + off)]);
  return g;
}
