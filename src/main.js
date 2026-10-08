// ============================================================================
// Coast 2 Coast Karting — game shell: renderer, sessions (race / time trial /
// online / attract demo), cameras, HUD, menus and the main loop.
// ============================================================================

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import {
  N, wrap, cx, cz, heading, FX, FZ, RX, RZ, ELEV, gradeAt, project, gridSlot, respawnPose,
  BAR_L, BAR_R, SHARED_L, SHARED_R, LINE_X, LINE_Z, BOUNDS,
} from "./track.js";
import { Kart, World, SURFACES } from "./physics.js";
import { AIDriver, DIFFICULTY } from "./ai.js";
import {
  pollInput, readDriving, action, endFrame, rumble, bindTouchControls, setInputSettings, gamepadName,
  tilt, enableTilt, disableTilt, calibrateTilt, tiltNeedsTap,
} from "./input.js";
import { PartyNet } from "./party.js";
import { NetClient, defaultServerUrl } from "./net.js";
import { GameAudio } from "./audio.js";
import { buildKart, poseKart } from "./kart-model.js";
import { TrackWorld, QUALITY } from "./world.js";
import { SkidMarks, Particles } from "./effects.js";
import { LapTracker, byRaceOrder, GapClock } from "./race.js";

window.__kartBooted = true;

const $ = id => document.getElementById(id);
const IS_TOUCH = "ontouchstart" in window || navigator.maxTouchPoints > 0;
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
const SETTINGS_KEY = "c2c_settings_v3";
const settings = Object.assign({
  quality: IS_MOBILE ? "low" : "medium", camera: "0", units: "mph", steer: "1", volume: "0.75",
  rumble: "on", fps: "off", laps: "5", opponents: "5", difficulty: "medium", grid: "back",
  color: "#d8202a", onlineLaps: "3", name: "", touchSteer: "strip", tiltInvert: "off", tiltRange: "32", brakeAssist: "on",
}, IS_MOBILE ? { opponents: "3", laps: "3" } : {}, (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })());
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };
const Q = QUALITY[settings.quality] || QUALITY.medium;

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------
const canvas = $("gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !Q.smaa, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(Q.pixelRatio, window.devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = settings.quality === "low" ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 3000);
let composer = null;

function buildComposer() {
  if (!Q.bloom && !Q.ssao && !Q.smaa) { composer = null; return; }
  const w = innerWidth, h = innerHeight, pr = renderer.getPixelRatio();
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (Q.ssao) {
    const ssao = new SSAOPass(scene, camera, w, h);
    ssao.kernelRadius = 0.5; ssao.minDistance = 0.0008; ssao.maxDistance = 0.08;
    composer.addPass(ssao);
  }
  if (Q.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.22, 0.55, 0.93));
  composer.addPass(new OutputPass());
  if (Q.smaa) composer.addPass(new SMAAPass(w * pr, h * pr));
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (composer) composer.setSize(innerWidth, innerHeight);
  if (particles) particles.setViewport(innerHeight * renderer.getPixelRatio());
});

// ---------------------------------------------------------------------------
// shared systems
// ---------------------------------------------------------------------------
const audio = new GameAudio();
audio.setVolume(Number(settings.volume));
setInputSettings({ steerSensitivity: Number(settings.steer), rumble: settings.rumble === "on" });
let track, skids, particles;
let session = null;
let net = null;
let paused = false;

const AI_NAMES = ["Jago", "Tamsin", "Morwenna", "Piran", "Demelza", "Bryok", "Lowen", "Senara", "Kerensa", "Cador", "Ennor", "Treve"];
const AI_COLORS = ["#1f6fb2", "#e6a417", "#2a9d5b", "#7a3fb8", "#f06d1a", "#e83e8c", "#16a3b8", "#eceff1", "#8a8f2a", "#c0392b"];
const fmt = s => {
  if (s == null || !isFinite(s)) return "--:--.---";
  const neg = s < 0; s = Math.abs(s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return (neg ? "-" : "") + m + ":" + r.toFixed(3).padStart(6, "0");
};

// ---------------------------------------------------------------------------
// time trial records (this device)
// ---------------------------------------------------------------------------
const TT_KEY = "c2c_trial_v3";
const trial = (() => {
  try { const p = JSON.parse(localStorage.getItem(TT_KEY)); if (p && Array.isArray(p.top)) return p; } catch {}
  return { best: null, ghost: null, idxTimes: null, top: [] };
})();
const saveTrial = () => { try { localStorage.setItem(TT_KEY, JSON.stringify(trial)); } catch {} };

// ---------------------------------------------------------------------------
// name tags
// ---------------------------------------------------------------------------
function nameTag(name, color) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(8,10,9,0.72)";
  g.beginPath(); g.roundRect ? g.roundRect(8, 10, 240, 44, 10) : g.rect(8, 10, 240, 44); g.fill();
  g.fillStyle = color; g.fillRect(16, 18, 8, 28);
  g.fillStyle = "#fff"; g.font = "800 28px system-ui, Arial, sans-serif"; g.textBaseline = "middle";
  g.fillText(name.slice(0, 14), 34, 33);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, transparent: true }));
  s.scale.set(1.6, 0.4, 1);
  s.renderOrder = 3;
  return s;
}

// ---------------------------------------------------------------------------
// Session: one race / trial / online event / attract demo
// ---------------------------------------------------------------------------
const LIGHT_STEP = 0.7;

class Session {
  constructor(opts) {
    this.mode = opts.mode;                     // race | trial | online | demo
    this.laps = opts.laps ?? Infinity;
    this.world = new World();
    this.entries = [];
    this.t = 0;
    this.state = "grid";                        // grid | racing | finished | results | lobby
    this.gap = new GapClock();
    this.player = null;
    this.raceT0 = 0;                           // session time at the green light
    this.lightsAt = 0; this.goAt = 0;
    this.litShown = -1;
    this.wrongWay = 0;
    this.playerFinishedAt = null;
    this.ghostRec = [];
    this.idxRec = null;
    this.camTarget = null;
  }

  add({ id, name, color, number, isPlayer = false, ai = null, remote = false }) {
    const kart = this.world.add(new Kart(id));
    kart.remote = remote;
    const mesh = buildKart({ color, number, helmet: isPlayer ? "#ffffff" : color === "#eceff1" ? "#1f6fb2" : "#eceff1" });
    scene.add(mesh);
    const e = { id, name, color, kart, mesh, isPlayer, ai, remote, tracker: remote ? remoteTracker() : new LapTracker(this.laps), tag: null };
    if (!isPlayer) { e.tag = nameTag(name, color); scene.add(e.tag); }
    if (isPlayer) this.player = e;
    this.entries.push(e);
    return e;
  }

  remove(e) {
    scene.remove(e.mesh);
    if (e.tag) scene.remove(e.tag);
    this.world.remove(e.kart);
    this.entries = this.entries.filter(x => x !== e);
  }

  dispose() {
    for (const e of [...this.entries]) this.remove(e);
    if (this.ghost) scene.remove(this.ghost);
    skids.clear();
  }

  // place everyone on the grid and run the start lights
  startGrid(order, goAtSession) {
    order.forEach((e, k) => {
      const s = gridSlot(k);
      e.kart.reset(s);
      e.kart.frozen = true;
      e.tracker.reset?.();
      e.tracker.teleport?.(s.i);
      e.finished = false;
    });
    this.state = "grid";
    this.goAt = goAtSession;
    this.lightsAt = goAtSession - (5 * LIGHT_STEP + (this.mode === "online" ? 1.4 : 0.4 + Math.random() * 1.0));
    this.litShown = -1;
    this.gap.reset();
    this.playerFinishedAt = null;
    skids.clear();
  }

