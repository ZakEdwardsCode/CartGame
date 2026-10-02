// ============================================================================
// Coast 2 Coast Karting — Hayle · 3D Time Trial
//
// Rendering: physical sky, image-based lighting, photographic PBR surfaces
// (Poly Haven CC0) and a post-processing chain — ambient occlusion, bloom,
// SMAA, filmic tone mapping. Loaded as ES modules, so this needs to be served
// over http (node server.js), not opened from a file:// path.
// ============================================================================

import * as THREE from "three";
import { EffectComposer }   from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass }       from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass }  from "three/addons/postprocessing/UnrealBloomPass.js";
import { SSAOPass }         from "three/addons/postprocessing/SSAOPass.js";
import { SMAAPass }         from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass }       from "three/addons/postprocessing/OutputPass.js";
import { Sky }              from "three/addons/objects/Sky.js";

window.__kartBooted = true;

const TRACK = window.TRACK;
const TRACK_COVERED_AT = window.TRACK_COVERED_AT;

// ---------------------------------------------------------------------
// Track helpers  (TRACK = [x, y, heading, hwL, hwR, elevation] per metre)
// ---------------------------------------------------------------------
const N  = TRACK.length;
const TX = i => TRACK[((i % N) + N) % N];
const wx = i => TX(i)[0];
const wz = i => -TX(i)[1];              // x east, z = -north
const wy = i => TX(i)[5] || 0;

function surfaceY(i) { let s = 0; for (let d = -2; d <= 2; d++) s += wy(i + d); return s / 5; }
function gradeAt(i)  { return (wy(i + 4) - wy(i - 4)) / 8; }
function halfWidthAt(i, side) { const t = TX(i); return side < 0 ? t[3] : t[4]; }

let elevMean = 0;
for (let i = 0; i < N; i++) elevMean += wy(i);
elevMean /= N;

function nearestIndex(x, z, hint) {
  let best = 0, bestD = Infinity;
  if (hint != null) {
    for (let d = -60; d <= 60; d++) {
      const i = ((hint + d) % N + N) % N;
      const dx = wx(i) - x, dz = wz(i) - z, dd = dx*dx + dz*dz;
      if (dd < bestD) { bestD = dd; best = i; }
    }
    if (bestD < 900) return { index: best, dist: Math.sqrt(bestD) };
  }
  bestD = Infinity;
  for (let i = 0; i < N; i++) {
    const dx = wx(i) - x, dz = wz(i) - z, dd = dx*dx + dz*dz;
    if (dd < bestD) { bestD = dd; best = i; }
  }
  return { index: best, dist: Math.sqrt(bestD) };
}
function lateral(x, z, i) {
  const h = TX(i)[2];
  const fx = Math.cos(h), fz = -Math.sin(h);
  return (x - wx(i)) * (-fz) + (z - wz(i)) * fx;
}
const dhf = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2*Math.PI; while (d < -Math.PI) d += 2*Math.PI; return d; };

function formatTime(ms) {
  if (ms == null || !isFinite(ms)) return "--:--.---";
  const neg = ms < 0; ms = Math.abs(ms);
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), f = Math.floor(ms % 1000);
  return (neg ? "-" : "") + m + ":" + String(s).padStart(2,"0") + "." + String(f).padStart(3,"0");
}

// ---------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------
const canvas = document.getElementById("gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(1.8, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.15, 2000);
const ANISO = renderer.capabilities.getMaxAnisotropy();

// ---------------------------------------------------------------------
// Sky + sun + image-based lighting
// ---------------------------------------------------------------------
const sky = new Sky();
sky.scale.setScalar(8000);
scene.add(sky);
{
  const u = sky.material.uniforms;
  u.turbidity.value = 4.0;
  u.rayleigh.value = 1.6;
  u.mieCoefficient.value = 0.006;
  u.mieDirectionalG.value = 0.80;
}
const sunPos = new THREE.Vector3();
{
  const elev = 42 * Math.PI/180, azim = 155 * Math.PI/180;
  sunPos.setFromSphericalCoords(1, Math.PI/2 - elev, azim);
  sky.material.uniforms.sunPosition.value.copy(sunPos);
}

const sun = new THREE.DirectionalLight(0xfff4e2, 2.6);
sun.position.copy(sunPos).multiplyScalar(220);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
{
  const c = sun.shadow.camera;
  c.left = -90; c.right = 90; c.top = 90; c.bottom = -90; c.near = 1; c.far = 520;
}
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xbcd6f0, 0x4a5a3a, 0.28));

// environment probe rendered from the sky itself
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromScene(sky);
  scene.environment = rt.texture;
  pmrem.dispose();
}
scene.fog = new THREE.FogExp2(0xbcc9d6, 0.0016);

// ---------------------------------------------------------------------
// Texture loading (Poly Haven CC0, 1K)
// ---------------------------------------------------------------------
const PH = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k";
const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin("anonymous");

let loadedCount = 0, loadTotal = 0;
const fill = document.getElementById("loadfill");
const note = document.getElementById("loadnote");
function bumpProgress() {
  loadedCount++;
  if (fill) fill.style.width = Math.round(100*loadedCount/Math.max(1,loadTotal)) + "%";
}

