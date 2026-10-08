// ============================================================================
// Input: keyboard, gamepad (Xbox / PlayStation / generic "standard" mapping)
// and touch, merged into one driving state plus edge-triggered actions.
//
// Gamepad driving:
//   Left stick ........ steer            RT / R2 ...... accelerate
//   LT / L2 ........... brake/reverse    A / Cross .... accelerate (digital)
//   X / Square ........ brake (digital)  Y / Triangle . change camera
//   LB / L1 ........... look behind      Back/Select .. respawn on track
//   Start / Options ... pause
// Menus: D-pad or left stick to move, A to choose, B to go back.
// ============================================================================

const DEADZONE = 0.12;

const settings = { steerSensitivity: 1.0, rumble: true };
export function setInputSettings(s) { Object.assign(settings, s); }

const keys = Object.create(null);
const pressedOnce = new Map();     // key code -> presses not yet consumed
let lastDevice = "keyboard";

addEventListener("keydown", e => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
  if (!keys[e.code] || e.repeat) pressedOnce.set(e.code, (pressedOnce.get(e.code) || 0) + 1);
  keys[e.code] = true;
  lastDevice = "keyboard";
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "Tab"].includes(e.code)) e.preventDefault();
});
addEventListener("keyup", e => { keys[e.code] = false; });
addEventListener("blur", () => { for (const k in keys) keys[k] = false; });

// --- touch (on-screen pedals and steering) ----------------------------------
export const touch = { steer: 0, accel: 0, brake: 0, active: false };
export function bindTouchControls(root) {
  const bind = (id, on, off) => {
    const el = root.querySelector(id);
    if (!el) return;
    const d = e => { e.preventDefault(); el.classList.add("active"); touch.active = true; lastDevice = "touch"; on(); };
    const u = e => { e.preventDefault(); el.classList.remove("active"); off(); };
    el.addEventListener("touchstart", d, { passive: false });
    el.addEventListener("touchend", u, { passive: false });
    el.addEventListener("touchcancel", u, { passive: false });
  };
  // steering strip: where your thumb sits across it sets how far you steer
  const zone = root.querySelector("#t-steer");
  if (zone) {
    const knob = zone.querySelector(".knob");
    let id = null;
    const set = t => {
      const r = zone.getBoundingClientRect();
      const f = Math.max(-1, Math.min(1, (t.clientX - (r.left + r.width / 2)) / (r.width * 0.42)));
      touch.steer = -Math.sign(f) * Math.pow(Math.abs(f), 1.25);       // + = left
      if (knob) knob.style.transform = `translateX(${f * r.width * 0.42}px)`;
    };
    const find = e => [...e.changedTouches].find(t => t.identifier === id);
    zone.addEventListener("touchstart", e => {
      e.preventDefault();
      const t = e.changedTouches[0];
      id = t.identifier; touch.active = true; lastDevice = "touch";
      zone.classList.add("active"); set(t);
    }, { passive: false });
    zone.addEventListener("touchmove", e => { e.preventDefault(); const t = find(e); if (t) set(t); }, { passive: false });
    const end = e => {
      e.preventDefault();
      if (!find(e)) return;
      id = null; touch.steer = 0; zone.classList.remove("active");
      if (knob) knob.style.transform = "";
    };
    zone.addEventListener("touchend", end, { passive: false });
    zone.addEventListener("touchcancel", end, { passive: false });
  }
  bind("#t-gas", () => touch.accel = 1, () => touch.accel = 0);
  bind("#t-brake", () => touch.brake = 1, () => touch.brake = 0);
}