  raceTime() { return this.t - this.raceT0; }

  update(dt) {
    this.t += dt;
    const pl = this.player;

    // --- start lights
    if (this.state === "grid") {
      const lit = this.t < this.lightsAt ? 0 : Math.min(5, Math.floor((this.t - this.lightsAt) / LIGHT_STEP) + 1);
      if (this.t >= this.goAt) {
        this.state = "racing";
        this.raceT0 = this.goAt;
        for (const e of this.entries) if (!e.remote) e.kart.frozen = false;
        calibrateTilt();
        track.setStartLights(0);
        if (this.mode !== "demo") { showLights(-1); banner("GO!", "gold", 900); audio.beep(true); }
      } else if (lit !== this.litShown) {
        this.litShown = lit;
        track.setStartLights(lit);
        if (this.mode !== "demo") { showLights(lit); if (lit > 0) audio.beep(false); }
      }
    }

    // --- control
    const drive = readDriving(dt);
    if (pl && !pl.remote) {
      const inp = pl.kart.input;
      if (pl.autopilot) pl.ai.update(dt, this.world.karts);
      else if (this.state === "racing" || this.state === "finished" || this.state === "practice") {
        inp.steer = drive.steer; inp.throttle = drive.throttle; inp.brake = drive.brake;
      } else { inp.steer = drive.steer; inp.throttle = 0; inp.brake = 0; }
    }
    for (const e of this.entries) {
      if (e.ai && !e.isPlayer && !e.remote && !e.kart.frozen) {
        if (e.ai.update(dt, this.world.karts)) this.respawn(e);
      }
    }
    if (pl && !pl.autopilot && action("respawn") && !pl.kart.frozen) { this.respawn(pl); toast("Back on track"); }

    // --- remote karts from the network
    if (this.mode === "online" && net) this.syncRemotes(dt);

    // --- physics
    this.world.step(dt);

    // --- laps & positions
    const rt = this.raceTime();
    for (const e of this.entries) {
      if (e.remote) continue;
      const k = e.kart;
      if (this.state !== "racing" && this.state !== "finished" && this.state !== "practice") continue;
      const ev = e.tracker.update(rt, k.idx, k.s - k.idx);
      for (const x of ev) this.onLapEvent(e, x, rt);
    }
    const order = this.order();
    if (order.length && (this.state === "racing" || this.state === "finished")) this.gap.record(order[0].tracker.dist, rt);

    // --- player-specific
    if (pl && !pl.remote) {
      const k = pl.kart;
      // wrong way
      const vdot = (Math.cos(k.yaw) * k.vx) * FX[k.idx] + (-Math.sin(k.yaw) * k.vx) * FZ[k.idx];
      this.wrongWay = (this.state === "racing" && vdot < -2) ? this.wrongWay + dt : 0;
      // feedback
      if (k.hit > 2.5 && !this._hitCooldown) {
        rumble(Math.min(1, k.hit / 10), 0.6, 220); audio.impact(k.hit); cam.shake = Math.min(0.5, k.hit * 0.04);
        particles.emit("spark", k.x, k.y, k.z, 0, 0, 6);
        this._hitCooldown = 0.3;
      }
      this._hitCooldown = Math.max(0, (this._hitCooldown || 0) - dt);
      if (k.bump > 0.3) rumble(0.0, 0.25 * k.bump, 60);
      if (k.lockF || k.lockR) rumble(0.35, 0.5, 80);
      if (this.mode === "trial") this.recordGhost(rt);
      if (this.mode === "online" && net && !pl.spectator) this.sendState(dt);
    }

    // --- finish handling (offline)
    if ((this.mode === "race") && this.state === "finished") {
      const all = this.entries.every(e => e.tracker.finished);
      if (all || this.t - this.playerFinishedAt > 30) this.showResults();
    }

    this.updateVisuals(dt);
  }

  respawn(e) {
    const p = respawnPose(e.kart.idx);
    e.kart.reset(p);
    e.tracker.teleport?.(e.kart.idx);
    if (e.ai) e.ai.offset = 0;
  }

  order() {
    return [...this.entries].filter(e => !e.spectator).sort(byRaceOrder);
  }

  onLapEvent(e, x, rt) {
    if (x.type === "lap" && e.isPlayer) {
      const t = x.time;
      if (this.mode === "trial") this.trialLap(t, x.valid);
      else if (!x.valid) toast(`Lap ${x.n}: ${fmt(t)} · not clean`, "bad");
      else toast(`Lap ${x.n}: ${fmt(t)}`, x.best ? "purple" : "");
      if (this.mode === "online" && net && this.state !== "practice") net.send({ t: "lap", ms: Math.round(t * 1000) });
      const left = this.laps - x.n;
      if (left === 1 && this.mode !== "trial") banner("FINAL LAP", "gold", 1400);
    }
    if (x.type === "finish") {
      e.finished = true;
      if (e.isPlayer && this.mode !== "online") this.playerFinish();
    }
  }

  playerFinish() {
    const pl = this.player;
    this.state = "finished";
    this.playerFinishedAt = this.t;
    const pos = this.order().indexOf(pl) + 1;
    banner(pos === 1 ? "WINNER!" : ordinal(pos), pos === 1 ? "gold" : "", 2600, "FINISHED");
    // cool-down lap on autopilot
    pl.ai = new AIDriver(pl.kart, 0.7, 0, 99);
    pl.autopilot = true;
  }

  // ---- time trial ghost & records
  recordGhost(rt) {
    const pl = this.player, k = pl.kart, tr = pl.tracker;
    if (tr.crossings < 1) return;
    const lt = rt - tr.lapStart;
    const last = this.ghostRec[this.ghostRec.length - 1];
    if (!last || lt - last[0] >= 0.05) this.ghostRec.push([+lt.toFixed(3), +k.x.toFixed(2), +k.z.toFixed(2), +k.yaw.toFixed(3)]);
    if (!this.idxRec) this.idxRec = new Array(N).fill(null);
    if (this.idxRec[k.idx] == null) this.idxRec[k.idx] = +lt.toFixed(3);
  }

  trialLap(t, valid) {
    const rec = this.ghostRec, idx = this.idxRec;
    this.ghostRec = []; this.idxRec = null;
    if (!valid) { toast(`${fmt(t)} · lap not counted`, "bad"); return; }
    const pb = trial.best == null || t < trial.best;
    trial.top.push({ t, date: new Date().toISOString().slice(0, 10) });
    trial.top.sort((a, b) => a.t - b.t);
    trial.top = trial.top.slice(0, 10);
    if (pb) { trial.best = t; trial.ghost = rec; trial.idxTimes = idx; banner("NEW BEST", "gold", 1800, fmt(t)); }
    else toast(`${fmt(t)}  (+${(t - trial.best).toFixed(3)})`);
    saveTrial();
  }

  // ---- online
  syncRemotes(dt) {
    for (const r of net.remotes.values()) {
      let e = this.entries.find(x => x.remote && x.id === r.id);
      if (!e) { e = this.add({ id: r.id, name: r.name, color: r.color, number: r.no ?? r.id, remote: true }); e.kart.frozen = true; }
      const d = net.sample(r);
      const last = r.buf[r.buf.length - 1];
      e.hasState = !!d && net.serverNow() - last.t < 2000;      // stopped sending = parked in the lobby
      if (!d) continue;
      const k = e.kart;
      k.x = d[0]; k.z = d[1]; k.y = d[2]; k.yaw = d[3]; k.vx = d[4]; k.vy = d[5]; k.delta = d[6]; k.r = d[10] || 0;
      const p = project(k.x, k.z, k.idx);
      k.idx = p.i; k.s = p.s; k.lat = p.lat;
      k.wheelRot += k.vx / 0.25 * dt;
      k.roll += ((-(k.vx * k.r) / 9.81) * 0.045 - k.roll) * Math.min(1, dt * 10);
      const flags = d[9] | 0;
      e.racingRemote = (flags & 1) !== 0;
      k.ghost = !(e.racingRemote && this.player && !this.player.spectator && (this.state === "racing" || this.state === "finished"));
      const tr = e.tracker;
      if (!tr.finished) tr.dist = d[7];
      tr.lapsDone = d[8] | 0;
    }
    for (const e of [...this.entries]) if (e.remote && !net.remotes.has(e.id)) this.remove(e);
  }