function loadTex(url, srgb) {
  loadTotal++;
  return new Promise(resolve => {
    texLoader.load(url,
      t => {
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = ANISO;
        bumpProgress(); resolve(t);
      },
      undefined,
      () => { bumpProgress(); resolve(null); }     // carry on without it
    );
  });
}
async function loadPBR(name, repX, repY) {
  const base = `${PH}/${name}/${name}`;
  const [map, normalMap, roughnessMap] = await Promise.all([
    loadTex(`${base}_diff_1k.jpg`, true),
    loadTex(`${base}_nor_gl_1k.jpg`, false),
    loadTex(`${base}_rough_1k.jpg`, false),
  ]);
  for (const t of [map, normalMap, roughnessMap]) if (t) t.repeat.set(repX, repY);
  return { map, normalMap, roughnessMap };
}

// ---------------------------------------------------------------------
// Build the world once textures are in
// ---------------------------------------------------------------------
const kart = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, steer: 0, onTrack: true, idx: 0 };
let kartMesh, ghostMesh, curvature;

function computeCurvature() {
  const raw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = -6; k <= 6; k++) s += Math.abs(dhf(TX(i+k)[2], TX(i+k+1)[2]));
    raw[i] = s;
  }
  let mx = 0; for (let i = 0; i < N; i++) mx = Math.max(mx, raw[i]);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0; for (let k = -10; k <= 10; k++) s += raw[((i+k)%N+N)%N];
    out[i] = mx > 0 ? (s/21)/mx : 0;
  }
  return out;
}

function buildRoad(pbr) {
  const SHOULDER = 0.75, DROP = 0.10, CROWN = 0.05, LANES = 5;
  const pos = [], uv = [], idx = [], col = [];
  let run = 0;
  for (let i = 0; i < N; i++) {
    const h = TX(i)[2];
    const fx = Math.cos(h), fz = -Math.sin(h);
    const rx = -fz, rz = fx;
    const l = halfWidthAt(i,-1), r = halfWidthAt(i,+1), y = wy(i);
    if (i > 0) run += Math.hypot(wx(i)-wx(i-1), wz(i)-wz(i-1));
    const patch  = 0.95 + 0.05*Math.sin(i*0.031) + 0.025*Math.sin(i*0.11);
    const rubber = 1 - 0.26*Math.min(1, curvature[i]*1.6);
    const lanes = [
      [-(l+SHOULDER), y-DROP,  -0.10, 0.88],
      [-l,            y,        0.00, 0.97],
      [(r-l)*0.5,     y+CROWN,  0.50, 1.00],
      [ r,            y,        1.00, 0.97],
      [ r+SHOULDER,   y-DROP,   1.10, 0.88],
    ];
    for (const [off, yy, u, shade] of lanes) {
      pos.push(wx(i)+rx*off, yy, wz(i)+rz*off);
      uv.push(u, run/3.0);
      const mid = 1 - Math.abs(u-0.5)*2;
      const v = patch * shade * (1 - (1-rubber)*Math.max(0, mid));
      col.push(v, v, v);
    }
  }
  for (let i = 0; i < N; i++) {
    const a = i*LANES, b = ((i+1)%N)*LANES;
    for (let k = 0; k < LANES-1; k++) idx.push(a+k, a+k+1, b+k, a+k+1, b+k+1, b+k);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("color",    new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x9a9a96, roughness: 1.0, metalness: 0.0, vertexColors: true, ...pbr
  });
  if (mat.normalScale) mat.normalScale.set(1.1, 1.1);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function buildEdgeLines() {
  const W = 0.10, mat = new THREE.MeshStandardMaterial({
    color: 0xe8e8e2, roughness: 0.75, metalness: 0.0
  });
  for (const side of [-1, +1]) {
    const pos = [], idx = [];
    for (let i = 0; i < N; i++) {
      const h = TX(i)[2];
      const fx = Math.cos(h), fz = -Math.sin(h);
      const rx = -fz, rz = fx;
      const hw = halfWidthAt(i, side) - 0.22;
      const y = wy(i) + 0.012;
      for (const o of [hw - W, hw + W]) pos.push(wx(i)+rx*o*side, y, wz(i)+rz*o*side);
    }
    for (let i = 0; i < N; i++) {
      const a = i*2, b = ((i+1)%N)*2;
      idx.push(a, a+1, b, a+1, b+1, b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, mat));
  }
}

function cornerRuns(threshold) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < N; i++) {
    const on = curvature[i] >= threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { if (i-start >= 8) runs.push([start, i]); start = -1; }
  }
  if (start >= 0) runs.push([start, N]);
  return runs.map(([a,b]) => {
    let turn = 0;
    for (let i = a; i < b; i++) turn += dhf(TX(i)[2], TX(i+1)[2]);
    return { a, b, turn };
  });
}

function kerbTexture() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 256;
  const g = c.getContext("2d");
  for (let i = 0; i < 4; i++) { g.fillStyle = (i%2) ? "#dedace" : "#b23a30"; g.fillRect(0, i*64, 64, 64); }
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = Math.random()<0.5 ? "rgba(50,46,40,0.22)" : "rgba(255,255,255,0.09)";
    g.fillRect(Math.random()*64, Math.random()*256, 1+Math.random()*2, 1+Math.random()*2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = ANISO;
  return t;
}