// --- tilt steering ------------------------------------------------------------
// Hold the phone sideways like a steering wheel. The roll of the screen against
// gravity is worked out from the orientation sensor, so it works whether the
// phone is held upright or tipped back. "Centre" is wherever it is held when
// calibrate() runs (at the start lights).
export const tilt = { enabled: false, working: false, steer: 0, roll: 0, zero: 0, invert: false, range: 28 };
let tiltListening = false;
function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  tilt.working = true;
  const b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
  // "down" in device coordinates (x right, y up the phone, z out of the screen)
  const dx = Math.sin(g) * Math.cos(b), dy = -Math.sin(b);
  // into screen coordinates for the current screen rotation
  const ang = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * Math.PI / 180;
  const sx = dx * Math.cos(ang) - dy * Math.sin(ang);
  const sy = dx * Math.sin(ang) + dy * Math.cos(ang);
  if (Math.hypot(sx, sy) < 0.12) return;          // lying flat: no reliable roll
  const roll = Math.atan2(sx, -sy) * 180 / Math.PI;  // + = right side down
  tilt.roll += (roll - tilt.roll) * 0.35;            // light smoothing
}
// Must be called straight from a tap: iPhones only show the permission prompt
// inside the tap itself. Resolves "ok", "denied", "embedded" or "unsupported".
export function tiltNeedsTap() {
  const D = window.DeviceOrientationEvent;
  return !!(D && typeof D.requestPermission === "function") && !tiltGranted;
}
let tiltGranted = false;
export function enableTilt() {
  const listen = () => {
    if (!tiltListening) { addEventListener("deviceorientation", onOrientation); tiltListening = true; }
    tilt.enabled = true;
  };
  const D = window.DeviceOrientationEvent;
  if (!D) return Promise.resolve("unsupported");
  if (typeof D.requestPermission === "function" && !tiltGranted) {
    let req;
    try {
      req = D.requestPermission();            // synchronous call: keeps the tap's permission
      const M = window.DeviceMotionEvent;
      if (M && typeof M.requestPermission === "function") M.requestPermission().catch(() => {});
    } catch { return Promise.resolve(window.top !== window.self ? "embedded" : "denied"); }
    return req.then(r => {
      if (r === "granted") { tiltGranted = true; listen(); return "ok"; }
      return window.top !== window.self ? "embedded" : "denied";
    }, () => window.top !== window.self ? "embedded" : "denied");
  }
  listen();
  return Promise.resolve("ok");
}
export function disableTilt() { tilt.enabled = false; tilt.steer = 0; }
export function calibrateTilt() { tilt.zero = tilt.roll; }
function tiltSteer() {
  if (!tilt.enabled || !tilt.working) return 0;
  let a = tilt.roll - tilt.zero;
  while (a > 180) a -= 360; while (a < -180) a += 360;
  const dead = 2;
  const v = Math.abs(a) < dead ? 0 : Math.sign(a) * (Math.abs(a) - dead) / (tilt.range - dead);
  const s = -Math.max(-1, Math.min(1, v));          // right side down = steer right
  return tilt.invert ? -s : s;
}

// --- gamepad ----------------------------------------------------------------
let padIndex = -1;
let padName = "";
const padPrev = [];
const padEdges = new Set();
let menuRepeat = { dir: null, t: 0 };

addEventListener("gamepadconnected", e => {
  padIndex = e.gamepad.index; padName = e.gamepad.id; lastDevice = "gamepad";
  dispatchEvent(new CustomEvent("pad-change", { detail: { connected: true, name: padName } }));
});
addEventListener("gamepaddisconnected", e => {
  if (e.gamepad.index === padIndex) { padIndex = -1; padName = ""; }
  dispatchEvent(new CustomEvent("pad-change", { detail: { connected: false } }));
});

function getPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  if (padIndex >= 0 && pads[padIndex]) return pads[padIndex];
  for (const p of pads) if (p && p.connected) { padIndex = p.index; padName = p.id; return p; }
  return null;
}