  sendState(dt) {
    const k = this.player.kart, tr = this.player.tracker;
    const racing = (this.state === "racing" || this.state === "finished") && !this.player.spectator;
    const r2 = v => Math.round(v * 100) / 100;
    net.sendState(dt, [r2(k.x), r2(k.z), r2(k.y), Math.round(k.yaw * 1000) / 1000, r2(k.vx), r2(k.vy), r2(k.delta),
      r2(tr.dist), tr.lapsDone, (racing ? 1 : 0) | (tr.finished ? 2 : 0), r2(k.r)]);
  }

  // ---- results
  showResults() {
    if (this.state === "results") return;
    this.state = "results";
    const order = this.order();
    const leader = order[0];
    const rows = order.map((e, i) => ({
      pos: i + 1, name: e.name, color: e.color, me: e.isPlayer,
      time: e.tracker.finished ? fmt(e.tracker.finishTime) : (leader.tracker.finished ? lapsBehind(e, leader) : "—"),
      best: e.tracker.bestLap,
    }));
    showResultsTable(rows, this.player ? `${ordinal(order.indexOf(this.player) + 1)} place` : "Results");
  }

  // ---- visuals per frame
  updateVisuals(dt) {
    for (const e of this.entries) {
      const k = e.kart, m = e.mesh;
      const visible = !(e.remote && (!e.hasState));
      m.visible = visible && !(e.isPlayer && e.spectator);
      if (!m.visible) { if (e.tag) e.tag.visible = false; continue; }
      m.position.set(k.x, k.y, k.z);
      m.rotation.order = "YXZ";
      m.rotation.y = k.yaw + Math.PI / 2;
      const g = gradeAt(k.idx) * Math.cos(k.yaw - heading(k.idx));
      m.rotation.x = -Math.atan(g);
      poseKart(m, k, dt);
      const ghosted = e.remote && k.ghost;
      for (const mat of m.userData.materials) { const o = ghosted ? 0.45 : 1; if (mat.opacity !== o) { mat.transparent = o < 1; mat.opacity = o; mat.depthWrite = o >= 1; } }
      if (e.tag) {
        e.tag.visible = this.mode !== "demo";
        e.tag.position.set(k.x, k.y + 1.55, k.z);
      }
      // tyre effects near the camera
      const dx = k.x - camera.position.x, dz = k.z - camera.position.z;
      if (dx * dx + dz * dz > 90 * 90) continue;
      const c = Math.cos(k.yaw), s = Math.sin(k.yaw);
      const fx = c, fz = -s, lx = -s, lz = -c;
      const sp = Math.hypot(k.vx, k.vy);
      const onTarmac = k.surfR !== SURFACES.grass;
      for (const side of [-1, 1]) {
        const wx = k.x - fx * 0.58 + lx * 0.6 * side, wz = k.z - fz * 0.58 + lz * 0.6 * side;
        skids.add(`${e.id}:${side}`, wx, k.y, wz, lx, lz, onTarmac ? k.skid : 0);
        if (onTarmac && k.skid > 0.35 && Math.random() < k.skid * dt * 22) {
          const [wvx, wvz] = k.worldVel();
          particles.emit("smoke", wx, k.y, wz, wvx, wvz, 1);
        }
        if (!onTarmac && sp > 3 && Math.random() < sp * dt * 2.2) {
          const [wvx, wvz] = k.worldVel();
          particles.emit("grass", wx, k.y, wz, wvx, wvz, 1);
          if (Math.random() < 0.3) particles.emit("dust", wx, k.y, wz, wvx, wvz, 1);
        }
      }
    }
    // time trial ghost
    if (this.mode === "trial") this.updateGhost();
  }

  updateGhost() {
    const g = trial.ghost, tr = this.player.tracker;
    if (!g || !g.length || tr.crossings < 1) { if (this.ghost) this.ghost.visible = false; return; }
    if (!this.ghost) { this.ghost = buildKart({ color: "#20c4ff", helmet: "#20c4ff", suit: "#20c4ff", ghost: true, number: 0 }); scene.add(this.ghost); }
    const t = this.raceTime() - tr.lapStart;
    if (t > g[g.length - 1][0]) { this.ghost.visible = false; return; }
    let lo = 0, hi = g.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (g[mid][0] <= t) lo = mid; else hi = mid; }
    const a = g[lo], b = g[hi], f = Math.max(0, Math.min(1, (t - a[0]) / Math.max(1e-3, b[0] - a[0])));
    let dy = b[3] - a[3]; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
    const x = a[1] + (b[1] - a[1]) * f, z = a[2] + (b[2] - a[2]) * f, yaw = a[3] + dy * f;
    const p = project(x, z, this._gIdx ?? -1);
    this._gIdx = p.i;
    this.ghost.visible = true;
    this.ghost.position.set(x, p.y, z);
    this.ghost.rotation.y = yaw + Math.PI / 2;
  }

  trialDelta() {
    const it = trial.idxTimes, tr = this.player.tracker;
    if (!it || tr.crossings < 1) return null;
    const k = this.player.kart;
    let g = it[k.idx];
    for (let d = 1; g == null && d < 10; d++) g = it[wrap(k.idx + d)] ?? it[wrap(k.idx - d)];
    if (g == null) return null;
    return (this.raceTime() - tr.lapStart) - g;
  }
}

function remoteTracker() {
  return { finished: false, finishTime: null, dist: -N, lapsDone: 0, bestLap: null, lastLap: null, crossings: 0,
    reset() { this.finished = false; this.finishTime = null; this.dist = -N; this.lapsDone = 0; this.bestLap = null; } };
}
function lapsBehind(e, leader) {
  const d = leader.tracker.dist - e.tracker.dist;
  const laps = Math.floor(d / N);
  return laps >= 1 ? `+${laps} lap${laps > 1 ? "s" : ""}` : "running";
}
function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

// ---------------------------------------------------------------------------
// session factories
// ---------------------------------------------------------------------------
function startDemo() {
  endSession();
  const s = session = new Session({ mode: "demo", laps: Infinity });
  const n = 6;
  const entries = [];
  for (let k = 0; k < n; k++) {
    const e = s.add({ id: k + 1, name: AI_NAMES[k], color: AI_COLORS[k], number: k + 2 });
    e.ai = new AIDriver(e.kart, 0.86 + Math.random() * 0.1, 0.006, k + 11);
    entries.push(e);
  }
  s.startGrid(entries, 0.5);
  cam.setMode("tv");
  cam.follow = entries[0];
  hud(false);
}