function buildKerbs() {
  const runs = cornerRuns(0.30);
  const KW = 0.52;
  const mat = new THREE.MeshStandardMaterial({ map: kerbTexture(), roughness: 0.6, metalness: 0.0 });
  for (const { a, b } of runs) {
    for (const side of [-1, +1]) {
      const pos = [], uv = [], idx = [];
      let vRun = 0;
      for (let k = 0; k <= b-a; k++) {
        const i = a+k, h = TX(i)[2];
        const fx = Math.cos(h), fz = -Math.sin(h);
        const rx = -fz, rz = fx;
        const hw = halfWidthAt(i, side), y = wy(i);
        if (k > 0) vRun += Math.hypot(wx(i)-wx(i-1), wz(i)-wz(i-1));
        const lanes = [[hw, y+0.006, 0], [hw+KW*0.55, y+0.058, 0.5], [hw+KW, y+0.030, 1]];
        for (const [off, yy, u] of lanes) {
          pos.push(wx(i)+rx*off*side, yy, wz(i)+rz*off*side);
          uv.push(u, vRun/2.0);
        }
      }
      const rows = b-a+1;
      for (let k = 0; k < rows-1; k++) {
        const p = k*3, q = (k+1)*3;
        for (let l = 0; l < 2; l++) idx.push(p+l, p+l+1, q+l, p+l+1, q+l+1, q+l);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
    }
  }
}

function buildTyreWalls() {
  const runs = cornerRuns(0.34);
  const onTarmac = (x, z) => {
    for (let a = 0; a < N; a += 2) {
      const dx = wx(a)-x, dz = wz(a)-z;
      if (dx*dx + dz*dz < 30) {
        const off = lateral(x, z, a);
        if (Math.abs(off) < halfWidthAt(a, off < 0 ? -1 : 1) + 1.0) return true;
      }
    }
    return false;
  };
  const lower = [], upper = [];
  for (const { a, b, turn } of runs) {
    const side = turn > 0 ? +1 : -1;
    for (let i = a; i <= b; i += 2) {
      const h = TX(i)[2];
      const fx = Math.cos(h), fz = -Math.sin(h);
      const rx = -fz, rz = fx;
      const off = halfWidthAt(i, side) + 1.35;
      const x = wx(i)+rx*off*side, z = wz(i)+rz*off*side;
      if (onTarmac(x, z)) continue;
      const m1 = new THREE.Matrix4(); m1.setPosition(x, wy(i)+0.17, z); lower.push(m1);
      if (((i/2)|0) % 2 === 0) { const m2 = new THREE.Matrix4(); m2.setPosition(x, wy(i)+0.46, z); upper.push(m2); }
    }
  }
  const geo = new THREE.TorusGeometry(0.26, 0.115, 10, 20);
  geo.rotateX(Math.PI/2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1e1e23, roughness: 0.96, metalness: 0.0 });
  for (const list of [lower, upper]) {
    if (!list.length) continue;
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m,k) => inst.setMatrixAt(k, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = true; inst.receiveShadow = true;
    scene.add(inst);
  }
}

function buildTerrain(pbr) {
  function height(x, z) {
    let bestD = Infinity, bestI = 0;
    for (let i = 0; i < N; i += 3) {
      const dx = wx(i)-x, dz = wz(i)-z, d = dx*dx+dz*dz;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    const t = Math.min(1, Math.sqrt(bestD)/70);
    const e = t*t*(3-2*t);
    return wy(bestI)*(1-e) + elevMean*e;
  }
  const SIZE = 460, SEG = 150;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  let cx = 0, cz = 0;
  for (let i = 0; i < N; i++) { cx += wx(i); cz += wz(i); }
  cx /= N; cz /= N;
  const p = geo.attributes.position;
  for (let v = 0; v < p.count; v++) {
    p.setZ(v, height(p.getX(v)+cx, -p.getY(v)+cz) - 0.07);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x8d9c78, roughness: 1.0, metalness: 0.0, ...pbr });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI/2;
  m.position.set(cx, 0, cz);
  m.receiveShadow = true;
  scene.add(m);
}

function buildStartFinish() {
  const h = TX(0)[2];
  const w = halfWidthAt(0,-1) + halfWidthAt(0,+1);
  const c = document.createElement("canvas");
  c.width = 512; c.height = 64;
  const g = c.getContext("2d");
  for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
    g.fillStyle = ((i+j)%2) ? "#f2f2ef" : "#17171a";
    g.fillRect(i*32, j*32, 32, 32);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = ANISO;

  const grp = new THREE.Group();
  const line = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.7),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
  line.rotation.x = -Math.PI/2;
  line.position.y = 0.016;
  line.receiveShadow = true;
  grp.add(line);

  const steel = new THREE.MeshStandardMaterial({ color: 0xd2d4d6, roughness: 0.4, metalness: 0.55 });
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 4.4, 12), steel);
    post.position.set(s*(w/2+0.7), 2.2, 0);
    post.castShadow = true;
    grp.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(w+1.9, 0.62, 0.34),
    new THREE.MeshStandardMaterial({ color: 0xe8a81c, roughness: 0.45 }));
  beam.position.set(0, 4.15, 0);
  beam.castShadow = true;
  grp.add(beam);

  grp.position.set(wx(0), wy(0), wz(0));
  grp.rotation.y = h + Math.PI/2;
  scene.add(grp);
}