const dz = v => Math.abs(v) < DEADZONE ? 0 : Math.sign(v) * (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
const btn = (p, i) => p.buttons[i] ? p.buttons[i].value || (p.buttons[i].pressed ? 1 : 0) : 0;

let pad = { steer: 0, throttle: 0, brake: 0, present: false };

// Call once per frame before reading state.
export function pollInput(dt) {
  padEdges.clear();
  const p = getPad();
  if (!p) { pad.present = false; return; }
  pad.present = true;
  // standard mapping; triggers sometimes appear as axes on non-standard pads
  let rt = btn(p, 7), lt = btn(p, 6);
  if (p.mapping !== "standard" && p.axes.length >= 6) {
    rt = Math.max(rt, (p.axes[5] + 1) / 2); lt = Math.max(lt, (p.axes[2] + 1) / 2);
  }
  const sx = dz(p.axes[0] || 0);
  const curved = Math.sign(sx) * Math.pow(Math.abs(sx), 1.0 / Math.max(0.4, settings.steerSensitivity));
  pad.steer = -curved;                               // + = left
  pad.throttle = Math.max(rt, btn(p, 0));
  pad.brake = Math.max(lt, btn(p, 2));
  for (let i = 0; i < p.buttons.length; i++) {
    const down = !!(p.buttons[i] && p.buttons[i].pressed);
    if (down && !padPrev[i]) { padEdges.add(i); lastDevice = "gamepad"; }
    padPrev[i] = down;
  }
  if (Math.abs(sx) > 0.3 || rt > 0.2 || lt > 0.2) lastDevice = "gamepad";

  // menu navigation with stick/dpad, with key-repeat
  const sy = p.axes[1] || 0;
  let dir = null;
  if (btn(p, 12) || sy < -0.6) dir = "up";
  else if (btn(p, 13) || sy > 0.6) dir = "down";
  else if (btn(p, 14) || (p.axes[0] || 0) < -0.6) dir = "left";
  else if (btn(p, 15) || (p.axes[0] || 0) > 0.6) dir = "right";
  if (dir !== menuRepeat.dir) { menuRepeat = { dir, t: 0.35 }; if (dir) padEdges.add("nav-" + dir); }
  else if (dir) { menuRepeat.t -= dt; if (menuRepeat.t <= 0) { menuRepeat.t = 0.12; padEdges.add("nav-" + dir); } }
}

// --- merged driving state ---------------------------------------------------
const kb = { steer: 0 };
export function readDriving(dt) {
  // keyboard steering ramps so tapping works like a real wheel input
  let target = 0;
  if (keys.ArrowLeft || keys.KeyA) target += 1;
  if (keys.ArrowRight || keys.KeyD) target -= 1;
  const rate = target === 0 ? 7 : (Math.sign(target) !== Math.sign(kb.steer) ? 9 : 4.5);
  const d = target - kb.steer;
  kb.steer += Math.sign(d) * Math.min(Math.abs(d), rate * dt);

  tilt.steer = tiltSteer();
  let steer = kb.steer + touch.steer + pad.steer + tilt.steer;
  let throttle = (keys.ArrowUp || keys.KeyW) ? 1 : 0;
  let brake = (keys.ArrowDown || keys.KeyS || keys.Space) ? 1 : 0;
  throttle = Math.max(throttle, touch.accel, pad.throttle);
  brake = Math.max(brake, touch.brake, pad.brake);
  return {
    steer: Math.max(-1, Math.min(1, steer)),
    throttle: Math.min(1, throttle),
    brake: Math.min(1, brake),
    lookBack: !!(keys.KeyB) || (pad.present && !!padPrev[4]),
  };
}

// --- actions (edge triggered) ------------------------------------------------
const ACTIONS = {
  pause: { keys: ["Escape", "KeyP"], pad: [9] },
  camera: { keys: ["KeyC"], pad: [3] },
  respawn: { keys: ["KeyR"], pad: [8] },
  leaderboard: { keys: ["Tab", "KeyL"], pad: [] },
  confirm: { keys: ["Enter", "NumpadEnter"], pad: [0] },
  back: { keys: ["Escape", "Backspace"], pad: [1] },
  up: { keys: ["ArrowUp"], pad: ["nav-up"] },
  down: { keys: ["ArrowDown"], pad: ["nav-down"] },
  left: { keys: ["ArrowLeft"], pad: ["nav-left"] },
  right: { keys: ["ArrowRight"], pad: ["nav-right"] },
};
export function action(name) {
  const a = ACTIONS[name];
  return a.keys.some(k => pressedOnce.get(k) > 0) || a.pad.some(b => padEdges.has(b));
}
// Call at the end of each frame. Several presses inside one frame play out
// over the following frames instead of collapsing into one.
export function endFrame() {
  for (const [k, n] of pressedOnce) { if (n > 1) pressedOnce.set(k, n - 1); else pressedOnce.delete(k); }
}

export function inputDevice() { return lastDevice; }
export function gamepadName() { return pad.present ? padName : ""; }

// --- rumble -------------------------------------------------------------------
let rumbleUntil = 0;
export function rumble(strong, weak, ms) {
  if (!settings.rumble) return;
  const p = getPad();
  const act = p && p.vibrationActuator;
  if (!act || !act.playEffect) return;
  const t = performance.now();
  if (t < rumbleUntil && strong < 0.6) return;    // don't spam the motor
  rumbleUntil = t + ms * 0.8;
  act.playEffect("dual-rumble", {
    duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak),
  }).catch(() => {});
}