function startRace() {
  endSession();
  const laps = Number(settings.laps), n = Number(settings.opponents);
  const diff = DIFFICULTY[settings.difficulty] || DIFFICULTY.medium;
  const s = session = new Session({ mode: "race", laps });
  const me = s.add({ id: 0, name: settings.name || "You", color: settings.color, number: 1, isPlayer: true });
  me.kart.brakeAssist = settings.brakeAssist === "on";
  const ais = [];
  const used = AI_COLORS.filter(c => c !== settings.color);
  for (let k = 0; k < n; k++) {
    const e = s.add({ id: k + 1, name: AI_NAMES[k], color: used[k % used.length], number: k + 2 });
    const sk = diff.skill[0] + (diff.skill[1] - diff.skill[0]) * (k / Math.max(1, n - 1));
    e.ai = new AIDriver(e.kart, sk, diff.mistakes, k + 7 + Math.floor(Math.random() * 1000));
    ais.push(e);
  }
  // fastest AI at the front
  ais.sort((a, b) => b.ai.skill - a.ai.skill);
  let order;
  if (settings.grid === "pole") order = [me, ...ais];
  else if (settings.grid === "random") { order = [...ais]; order.splice(Math.floor(Math.random() * (n + 1)), 0, me); }
  else order = [...ais, me];
  s.startGrid(order, 1.2);
  enterDriving();
}

function startTrial() {
  endSession();
  const s = session = new Session({ mode: "trial", laps: Infinity });
  const me = s.add({ id: 0, name: settings.name || "You", color: settings.color, number: 1, isPlayer: true });
  me.kart.brakeAssist = settings.brakeAssist === "on";
  s.startGrid([me], 1.0);
  enterDriving();
}

function startOnlineSession() {
  endSession();
  const s = session = new Session({ mode: "online", laps: Infinity });
  const me = s.add({ id: net.id, name: settings.name || "Driver", color: settings.color, number: net.myNo ?? net.id, isPlayer: true });
  me.spectator = true;
  me.kart.brakeAssist = settings.brakeAssist === "on";
  me.kart.frozen = true; me.kart.ghost = true;
  me.kart.reset(gridSlot(0));
  s.state = "lobby";
  cam.setMode("tv");
}

function endSession() {
  if (session) session.dispose();
  session = null;
  paused = false;
  showLights(-1);
  if (track) track.setStartLights(0);
}

function nextCamera() {
  if (!session || cam.mode === "tv") return;
  const m = (Number(settings.camera) + 1) % 5;
  settings.camera = String(m); saveSettings(); renderOpts("camera"); cam.setMode(m);
}

// phones: go fullscreen and landscape when a race starts (ignored where refused)
function phoneFullscreen() {
  if (!IS_TOUCH) return;
  const el = document.documentElement;
  try {
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" }) : null;
    if (p && p.then) p.then(() => screen.orientation?.lock?.("landscape").catch(() => {})).catch(() => {});
  } catch {}
}

const GAME_URL = "https://zakedwardscode.github.io/CartGame/";
function tiltProblem(r) {
  $("hud").classList.remove("tiltmode");
  const msg = {
    embedded: `Tilt is blocked inside this app. Open ${GAME_URL.replace("https://", "")} in Safari or Chrome to use it.`,
    denied: "The phone said no to motion access. Close the tab, open the game again and tap Allow.",
    unsupported: "This browser has no tilt sensor support. Using the touch strip.",
    silent: "No tilt readings from this phone. Using the touch strip.",
  }[r] || "Tilt isn't available. Using the touch strip.";
  toast("Tilt off: " + msg, "bad wrap", 7000);
}
// turn tilt on; when the phone needs a tap for permission, ask for one on screen
function startTiltIfChosen() {
  const tb = $("tilt-tap");
  if (!IS_TOUCH || settings.touchSteer !== "tilt") { $("hud").classList.remove("tiltmode"); tb.classList.add("hidden"); return; }
  $("hud").classList.add("tiltmode");
  const go = () => enableTilt().then(r => {
    if (r !== "ok") { tiltProblem(r); return; }
    setTimeout(calibrateTilt, 300);          // centre on however the phone is held now
    setTimeout(() => { if (!tilt.working) tiltProblem("silent"); }, 1500);
  });
  if (tiltNeedsTap()) { tb.classList.remove("hidden"); tb.onclick = () => { tb.classList.add("hidden"); go(); }; }
  else { tb.classList.add("hidden"); go(); }
}

function enterDriving() {
  startTiltIfChosen();
  phoneFullscreen();
  closeMenus();
  hud(true);
  cam.setMode(Number(settings.camera));
  cam.reset();
  audio.init();
}

// ---------------------------------------------------------------------------
// online
// ---------------------------------------------------------------------------
async function goOnline(room, party = false) {
  const note = $("online-note");
  const name = ($("in-name").value || "").trim().slice(0, 16);
  settings.name = name; saveSettings();
  const url = defaultServerUrl();
  if (!party && !url) { note.textContent = "No multiplayer server is configured for this copy of the game."; return; }
  note.textContent = party ? (room === "new" ? "Setting up your party…" : "Joining the party…") : "Connecting…";
  if (net) net.close();
  net = party ? new PartyNet() : new NetClient(url);
  bindNet(net);
  try {
    const w = await net.connect({ name: name || "Driver", color: settings.color, room });
    note.textContent = "";
    audio.init();
    startOnlineSession();
    lobbyCode = w.room;
    showScreen("scr-lobby", true);
    renderLobby();
  } catch (err) {
    note.textContent = party ? `${err.message || err}.` : `${err.message || err}. ${location.hostname.endsWith("github.io") ? "GitHub Pages can't host the race server — use Create Party instead." : `Server: ${url}`}`;
    net = null;
  }
}

let lobbyCode = "";
function bindNet(n) {
  n.addEventListener("room", () => { renderLobby(); onRoomPhase(); });
  n.addEventListener("go", e => {
    const m = e.detail;
    if (!session || session.mode !== "online") return;
    const s = session;
    const me = s.player;
    const myIdx = m.grid.indexOf(n.id);
    if (myIdx < 0) return;           // not in this race: keep spectating
    me.spectator = false;
    me.kart.ghost = false;
    me.tracker = new LapTracker(m.laps);
    me.autopilot = false; me.ai = null;
    s.laps = m.laps;
    // map server start time onto the session clock
    const goIn = (m.startAt - n.serverNow()) / 1000;
    const slot = gridSlot(myIdx);
    s.startGrid([], s.t + goIn);
    me.kart.reset(slot); me.kart.frozen = true; me.tracker.teleport(slot.i);
    for (const e of s.entries) if (e.remote) { e.tracker.reset(); }
    enterDriving();
  });
  n.addEventListener("fin", e => {
    const m = e.detail;
    if (!session) return;
    const ent = session.entries.find(x => x.id === m.id);
    if (ent) {
      ent.tracker.finished = true; ent.tracker.finishTime = m.ms / 1000; ent.tracker.bestLap = m.best != null ? m.best / 1000 : ent.tracker.bestLap;
    }
    if (m.id === n.id) {
      session.state = "finished";
      banner(m.pos === 1 ? "WINNER!" : ordinal(m.pos), m.pos === 1 ? "gold" : "", 2600, "FINISHED");
      const pl = session.player;
      pl.ai = new AIDriver(pl.kart, 0.7, 0, 5); pl.autopilot = true;
    } else {
      const who = ent ? ent.name : "Someone";
      toast(`${who} finished ${ordinal(m.pos)}`);
    }
  });
  n.addEventListener("results", e => {
    const list = e.detail.list;
    if (session) session.state = "results";
    showResultsTable(list.map(r => ({
      pos: r.pos, name: r.name, color: r.color, me: r.id === n.id,
      time: r.dnf ? `DNF (${r.laps} laps)` : fmt(r.ms / 1000), best: r.best != null ? r.best / 1000 : null,
    })), "Results", true);
  });
  n.addEventListener("joined", e => toast(`${e.detail.name} joined`));
  n.addEventListener("left", () => renderLobby());
  n.addEventListener("close", () => {
    if (net !== n) return;
    net = null;
    toast("Disconnected from the server", "bad");
    quitToMenu();
  });
}