function buildBridge(pbr) {
  if (typeof TRACK_COVERED_AT !== "number") return;
  const i = TRACK_COVERED_AT, h = TX(i)[2];
  const w = halfWidthAt(i,-1) + halfWidthAt(i,+1);
  const SPAN = w + 3.6, DEPTH = 5.2, CLEAR = 3.2;
  const grp = new THREE.Group();
  const conc = new THREE.MeshStandardMaterial({ color: 0xa5a29a, roughness: 0.95, metalness: 0.0, ...pbr });
  for (const s of [-1, 1]) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(1.15, CLEAR, DEPTH), conc);
    pier.position.set(s*(w/2+0.58), CLEAR/2, 0);
    pier.castShadow = true; pier.receiveShadow = true;
    grp.add(pier);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(SPAN, 0.8, DEPTH), conc);
  deck.position.set(0, CLEAR+0.4, 0);
  deck.castShadow = true; deck.receiveShadow = true;
  grp.add(deck);
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(SPAN, 0.6, 0.24),
      new THREE.MeshStandardMaterial({ color: 0x6d6a64, roughness: 0.85 }));
    p.position.set(0, CLEAR+1.1, s*(DEPTH/2-0.12));
    p.castShadow = true;
    grp.add(p);
  }
  grp.position.set(wx(i), wy(i), wz(i));
  grp.rotation.y = h + Math.PI/2;
  scene.add(grp);
}

// ---- kart ----------------------------------------------------------------
function buildKart(bodyColor, ghost) {
  const g = new THREE.Group();
  const M = (c, r = 0.45, m = 0.05) => ghost
    ? new THREE.MeshStandardMaterial({ color: c, transparent: true, opacity: 0.4, roughness: 0.5 })
    : new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const add = (mesh, cast = true) => { mesh.castShadow = cast && !ghost; g.add(mesh); return mesh; };

  const BODY = M(bodyColor, 0.32, 0.10);
  const DARK = M(0x17171c, 0.7, 0.1);
  const CHROME = M(0xb2b7bd, 0.22, 0.9);

  const floor = add(new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.05, 1.80), DARK));
  floor.position.y = 0.105;
  for (const sx of [-1, 1]) {
    const tube = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 1.55, 6, 10), CHROME));
    tube.rotation.x = Math.PI/2; tube.position.set(sx*0.44, 0.135, 0.02);
  }
  for (const sx of [-1, 1]) {
    const pod = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.135, 0.62, 6, 12), BODY));
    pod.rotation.x = Math.PI/2; pod.position.set(sx*0.60, 0.23, -0.04);
  }
  const nose = add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.33, 0.54, 18), BODY));
  nose.rotation.x = Math.PI/2; nose.position.set(0, 0.20, 1.02);
  const noseCap = add(new THREE.Mesh(new THREE.SphereGeometry(0.152, 14, 10), BODY));
  noseCap.position.set(0, 0.20, 1.29);
  const bar = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.034, 0.80, 6, 10), CHROME));
  bar.rotation.z = Math.PI/2; bar.position.set(0, 0.16, 1.24);

  const seat = add(new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.26, 0.46, 20, 1, true,
    Math.PI*0.22, Math.PI*1.56), M(0x131318, 0.75, 0.05)));
  seat.material.side = THREE.DoubleSide;
  seat.position.set(0, 0.36, -0.36);
  const seatBase = add(new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.05, 18), M(0x131318, 0.75)), false);
  seatBase.position.set(0, 0.16, -0.36);

  const eng = add(new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.30, 0.38), M(0x4d525a, 0.45, 0.7)));
  eng.position.set(0.50, 0.32, -0.60);
  const airbox = add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.18, 14), M(0x26292f, 0.6, 0.3)));
  airbox.rotation.z = Math.PI/2; airbox.position.set(0.74, 0.38, -0.60);
  const pipe = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.52, 6, 10), CHROME));
  pipe.rotation.x = Math.PI/2.4; pipe.position.set(0.44, 0.44, -0.92);
  const rear = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.86, 6, 10), CHROME));
  rear.rotation.z = Math.PI/2; rear.position.set(0, 0.22, -1.02);

  const wheels = [];
  function wheel(x, z, R, W) {
    const grp = new THREE.Group();
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(R, R, W, 24), M(0x121216, 0.95, 0));
    tyre.rotation.z = Math.PI/2; tyre.castShadow = !ghost; grp.add(tyre);
    for (const s of [-1, 1]) {
      const sh = new THREE.Mesh(new THREE.TorusGeometry(R*0.88, R*0.14, 8, 20), M(0x16161b, 0.95, 0));
      sh.rotation.y = Math.PI/2; sh.position.x = s*W*0.5; grp.add(sh);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(R*0.42, R*0.42, W*0.30, 14), M(0xcfd3d8, 0.3, 0.85));
      hub.rotation.z = Math.PI/2; hub.position.x = s*W*0.42; grp.add(hub);
    }
    grp.position.set(x, R, z);
    g.add(grp);
    return grp;
  }
  wheels.push(wheel(-0.60, 0.70, 0.22, 0.17));
  wheels.push(wheel( 0.60, 0.70, 0.22, 0.17));
  wheels.push(wheel(-0.64,-0.62, 0.26, 0.30));
  wheels.push(wheel( 0.64,-0.62, 0.26, 0.30));
  g.userData.frontWheels = [wheels[0], wheels[1]];

  const col = add(new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.52, 10), CHROME), false);
  col.position.set(0, 0.46, 0.30); col.rotation.x = -0.72;
  const sw = new THREE.Group();
  sw.add(new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.026, 10, 26), M(0x0d0d11, 0.6, 0.1)));
  for (let k = 0; k < 3; k++) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.018, 0.03), M(0x9aa0a6, 0.35, 0.75));
    sp.rotation.z = k*(Math.PI*2/3);
    sp.position.set(Math.cos(k*Math.PI*2/3)*0.07, Math.sin(k*Math.PI*2/3)*0.07, 0);
    sw.add(sp);
  }
  sw.position.set(0, 0.645, 0.45); sw.rotation.x = 0.80;
  g.add(sw);
  g.userData.steeringWheel = sw;

  const suit = M(ghost ? 0x20c4ff : 0x24303f, 0.75, 0.0);
  const torso = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.20, 0.26, 6, 14), suit));
  torso.position.set(0, 0.52, -0.30); torso.rotation.x = 0.22;
  for (const s of [-1, 1]) {
    const arm = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.34, 6, 10), suit), false);
    arm.position.set(s*0.19, 0.57, -0.02); arm.rotation.set(1.15, 0, -s*0.30);
    const glove = add(new THREE.Mesh(new THREE.SphereGeometry(0.062, 10, 8), M(ghost?0x20c4ff:0x17171c, 0.8)), false);
    glove.position.set(s*0.13, 0.65, 0.40);
    const leg = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.44, 6, 10), suit), false);
    leg.position.set(s*0.14, 0.27, 0.34); leg.rotation.set(1.42, 0, 0);
  }
  const helmet = add(new THREE.Mesh(new THREE.SphereGeometry(0.175, 22, 18), M(ghost?0x20c4ff:0xeceff1, 0.25, 0.05)));
  helmet.position.set(0, 0.86, -0.22);
  const visor = add(new THREE.Mesh(new THREE.SphereGeometry(0.177, 22, 18,
    Math.PI*0.15, Math.PI*0.70, Math.PI*0.40, Math.PI*0.30), M(0x0a0a12, 0.12, 0.6)), false);
  visor.position.copy(helmet.position); visor.rotation.y = Math.PI;
  return g;
}

// ---------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------
let composer, ssaoPass;
function buildComposer() {
  const w = window.innerWidth, h = window.innerHeight;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  ssaoPass = new SSAOPass(scene, camera, w, h);
  ssaoPass.kernelRadius = 0.55;
  ssaoPass.minDistance  = 0.0008;
  ssaoPass.maxDistance  = 0.10;
  composer.addPass(ssaoPass);

  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.28, 0.6, 0.92);
  composer.addPass(bloom);

  composer.addPass(new OutputPass());
  composer.addPass(new SMAAPass(w * renderer.getPixelRatio(), h * renderer.getPixelRatio()));
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------
const keys = Object.create(null);
window.addEventListener("keydown", e => {
  keys[e.code] = true;
  if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"].includes(e.code)) e.preventDefault();
  if (e.code === "KeyC") cycleCamera();
  if (e.code === "KeyR") { resetToGrid(); resetLap(false); toast("Reset to grid"); }
  if (e.code === "KeyL") document.getElementById("times-panel").classList.toggle("hidden");
});
window.addEventListener("keyup", e => { keys[e.code] = false; });

const touch = { steer: 0, accel: 0, brake: 0 };
function bindTouch(id, on, off) {
  const el = document.getElementById(id);
  if (!el) return;
  const d = e => { e.preventDefault(); el.classList.add("active"); on(); };
  const u = e => { e.preventDefault(); el.classList.remove("active"); off(); };
  el.addEventListener("touchstart", d, {passive:false});
  el.addEventListener("touchend", u, {passive:false});
  el.addEventListener("touchcancel", u, {passive:false});
  el.addEventListener("mousedown", d); el.addEventListener("mouseup", u); el.addEventListener("mouseleave", u);
}
if ("ontouchstart" in window) document.querySelector(".touch").classList.add("on");
bindTouch("t-left",  () => touch.steer =  1, () => { if (touch.steer>0) touch.steer = 0; });
bindTouch("t-right", () => touch.steer = -1, () => { if (touch.steer<0) touch.steer = 0; });
bindTouch("t-gas",   () => touch.accel =  1, () => touch.accel = 0);
bindTouch("t-brake", () => touch.brake =  1, () => touch.brake = 0);

// steer: +1 = LEFT
function readInput() {
  let s = 0, t = 0;
  if (keys.ArrowLeft  || keys.KeyA) s += 1;
  if (keys.ArrowRight || keys.KeyD) s -= 1;
  if (keys.ArrowUp    || keys.KeyW) t += 1;
  if (keys.ArrowDown  || keys.KeyS) t -= 1;
  s += touch.steer; t += touch.accel - touch.brake;
  return { steer: Math.max(-1,Math.min(1,s)), throttle: Math.max(-1,Math.min(1,t)) };
}

// ---------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------
const MAX_SPEED = 21.0, MAX_GRASS = 7.0, MAX_REVERSE = -5.0;
const ACCEL = 10.0, BRAKE = 19.0, ROLL = 2.0, GRASS_DRAG = 9.0, REV_ACCEL = 4.5;
const STEER_RATE = 2.5, SCRUB = 5.0;

function resetToGrid() {
  kart.x = wx(0); kart.z = wz(0); kart.y = surfaceY(0);
  kart.yaw = TX(0)[2]; kart.speed = 0; kart.steer = 0; kart.idx = 0;
}