function onRoomPhase() {
  const r = net && net.room;
  if (!r || !session || session.mode !== "online") return;
  if (r.phase === "lobby" && (session.state === "results" || session.state === "finished")) {
    // back to the lobby for the next race
    const me = session.player;
    me.spectator = true; me.kart.frozen = true; me.kart.ghost = true; me.autopilot = false;
    session.state = "lobby";
    hud(false);
    cam.setMode("tv");
    showScreen("scr-lobby", true);
  }
}

function renderLobby() {
  if (!net || !net.room) return;
  const r = net.room, isHost = r.host === net.id;
  $("lobby-code").textContent = r.private ? r.code : "PUBLIC";
  const me = r.players.find(p => p.id === net.id);
  $("lobby-players").innerHTML = r.players.map(p => `<li><i style="background:${p.color}"></i><span>${esc(p.name)}${p.id === r.host ? " ★" : ""}${p.id === net.id ? " (you)" : ""}</span>` +
    `<em class="${p.ready ? "rdy" : ""}">${r.phase === "racing" ? (p.racing ? `lap ${p.laps}` : "waiting") : p.ready ? "READY" : "not ready"}</em></li>`).join("");
  let status = "";
  if (r.phase === "racing") status = me && me.racing ? "Racing" : "Race in progress — you're in the next one. Spectating…";
  else if (r.phase === "results") status = "Results — next race shortly";
  else if (r.autoAt) status = "Everyone's ready — starting…";
  else status = r.players.length < 2 ? (r.private ? `Share code ${r.code} with friends` : "Waiting for other drivers…") : "Ready up when you're set";
  $("lobby-status").textContent = status;
  for (const el of document.querySelectorAll("#scr-lobby .host-only")) el.classList.toggle("hidden", !isHost);
  const rb = $("btn-ready");
  rb.textContent = me && me.ready ? "Not Ready" : "Ready";
  rb.disabled = r.phase !== "lobby";
  if (isHost && String(r.laps) !== settings.onlineLaps) { settings.onlineLaps = String(r.laps); renderOpts("onlineLaps"); }
  if (!isHost) { settings.onlineLaps = String(r.laps); renderOpts("onlineLaps"); }
  refreshFocus();
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------------
// cameras
// ---------------------------------------------------------------------------
const CAM_NAMES = ["Chase", "Far Chase", "Cockpit", "Bumper", "Heli"];
const TV_SPOTS = (() => {
  const out = [];
  for (let i = 0; i < N; i += 45) {
    const side = BAR_R[i] > BAR_L[i] ? 1 : -1;
    const shared = (side > 0 ? SHARED_R : SHARED_L)[i] >= 0;
    const off = (side > 0 ? BAR_R : BAR_L)[i] + (shared ? 0 : 2.5);
    out.push({ i, x: cx(i) + RX[i] * off * side, z: cz(i) + RZ[i] * off * side, y: ELEV[i] + 3.2 });
  }
  return out;
})();

const cam = {
  mode: 0, pos: new THREE.Vector3(0, 10, 0), look: new THREE.Vector3(), yaw: 0, shake: 0, follow: null,
  spot: null, spotT: 0, switchT: 0,
  setMode(m) {
    this.mode = m;
    if (typeof m === "number") { const el = $("camname"); el.textContent = CAM_NAMES[m].toUpperCase(); el.classList.add("show"); clearTimeout(this._t); this._t = setTimeout(() => el.classList.remove("show"), 1400); }
  },
  reset() { this.snap = true; },
  update(dt, lookBack) {
    const s = session;
    let target = s && (this.mode === "tv" ? this.follow : s.player);
    if (s && this.mode === "tv") {
      // demo / spectating: follow someone interesting
      this.switchT -= dt;
      const racers = s.entries.filter(e => e.mesh.visible);
      if (!target || !racers.includes(target) || this.switchT <= 0) {
        target = this.follow = racers.length ? racers[Math.floor(Math.random() * racers.length)] : null;
        this.switchT = 14;
      }
    }
    if (!target) { // slow orbit of the venue
      const t = performance.now() * 0.00005;
      camera.position.set(BOUNDS.mx + Math.cos(t) * 140, 45, BOUNDS.mz + Math.sin(t) * 110);
      camera.lookAt(BOUNDS.mx, 0, BOUNDS.mz);
      camera.fov = 50; camera.updateProjectionMatrix();
      return;
    }
    const k = target.kart;
    const fx = Math.cos(k.yaw), fz = -Math.sin(k.yaw), lx = -Math.sin(k.yaw), lz = -Math.cos(k.yaw);
    const sp = Math.abs(k.vx);
    if (this.mode === "tv") {
      // pick the nearest trackside camera a little ahead of the kart
      let best = null, bd = Infinity;
      for (const sp2 of TV_SPOTS) {
        let di = sp2.i - k.idx; if (di < -N / 2) di += N; if (di > N / 2) di -= N;
        const d = Math.hypot(sp2.x - k.x, sp2.z - k.z) + (di < -15 ? 40 : 0);
        if (d < bd) { bd = d; best = sp2; }
      }
      if (best !== this.spot) { this.spot = best; this.snap = true; }
      const p = new THREE.Vector3(best.x, best.y, best.z);
      const lk = new THREE.Vector3(k.x + fx * 1.5, k.y + 0.5, k.z + fz * 1.5);
      if (this.snap) { this.look.copy(lk); this.snap = false; }
      this.look.lerp(lk, 1 - Math.pow(0.0005, dt));
      camera.position.copy(p);
      camera.lookAt(this.look);
      const dist = p.distanceTo(lk);
      camera.fov = THREE.MathUtils.clamp(2 * Math.atan(7 / dist) * 180 / Math.PI, 12, 60);
      camera.updateProjectionMatrix();
      if (target.mesh.userData.head) target.mesh.userData.head.visible = true;
      track.follow(k.x, k.y, k.z);
      return;
    }
    // chase-style cameras: a yaw that lags the kart a little
    let dyaw = k.yaw - this.yaw; while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    this.yaw += dyaw * Math.min(1, dt * (this.mode === 1 ? 4 : 6));
    if (this.snap) this.yaw = k.yaw;
    const back = lookBack ? -1 : 1;
    const cfx = Math.cos(this.yaw) * back, cfz = -Math.sin(this.yaw) * back;
    const at = new THREE.Vector3(), lk = new THREE.Vector3();
    const head = target.mesh.userData.head;
    if (head) head.visible = this.mode !== 2;
    let fov = 68, lerp = 1;
    switch (this.mode) {
      case 0: at.set(k.x - cfx * 4.3, k.y + 1.75, k.z - cfz * 4.3); lk.set(k.x + cfx * 3, k.y + 0.55, k.z + cfz * 3); fov = 66 + sp * 0.55; lerp = 1 - Math.pow(0.000002, dt); break;
      case 1: at.set(k.x - cfx * 7.5, k.y + 3.0, k.z - cfz * 7.5); lk.set(k.x + cfx * 4, k.y + 0.4, k.z + cfz * 4); fov = 60 + sp * 0.4; lerp = 1 - Math.pow(0.00002, dt); break;
      case 2: at.set(k.x - fx * 0.24 * back + 0, k.y + 0.98 + k.pitch, k.z - fz * 0.24 * back); lk.set(k.x + fx * 10 * back + lx * k.delta * 3, k.y + 0.7, k.z + fz * 10 * back + lz * k.delta * 3); fov = 72 + sp * 0.4; break;
      case 3: at.set(k.x + fx * 1.32 * back, k.y + 0.42, k.z + fz * 1.32 * back); lk.set(k.x + fx * 12 * back, k.y + 0.35, k.z + fz * 12 * back); fov = 78 + sp * 0.5; break;
      case 4: at.set(k.x - cfx * 12, k.y + 14, k.z - cfz * 12); lk.set(k.x + cfx * 3, k.y, k.z + cfz * 3); fov = 55; lerp = 1 - Math.pow(0.001, dt); break;
    }
    if (this.snap || lookBack) { this.pos.copy(at); this.look.copy(lk); this.snap = false; }
    else { this.pos.lerp(at, lerp); this.look.lerp(lk, 1 - Math.pow(0.000001, dt)); }
    // shake: impacts, kerbs, grass
    this.shake *= Math.pow(0.02, dt);
    const vib = this.shake + (k.bump ? 0.012 * k.bump : 0) + (k.offTrack ? 0.01 * Math.min(1, sp / 8) : 0);
    camera.position.copy(this.pos);
    if (vib > 0.001) camera.position.add(new THREE.Vector3((Math.random() - 0.5) * vib, (Math.random() - 0.5) * vib, (Math.random() - 0.5) * vib));
    camera.lookAt(this.look);
    camera.fov += (Math.min(95, fov) - camera.fov) * Math.min(1, dt * 3);
    camera.updateProjectionMatrix();
    track.follow(k.x, k.y, k.z);
  },
};

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const texts = new Map();
function setText(el, v) { if (texts.get(el) !== v) { texts.set(el, v); el.textContent = v; } }
function hud(on) { $("hud").classList.toggle("hidden", !on); }

let toastTimer = null;
function toast(msg, cls = "", ms = 2400) {
  const el = $("toast");
  el.textContent = msg; el.className = "toast show " + cls;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
let bannerTimer = null;
function banner(msg, cls = "", ms = 1500, small = "") {
  const el = $("banner");
  el.innerHTML = esc(msg) + (small ? `<small>${esc(small)}</small>` : "");
  el.className = "banner show " + cls;
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => el.classList.remove("show"), ms);
}
function showLights(n) {
  const el = $("lights");
  if (n < 0) { el.classList.add("go"); setTimeout(() => el.classList.remove("show", "go"), 700); [...el.children].forEach(i => i.classList.remove("on")); return; }
  el.classList.remove("go");
  el.classList.add("show");
  [...el.children].forEach((i, k) => i.classList.toggle("on", k < n));
}

// minimap: track pre-rendered once
const mm = $("minimap"), mmx = mm.getContext("2d");
const MM = 150, DPR = Math.min(2, devicePixelRatio || 1);
mm.width = mm.height = MM * DPR; mm.style.width = mm.style.height = MM + "px";
const mmBase = document.createElement("canvas"); mmBase.width = mmBase.height = MM * DPR;
let mmT;
{
  const pad = 10 * DPR, w = BOUNDS.x1 - BOUNDS.x0, h = BOUNDS.z1 - BOUNDS.z0;
  const s = Math.min((mm.width - pad * 2) / w, (mm.height - pad * 2) / h);
  mmT = { s, ox: (mm.width - w * s) / 2 - BOUNDS.x0 * s, oz: (mm.height - h * s) / 2 - BOUNDS.z0 * s };
  const g = mmBase.getContext("2d");
  g.lineJoin = "round";
  for (const [w2, col] of [[9, "rgba(0,0,0,0.5)"], [6, "rgba(235,240,235,0.85)"]]) {
    g.strokeStyle = col; g.lineWidth = w2 * DPR; g.beginPath();
    for (let i = 0; i <= N; i += 2) { const X = cx(i) * s + mmT.ox, Z = cz(i) * s + mmT.oz; i ? g.lineTo(X, Z) : g.moveTo(X, Z); }
    g.closePath(); g.stroke();
  }
  g.strokeStyle = "#111"; g.lineWidth = 3 * DPR; g.beginPath();
  const a = [cx(0) + RX[0] * 3.6, cz(0) + RZ[0] * 3.6], b = [cx(0) - RX[0] * 3.6, cz(0) - RZ[0] * 3.6];
  g.moveTo(a[0] * s + mmT.ox, a[1] * s + mmT.oz); g.lineTo(b[0] * s + mmT.ox, b[1] * s + mmT.oz); g.stroke();
}
function drawMinimap(s) {
  mmx.clearRect(0, 0, mm.width, mm.height);
  mmx.drawImage(mmBase, 0, 0);
  const dot = (x, z, col, r) => { mmx.fillStyle = col; mmx.beginPath(); mmx.arc(x * mmT.s + mmT.ox, z * mmT.s + mmT.oz, r * DPR, 0, 7); mmx.fill(); };
  if (s.ghost && s.ghost.visible) dot(s.ghost.position.x, s.ghost.position.z, "rgba(32,196,255,0.9)", 3.2);
  for (const e of s.entries) {
    if (!e.mesh.visible || e.isPlayer) continue;
    mmx.strokeStyle = "rgba(0,0,0,.6)"; mmx.lineWidth = 1.5 * DPR;
    dot(e.kart.x, e.kart.z, e.color, 3.6); mmx.stroke();
  }
  const p = s.player;
  if (p && p.mesh.visible) {
    const k = p.kart, X = k.x * mmT.s + mmT.ox, Z = k.z * mmT.s + mmT.oz;
    mmx.save(); mmx.translate(X, Z); mmx.rotate(-k.yaw);
    mmx.fillStyle = "#ffb020"; mmx.strokeStyle = "#000"; mmx.lineWidth = 1.5 * DPR;
    mmx.beginPath(); mmx.moveTo(7 * DPR, 0); mmx.lineTo(-5 * DPR, 4.5 * DPR); mmx.lineTo(-3 * DPR, 0); mmx.lineTo(-5 * DPR, -4.5 * DPR); mmx.closePath(); mmx.fill(); mmx.stroke();
    mmx.restore();
  }
}

const spd = $("speedo"), spx = spd.getContext("2d");
function drawSpeedo(v01, thr, brk) {
  const w = spd.width, h = spd.height, cxs = w / 2, cys = h - 8, r = 70;
  spx.clearRect(0, 0, w, h);
  spx.lineCap = "round";
  spx.lineWidth = 9; spx.strokeStyle = "rgba(255,255,255,0.12)";
  spx.beginPath(); spx.arc(cxs, cys, r, Math.PI, 2 * Math.PI); spx.stroke();
  const grad = spx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "#35e07a"); grad.addColorStop(0.7, "#ffb020"); grad.addColorStop(1, "#ff4d5e");
  spx.strokeStyle = grad;
  spx.beginPath(); spx.arc(cxs, cys, r, Math.PI, Math.PI + Math.PI * Math.min(1, v01)); spx.stroke();
  // pedals
  spx.fillStyle = "rgba(255,255,255,0.12)"; spx.fillRect(4, 10, 5, 60); spx.fillRect(w - 9, 10, 5, 60);
  spx.fillStyle = "#35e07a"; spx.fillRect(w - 9, 70 - 60 * thr, 5, 60 * thr);
  spx.fillStyle = "#ff4d5e"; spx.fillRect(4, 70 - 60 * brk, 5, 60 * brk);
}