// ---------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------
const CAMS = ["Chase", "Cockpit", "Nose", "Heli"];
let camMode = 0;
function cycleCamera() {
  camMode = (camMode+1) % CAMS.length;
  document.getElementById("cam-name").textContent = CAMS[camMode];
  if (kartMesh) kartMesh.visible = CAMS[camMode] !== "Cockpit";
}
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();

function updateCamera(dt) {
  const fx = Math.cos(kart.yaw), fz = -Math.sin(kart.yaw);
  const sp = Math.abs(kart.speed);
  const mode = CAMS[camMode];
  const gy = kart.y, ahead = surfaceY(kart.idx + 12);
  const target = new THREE.Vector3(), look = new THREE.Vector3();
  if (mode === "Cockpit")      { target.set(kart.x-fx*0.30, gy+0.86, kart.z-fz*0.30); look.set(kart.x+fx*12, ahead+0.72, kart.z+fz*12); }
  else if (mode === "Chase")   { target.set(kart.x-fx*6.2,  gy+2.70, kart.z-fz*6.2);  look.set(kart.x+fx*7,  ahead+0.70, kart.z+fz*7); }
  else if (mode === "Nose")    { target.set(kart.x+fx*1.25, gy+0.42, kart.z+fz*1.25); look.set(kart.x+fx*14, ahead+0.50, kart.z+fz*14); }
  else                         { target.set(kart.x-fx*15,   gy+17,   kart.z-fz*15);   look.set(kart.x, gy, kart.z); }

  const rough = (kart.onTrack ? 0.0016 : 0.011) * sp;
  target.y += Math.sin(performance.now()*0.05) * rough;
  target.x += Math.sin(performance.now()*0.037) * rough * 0.6;

  camPos.lerp(target, mode === "Chase" ? 1-Math.pow(0.0015, dt) : 1-Math.pow(1e-7, dt));
  camLook.lerp(look, 1-Math.pow(1e-6, dt));
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  camera.fov = 70 + Math.min(16, sp*0.7);
  camera.updateProjectionMatrix();
  sun.target.position.set(kart.x, kart.y, kart.z);
  sun.position.copy(sunPos).multiplyScalar(220).add(new THREE.Vector3(kart.x, 0, kart.z));
}

// ---------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------
let audio = null;
function initAudio() {
  if (audio) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const osc = ctx.createOscillator(), osc2 = ctx.createOscillator();
  const gain = ctx.createGain(), filt = ctx.createBiquadFilter();
  osc.type = "sawtooth"; osc2.type = "square";
  osc.frequency.value = 70; osc2.frequency.value = 35;
  filt.type = "lowpass"; filt.frequency.value = 900;
  gain.gain.value = 0;
  osc.connect(filt); osc2.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
  osc.start(); osc2.start();
  audio = { ctx, osc, osc2, gain, filt };
}
function updateAudio(throttle) {
  if (!audio) return;
  const sp = Math.abs(kart.speed)/MAX_SPEED;
  const f = 62 + sp*260;
  audio.osc.frequency.setTargetAtTime(f, audio.ctx.currentTime, 0.05);
  audio.osc2.frequency.setTargetAtTime(f*0.5, audio.ctx.currentTime, 0.05);
  audio.filt.frequency.setTargetAtTime(500 + sp*2600, audio.ctx.currentTime, 0.08);
  const vol = (0.018 + sp*0.05) * (throttle > 0 ? 1.25 : 0.75) * (kart.onTrack ? 1 : 1.3);
  audio.gain.gain.setTargetAtTime(started ? vol : 0, audio.ctx.currentTime, 0.1);
}

// ---------------------------------------------------------------------
// Lap timing
// ---------------------------------------------------------------------
const STORE_KEY = "c2c_hayle_3d_v2";
function loadStore() {
  try {
    const r = localStorage.getItem(STORE_KEY);
    if (!r) return { best:null, ghost:null, top:[] };
    const p = JSON.parse(r);
    return { best: p.best ?? null, ghost: p.ghost ?? null, top: Array.isArray(p.top) ? p.top : [] };
  } catch { return { best:null, ghost:null, top:[] }; }
}
function saveStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch {} }
const store = loadStore();

const NUM_CP = 8;
const CPS = []; for (let i = 0; i < NUM_CP; i++) CPS.push(Math.floor(i*N/NUM_CP));

let started = false;
const lap = { t0:0, cur:0, last:null, count:0, cp:0, rec:new Array(N).fill(null), lastIdx:0, valid:true };

function resetLap(valid) {
  lap.t0 = performance.now(); lap.cur = 0; lap.cp = 0;
  lap.rec = new Array(N).fill(null);
  lap.valid = valid !== false;
}
function completeLap() {
  const ms = performance.now() - lap.t0;
  lap.last = ms; lap.count++;
  let pb = false;
  if (lap.valid) {
    if (store.best == null || ms < store.best) { store.best = ms; store.ghost = lap.rec.slice(); pb = true; }
    store.top.push({ ms, date: new Date().toISOString().slice(0,10) });
    store.top.sort((a,b)=>a.ms-b.ms);
    store.top = store.top.slice(0,5);
    saveStore(); renderTimes();
  }
  toast(lap.valid ? (pb ? "NEW BEST LAP  " + formatTime(ms) : "Lap " + lap.count + "  " + formatTime(ms))
                  : "Lap not counted — missed part of the track",
        pb ? "good" : (lap.valid ? "" : "bad"));
}