let towerT = 0, fpsT = 0, fpsN = 0;
function updateHud(dt) {
  const s = session;
  if (!s || !s.player || $("hud").classList.contains("hidden")) return;
  const p = s.player, k = p.kart, tr = p.tracker;
  const rt = s.raceTime();
  const racing = s.state === "racing" || s.state === "finished";
  const lapT = tr.currentLapTime ? tr.currentLapTime(rt) : null;
  setText($("h-time"), s.state === "grid" ? "0:00.000" : fmt(lapT ?? (tr.finished ? tr.finishTime : 0)));
  if (s.mode === "trial") setText($("h-lap"), tr.crossings > 0 ? `LAP ${tr.lapsDone + 1}` : "OUT LAP");
  else setText($("h-lap"), tr.finished ? "FINISHED" : `LAP ${Math.max(1, Math.min(s.laps, tr.lapsDone + 1))}/${s.laps}`);

  const dEl = $("h-delta");
  if (s.mode === "trial") {
    const d = s.trialDelta();
    if (d != null) { setText(dEl, (d >= 0 ? "+" : "") + d.toFixed(2)); dEl.className = "delta " + (d <= 0 ? "good" : "bad"); }
    else { setText(dEl, trial.best ? `best ${fmt(trial.best)}` : "set a lap to race your ghost"); dEl.className = "delta"; }
  } else if (racing) {
    const order = s.order(), i = order.indexOf(p);
    if (i > 0 && !tr.finished) {
      const ahead = order[i - 1];
      const g = (ahead.tracker.dist - tr.dist) / Math.max(5, Math.abs(k.vx));
      setText(dEl, `▲ ${ahead.name} ${g.toFixed(1)}s`); dEl.className = "delta";
    } else setText(dEl, "");
  } else setText(dEl, "");

  const posEl = $("h-pos");
  posEl.classList.toggle("hidden", s.mode === "trial");
  if (s.mode !== "trial") {
    const order = s.order();
    setText($("h-posn"), String(order.indexOf(p) + 1));
    setText($("h-posof"), "/" + order.length);
  }
  setText($("h-best"), fmt(s.mode === "trial" ? trial.best : tr.bestLap));
  setText($("h-last"), fmt(tr.lastLap));
  $("h-netrow").classList.toggle("hidden", !net);
  if (net) setText($("h-ping"), Math.round(net.rtt) + " ms");

  const mph = settings.units === "mph";
  const v = Math.abs(k.vx) * (mph ? 2.23694 : 3.6);
  setText($("h-spd"), v.toFixed(0));
  setText($("h-unit"), mph ? "MPH" : "KM/H");
  drawSpeedo(Math.abs(k.vx) / 23, k.input.throttle, k.input.brake);
  const surf = (k.lockF || k.lockR) ? ["WHEELS LOCKED", "bad"] : k.offTrack ? ["OFF TRACK", "bad"] : (k.surfF === SURFACES.kerb || k.surfR === SURFACES.kerb) ? ["KERB", "kerb"] : ["TRACK", "ok"];
  setText($("h-surf"), surf[0]); $("h-surf").className = "surf " + surf[1];

  if (s.wrongWay > 1.0) banner("WRONG WAY", "warn", 400);

  towerT -= dt;
  if (towerT <= 0) {
    towerT = 0.25;
    const tw = $("tower");
    if (s.mode === "trial") tw.innerHTML = trial.top.slice(0, 5).map((r, i) => `<div class="r"><b>${i + 1}</b><i style="background:${i ? "#555" : "#b26bff"}"></i><span>${fmt(r.t)}</span><em>${r.date}</em></div>`).join("");
    else {
      const order = s.order();
      const leader = order[0];
      tw.innerHTML = order.map((e, i) => {
        let gap = "";
        if (e.tracker.finished) gap = "FIN";
        else if (i === 0) gap = racing ? `L${Math.min(s.laps, e.tracker.lapsDone + 1)}` : "";
        else if (racing) {
          const behind = leader.tracker.dist - e.tracker.dist;
          if (behind >= N) gap = `+${Math.floor(behind / N)}L`;
          else { const g = s.gap.gap(e.tracker.dist, rt); gap = g != null ? `+${g.toFixed(1)}` : ""; }
        }
        return `<div class="r${e.isPlayer ? " me" : ""}${e.tracker.finished ? " fin" : ""}"><b>${i + 1}</b><i style="background:${e.color}"></i><span>${esc(e.name)}</span><em>${gap}</em></div>`;
      }).join("");
    }
  }
  drawMinimap(s);

  if (settings.fps === "on") {
    fpsN++; fpsT += dt;
    if (fpsT >= 0.5) { setText($("fps"), `${Math.round(fpsN / fpsT)} fps`); fpsN = 0; fpsT = 0; }
  }
}

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------
let current = null;
const history = [];
let focusIdx = 0;

function showScreen(id, replace = false) {
  if (current && !replace) history.push(current);
  if (replace) history.length = 0;
  for (const s of document.querySelectorAll(".screen")) s.classList.remove("on");
  current = id;
  $(id).classList.add("on");
  $("menus").classList.remove("hidden");
  for (const el of document.querySelectorAll(".offline-only")) el.classList.toggle("hidden", !!net);
  focusIdx = 0;
  refreshFocus();
}
function closeMenus() {
  for (const s of document.querySelectorAll(".screen")) s.classList.remove("on");
  current = null; history.length = 0;
}
function focusables() {
  if (!current) return [];
  return [...$(current).querySelectorAll("button, input")].filter(el => !el.disabled && el.offsetParent !== null);
}
function refreshFocus() {
  const f = focusables();
  for (const el of document.querySelectorAll(".focus")) el.classList.remove("focus");
  if (!f.length) return;
  focusIdx = Math.max(0, Math.min(f.length - 1, focusIdx));
  f[focusIdx].classList.add("focus");
}
function moveFocus(d) {
  const f = focusables();
  if (!f.length) return;
  focusIdx = (focusIdx + d + f.length) % f.length;
  for (const el of document.querySelectorAll(".focus")) el.classList.remove("focus");
  f[focusIdx].classList.add("focus");
  if (f[focusIdx].tagName === "INPUT") f[focusIdx].focus(); else { if (document.activeElement && document.activeElement.tagName === "INPUT") document.activeElement.blur(); }
  f[focusIdx].scrollIntoView({ block: "nearest" });
}
function menuInput() {
  if (!current) return false;
  if (action("up")) moveFocus(-1);
  if (action("down")) moveFocus(1);
  const f = focusables()[focusIdx];
  if (f && f.classList.contains("opt")) { if (action("left")) cycleOpt(f, -1); if (action("right")) cycleOpt(f, 1); }
  if (action("confirm") && f) { if (f.tagName === "INPUT") moveFocus(1); else f.click(); }
  if (action("back")) {
    const b = $(current).querySelector("[data-back]");
    if (b) b.click();
    else if (current === "scr-pause") resume();
  }
  return true;
}
// keyboard navigation out of text fields
document.addEventListener("keydown", e => {
  if (e.target.tagName !== "INPUT") return;
  if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); moveFocus(1); }
  if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(-1); }
  if (e.key === "Escape") e.target.blur();
});
// mouse hover moves focus too
document.addEventListener("mouseover", e => {
  const el = e.target.closest && e.target.closest(".screen button, .screen input");
  if (!el) return;
  const i = focusables().indexOf(el);
  if (i >= 0 && i !== focusIdx) { focusIdx = i; refreshFocus(); }
});