const toastEl = document.getElementById("toast");
let toastT = null;
function toast(msg, cls) {
  toastEl.textContent = msg;
  toastEl.className = "toast show " + (cls||"");
  clearTimeout(toastT);
  toastT = setTimeout(()=>toastEl.classList.remove("show"), 2300);
}
function renderTimes() {
  const ol = document.getElementById("times-list");
  ol.innerHTML = "";
  if (!store.top.length) { const li = document.createElement("li"); li.textContent = "No laps yet"; ol.appendChild(li); return; }
  store.top.forEach((t,i) => {
    const li = document.createElement("li");
    if (i === 0) li.className = "top";
    li.textContent = formatTime(t.ms) + "  ·  " + t.date;
    ol.appendChild(li);
  });
}

function step(dt) {
  const { steer, throttle } = readInput();
  const nr = nearestIndex(kart.x, kart.z, kart.idx);
  kart.idx = nr.index;
  const off = lateral(kart.x, kart.z, kart.idx);
  const hw = off < 0 ? halfWidthAt(kart.idx,-1) : halfWidthAt(kart.idx,+1);
  kart.onTrack = Math.abs(off) <= hw + 0.35;
  const maxSp = kart.onTrack ? MAX_SPEED : MAX_GRASS;

  if (throttle > 0.02) kart.speed += ACCEL*throttle*dt;
  else if (throttle < -0.02) {
    if (kart.speed > 0.3) kart.speed += BRAKE*throttle*dt;
    else kart.speed += REV_ACCEL*throttle*dt;
  } else {
    const d = ROLL*dt;
    kart.speed = kart.speed > 0 ? Math.max(0,kart.speed-d) : Math.min(0,kart.speed+d);
  }
  if (!kart.onTrack && kart.speed > 0) kart.speed = Math.max(0, kart.speed - GRASS_DRAG*dt);
  kart.speed = Math.max(MAX_REVERSE, Math.min(maxSp, kart.speed));
  if (Math.abs(steer) > 0.25 && kart.speed > 8)
    kart.speed = Math.max(0, kart.speed - SCRUB*(Math.abs(steer)-0.25)*(kart.speed/MAX_SPEED)*dt);

  const sp = Math.abs(kart.speed);
  let auth = Math.min(1, sp/3.0);
  if (sp > 17) auth *= 1 - 0.15*Math.min(1, (sp-17)/8);
  kart.yaw += steer*STEER_RATE*auth*dt*(kart.speed < 0 ? -1 : 1);
  kart.steer += (steer - kart.steer) * Math.min(1, dt*8);

  kart.x += Math.cos(kart.yaw)*kart.speed*dt;
  kart.z += -Math.sin(kart.yaw)*kart.speed*dt;
  kart.y = surfaceY(kart.idx);

  if (kartMesh) {
    kartMesh.position.set(kart.x, kart.y, kart.z);
    kartMesh.rotation.order = "YXZ";
    kartMesh.rotation.y = kart.yaw + Math.PI/2;
    kartMesh.rotation.x = -Math.atan(gradeAt(kart.idx));
    if (kartMesh.userData.steeringWheel) kartMesh.userData.steeringWheel.rotation.z = kart.steer*0.9;
    for (const w of kartMesh.userData.frontWheels) w.rotation.y = kart.steer*0.5;
  }

  if (started) {
    lap.cur = performance.now() - lap.t0;
    const s = kart.idx;
    if (lap.rec[s] == null) lap.rec[s] = lap.cur;
    const tgt = CPS[lap.cp];
    const d = Math.min(Math.abs(s-tgt), N-Math.abs(s-tgt));
    if (d < 12) lap.cp = (lap.cp+1) % NUM_CP;
    if (lap.lastIdx > N-25 && s < 25) { lap.valid = (lap.cp === 0); completeLap(); resetLap(true); }
    lap.lastIdx = s;
  }
  updateAudio(throttle);
}

function updateGhost() {
  if (!ghostMesh) return;
  if (!started || !store.ghost) { ghostMesh.visible = false; return; }
  const t = lap.cur;
  let gi = -1;
  for (let i = 0; i < N; i++) { const g = store.ghost[i]; if (g != null && g <= t) gi = i; }
  if (gi < 0) { ghostMesh.visible = false; return; }
  ghostMesh.visible = true;
  ghostMesh.position.set(wx(gi), surfaceY(gi), wz(gi));
  ghostMesh.rotation.y = TX(gi)[2] + Math.PI/2;
}