function optInfo(b) {
  const vals = b.dataset.values.split(",");
  const names = b.dataset.names ? b.dataset.names.split(",") : vals.map(v => v[0].toUpperCase() + v.slice(1));
  let i = vals.indexOf(String(settings[b.dataset.key]));
  if (i < 0) i = 0;
  return { vals, names, i };
}
function renderOpt(b) {
  const { vals, names, i } = optInfo(b);
  const val = b.dataset.swatch ? `<i class="swatch" style="background:${vals[i]}"></i>` : esc(names[i]);
  b.innerHTML = `<span>${esc(b.dataset.label)}</span><span class="val">${val}</span>`;
}
function renderOpts(key) { for (const b of document.querySelectorAll(`.opt[data-key="${key}"]`)) renderOpt(b); }
function cycleOpt(b, d) {
  const { vals, i } = optInfo(b);
  const key = b.dataset.key;
  settings[key] = vals[(i + d + vals.length) % vals.length];
  saveSettings();
  renderOpts(key);
  applySetting(key);
}
function applySetting(key) {
  if (key === "volume") audio.setVolume(Number(settings.volume));
  if (key === "steer" || key === "rumble") setInputSettings({ steerSensitivity: Number(settings.steer), rumble: settings.rumble === "on" });
  if (key === "fps") $("fps").classList.toggle("hidden", settings.fps !== "on");
  if (key === "camera" && session && session.player && cam.mode !== "tv") cam.setMode(Number(settings.camera));
  if (key === "onlineLaps" && net && net.room && net.room.host === net.id) net.send({ t: "laps", n: Number(settings.onlineLaps) });
  if (key === "quality") toast("Reload the page to apply graphics changes");
  if (key === "brakeAssist" && session && session.player) session.player.kart.brakeAssist = settings.brakeAssist === "on";
  if (key === "tiltInvert" || key === "tiltRange") { tilt.invert = settings.tiltInvert === "on"; tilt.range = Number(settings.tiltRange); }
  if (key === "touchSteer") {
    if (settings.touchSteer === "tilt") enableTilt().then(r => { if (r !== "ok") tiltProblem(r); });
    else disableTilt();
    $("hud").classList.toggle("tiltmode", settings.touchSteer === "tilt");
  }
}

function showResultsTable(rows, title, online = false) {
  hud(false);
  $("res-title").textContent = title;
  $("res-table").innerHTML = `<tr><th>Pos</th><th>Driver</th><th>Time</th><th>Best lap</th></tr>` +
    rows.map(r => `<tr class="${r.me ? "me" : ""}"><td class="p">${r.pos}</td><td><i style="background:${r.color}"></i>${esc(r.name)}</td><td>${r.time}</td><td>${fmt(r.best)}</td></tr>`).join("");
  showScreen("scr-results", true);
  if (online) for (const el of document.querySelectorAll(".offline-only")) el.classList.add("hidden");
}

function pause() {
  if (!session || session.mode === "demo") return;
  paused = !net;          // online keeps running underneath the menu
  showScreen("scr-pause", true);
}
function resume() {
  paused = false;
  calibrateTilt();
  closeMenus();
  if (session && session.state === "lobby") showScreen("scr-lobby", true);
}
function quitToMenu() {
  if (net) { const n = net; net = null; n.close(); }
  startDemo();
  showScreen("scr-title", true);
}

const ACTS = {
  race: () => startRace(),
  trial: () => startTrial(),
  quick: () => goOnline(""),
  "party-create": () => goOnline("new", true),
  "party-join": () => {
    const code = ($("in-code").value || "").trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { $("online-note").textContent = "Party codes are 4 letters."; return; }
    goOnline(code, true);
  },
  create: () => goOnline("new"),
  join: () => {
    const code = ($("in-code").value || "").trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { $("online-note").textContent = "Room codes are 4 letters."; return; }
    goOnline(code);
  },
  ready: () => { if (net && net.room) { const me = net.room.players.find(p => p.id === net.id); net.send({ t: "ready", v: !(me && me.ready) }); } },
  start: () => net && net.send({ t: "start" }),
  leave: () => quitToMenu(),
  resume: () => resume(),
  restart: () => { if (!session) return; const m = session.mode; m === "trial" ? startTrial() : startRace(); },
  quit: () => quitToMenu(),
};
document.addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b || !b.closest(".screen")) return;
  b.blur();                 // so Enter doesn't fire the native click as well
  audio.init();
  if (b.classList.contains("opt")) { cycleOpt(b, 1); return; }
  if (b.dataset.go) { if (b.dataset.go === "scr-online") $("in-name").value = settings.name || ""; showScreen(b.dataset.go); return; }
  if ("back" in b.dataset) { const prev = history.pop(); if (prev) { showScreen(prev, false); history.pop(); } else if (current === "scr-settings" && session && session.mode !== "demo") showScreen("scr-pause", true); else showScreen("scr-title", true); return; }
  const fn = ACTS[b.dataset.act];
  if (fn) fn();
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot() {
  showScreen("scr-loading", true);
  for (const b of document.querySelectorAll(".opt")) renderOpt(b);
  $("fps").classList.toggle("hidden", settings.fps !== "on");
  if (IS_TOUCH) { $("touch").classList.add("on"); $("hud").classList.add("touchmode"); document.body.classList.add("is-touch"); }
  tilt.invert = settings.tiltInvert === "on"; tilt.range = Number(settings.tiltRange);
  // public matchmaking only where a game server answers
  if (window.C2C_CONFIG && window.C2C_CONFIG.server) $("btn-quick").classList.remove("hidden");
  else fetch("health").then(r => {
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) $("btn-quick").classList.remove("hidden");
  }).catch(() => {});
  $("t-cam").addEventListener("touchstart", e => { e.preventDefault(); nextCamera(); }, { passive: false });
  bindTouchControls(document);
  $("t-pause").addEventListener("touchstart", e => { e.preventDefault(); pause(); }, { passive: false });
  addEventListener("pad-change", e => {
    $("padhint").textContent = e.detail.connected ? `🎮 ${e.detail.name.replace(/\(.*?\)/g, "").trim().slice(0, 40)} connected` : "";
  });

  track = new TrackWorld(scene, renderer, settings.quality);
  await track.build(
    p => { $("loadfill").style.width = Math.round(p * 80) + "%"; },
    stage => { $("loadnote").textContent = stage; },
  );
  skids = new SkidMarks(scene);
  particles = new Particles(scene);
  particles.setViewport(innerHeight * renderer.getPixelRatio());
  buildComposer();
  $("loadnote").textContent = "warming up the tyres…";
  $("loadfill").style.width = "95%";
  // compile shaders before the first visible frame
  startDemo();
  cam.update(0.016, false);
  renderer.compile(scene, camera);
  $("loadfill").style.width = "100%";
  showScreen("scr-title", true);
  const pn = gamepadName();
  if (pn) $("padhint").textContent = `🎮 controller connected`;
  else $("padhint").textContent = IS_TOUCH ? "" : "Controller? Plug it in and press any button.";

  let prev = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    pollInput(dt);
    const inMenu = menuInput();
    if (!inMenu && session && session.mode !== "demo") {
      if (action("pause")) pause();
      if (action("camera")) nextCamera();
    }
    if (session && !paused) session.update(dt);
    const drive = readDriving(0);
    cam.update(dt, !current && drive.lookBack);
    particles.update(paused ? 0 : dt);
    updateHud(dt);
    const pl = session && session.player;
    const k = pl && pl.kart;
    audio.update(k && !pl.spectator ? {
      running: session.state !== "lobby" && session.state !== "results", paused,
      speed01: Math.min(1, Math.abs(k.vx) / 22), throttle: k.input.throttle, skid: k.offTrack ? 0 : k.skid,
      kerb: k.bump > 0 && !k.offTrack, offTrack: k.offTrack,
      nearOther: nearestOther(session, pl),
    } : { running: false, speed01: 0, throttle: 0, skid: 0, kerb: false, offTrack: false, nearOther: 0, paused: !!current });
    if (composer) composer.render(); else renderer.render(scene, camera);
    endFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function nearestOther(s, pl) {
  let best = 0;
  for (const e of s.entries) {
    if (e === pl || !e.mesh.visible) continue;
    const d = Math.hypot(e.kart.x - pl.kart.x, e.kart.z - pl.kart.z);
    best = Math.max(best, Math.max(0, 1 - d / 25));
  }
  return best;
}

boot().catch(err => {
  console.error(err);
  $("fatal").hidden = false;
  $("fatal-msg").textContent = String((err && err.message) || err);
});

// for debugging in the console
window.c2c = { get session() { return session; }, get net() { return net; }, settings, LINE_X, LINE_Z };