// ---- minimap ----
const mm = document.getElementById("minimap");
const mmx = mm.getContext("2d");
const MM = 150, DPR = window.devicePixelRatio || 1;
mm.width = mm.height = MM*DPR;
mm.style.width = mm.style.height = MM + "px";
let mmT;
{
  let x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity;
  for (let i = 0; i < N; i++) { const x=wx(i),z=wz(i);
    if(x<x0)x0=x; if(x>x1)x1=x; if(z<z0)z0=z; if(z>z1)z1=z; }
  const pad = 8*DPR;
  const s = Math.min((mm.width-pad*2)/(x1-x0), (mm.height-pad*2)/(z1-z0));
  mmT = { s, ox:(mm.width-(x1-x0)*s)/2 - x0*s, oz:(mm.height-(z1-z0)*s)/2 - z0*s };
}
function drawMinimap() {
  mmx.clearRect(0,0,mm.width,mm.height);
  mmx.fillStyle = "rgba(12,18,14,0.55)";
  mmx.fillRect(0,0,mm.width,mm.height);
  mmx.strokeStyle = "rgba(255,255,255,0.62)";
  mmx.lineWidth = 3*DPR;
  mmx.beginPath();
  for (let i = 0; i < N; i += 2) {
    const X = wx(i)*mmT.s+mmT.ox, Z = wz(i)*mmT.s+mmT.oz;
    i === 0 ? mmx.moveTo(X,Z) : mmx.lineTo(X,Z);
  }
  mmx.closePath(); mmx.stroke();
  mmx.fillStyle = "#ffb020";
  mmx.beginPath(); mmx.arc(wx(0)*mmT.s+mmT.ox, wz(0)*mmT.s+mmT.oz, 3.2*DPR, 0, 7); mmx.fill();
  if (ghostMesh && ghostMesh.visible) {
    mmx.fillStyle = "rgba(32,196,255,0.9)";
    mmx.beginPath(); mmx.arc(ghostMesh.position.x*mmT.s+mmT.ox, ghostMesh.position.z*mmT.s+mmT.oz, 3*DPR, 0, 7); mmx.fill();
  }
  mmx.fillStyle = "#ff4d5e";
  mmx.beginPath(); mmx.arc(kart.x*mmT.s+mmT.ox, kart.z*mmT.s+mmT.oz, 4*DPR, 0, 7); mmx.fill();
}

// ---- HUD ----
const el = {
  time: document.getElementById("h-time"), delta: document.getElementById("h-delta"),
  best: document.getElementById("h-best"), last: document.getElementById("h-last"),
  laps: document.getElementById("h-laps"), mph: document.getElementById("h-mph"),
  surf: document.getElementById("h-surf"),
};
function updateHud() {
  el.time.textContent = started ? formatTime(lap.cur) : "0:00.000";
  el.best.textContent = store.best != null ? formatTime(store.best) : "--:--.---";
  el.last.textContent = lap.last != null ? formatTime(lap.last) : "--:--.---";
  el.laps.textContent = String(lap.count);
  el.mph.textContent = (Math.abs(kart.speed)*2.23694).toFixed(0);
  el.surf.textContent = kart.onTrack ? "TRACK" : "OFF";
  el.surf.className = "surf " + (kart.onTrack ? "ok" : "bad");
  if (started && store.ghost) {
    let g = store.ghost[kart.idx];
    if (g == null) for (let d = 1; d < 10 && g == null; d++)
      g = store.ghost[(kart.idx+d)%N] ?? store.ghost[(kart.idx-d+N)%N];
    if (g != null) {
      const dl = lap.cur - g;
      el.delta.textContent = (dl>=0?"+":"") + (dl/1000).toFixed(2);
      el.delta.className = "delta " + (dl <= 0 ? "good" : "bad");
    }
  } else {
    el.delta.textContent = store.ghost ? "" : "set a lap for delta";
    el.delta.className = "delta";
  }
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
let counting = false;
async function boot() {
  curvature = computeCurvature();

  if (note) note.textContent = "fetching track surfaces…";
  const [asphalt, grass, concrete] = await Promise.all([
    loadPBR("asphalt_04", 2, 1),
    loadPBR("aerial_grass_rock", 140, 140),
    loadPBR("concrete_wall_008", 2, 1),
  ]);

  if (note) note.textContent = "building the circuit…";
  buildTerrain(grass);
  buildRoad(asphalt);
  buildEdgeLines();
  buildKerbs();
  buildTyreWalls();
  buildStartFinish();
  buildBridge(concrete);

  kartMesh = buildKart(0xd8202a, false);
  scene.add(kartMesh);
  ghostMesh = buildKart(0x20c4ff, true);
  ghostMesh.visible = false;
  scene.add(ghostMesh);

  resetToGrid();
  camPos.set(kart.x, kart.y+3, kart.z);
  camLook.set(kart.x, kart.y+1, kart.z);
  buildComposer();
  renderTimes();

  const go = document.getElementById("go");
  go.disabled = false;
  go.textContent = "Get In The Kart";
  if (note) note.textContent = "ready";
  if (fill) fill.style.width = "100%";

  go.addEventListener("click", () => {
    document.getElementById("overlay").style.display = "none";
    initAudio();
    if (audio && audio.ctx.state === "suspended") audio.ctx.resume();
    resetToGrid();
    counting = true;
    let n = 3;
    const cd = document.getElementById("countdown");
    cd.textContent = n; cd.classList.add("show");
    const iv = setInterval(() => {
      n--;
      if (n > 0) cd.textContent = n;
      else if (n === 0) cd.textContent = "GO!";
      else { clearInterval(iv); cd.classList.remove("show"); counting = false; started = true; resetLap(true); }
    }, 800);
  });

  let prev = performance.now();
  function frame(now) {
    let dt = (now - prev)/1000; prev = now;
    dt = Math.min(dt, 1/20);
    if (!counting) step(dt);
    updateGhost();
    updateCamera(dt);
    drawMinimap();
    updateHud();
    composer.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch(err => {
  console.error(err);
  const f = document.getElementById("fatal");
  if (f) { f.hidden = false; document.getElementById("fatal-msg").textContent = String(err && err.message || err); }
});
