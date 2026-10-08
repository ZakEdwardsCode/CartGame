// ============================================================================
// Procedural kart + driver model. Geometry is shared across karts; materials
// are per livery. Origin = ground under the CG; the model faces +z with its
// left side on +x. The game rotates it so +z points along the kart's heading.
// ============================================================================

import * as THREE from "three";

const GEO = {};
function geo(key, make) { return GEO[key] || (GEO[key] = make()); }

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function numberTexture(num, bg, fg) {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 96;
  const g = c.getContext("2d");
  g.fillStyle = bg; g.fillRect(0, 0, 128, 96);
  g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(4, 4, 120, 88);
  g.fillStyle = fg; g.font = "900 64px system-ui, Arial, sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(String(num), 64, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function stripeTexture(base, stripe) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = base; g.fillRect(0, 0, 256, 64);
  g.fillStyle = stripe;
  g.beginPath(); g.moveTo(0, 40); g.lineTo(256, 14); g.lineTo(256, 26); g.lineTo(0, 52); g.fill();
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.beginPath(); g.moveTo(0, 54); g.lineTo(256, 28); g.lineTo(256, 31); g.lineTo(0, 57); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function tyreGeometry(R, W) {
  // rounded shoulder profile, revolved
  const pts = [];
  const rim = R * 0.62, sh = Math.min(W * 0.28, R * 0.25);
  pts.push(new THREE.Vector2(rim, -W / 2));
  pts.push(new THREE.Vector2(R - sh, -W / 2));
  for (let k = 0; k <= 6; k++) {
    const a = -Math.PI / 2 + (k / 6) * Math.PI / 2;
    pts.push(new THREE.Vector2(R - sh + Math.cos(a) * sh, -W / 2 + sh + Math.sin(a) * sh));
  }
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * Math.PI / 2;
    pts.push(new THREE.Vector2(R - sh + Math.cos(a) * sh, W / 2 - sh + Math.sin(a) * sh));
  }
  pts.push(new THREE.Vector2(rim, W / 2));
  const g = new THREE.LatheGeometry(pts, 28);
  g.rotateZ(Math.PI / 2);          // axle along x
  return g;
}

function rimGeometry(R, W) {
  const g = new THREE.CylinderGeometry(R * 0.62, R * 0.62, W * 0.9, 20, 1, true);
  g.rotateZ(Math.PI / 2);
  return g;
}

export function buildKart({ color = "#d8202a", accent = "#ffffff", suit = "#24303f", helmet = "#eceff1", number = 1, ghost = false } = {}) {
  const g = new THREE.Group();
  const mats = [];
  const M = (opts) => {
    const m = new THREE.MeshStandardMaterial(opts);
    if (ghost) { m.transparent = true; m.opacity = 0.38; m.depthWrite = false; }
    mats.push(m);
    return m;
  };
  const body = M({ color, roughness: 0.28, metalness: 0.05, map: stripeTexture(color, accent) });
  const bodyPlain = M({ color, roughness: 0.3, metalness: 0.05 });
  const black = M({ color: 0x141418, roughness: 0.75, metalness: 0.05 });
  const chrome = M({ color: 0xc4c9cf, roughness: 0.18, metalness: 1.0 });
  const alu = M({ color: 0x9aa1a8, roughness: 0.35, metalness: 0.9, side: THREE.DoubleSide });
  const rubber = M({ color: 0x18181b, roughness: 0.92, metalness: 0.0, side: THREE.DoubleSide });
  const engineMat = M({ color: 0x3d4148, roughness: 0.45, metalness: 0.7 });
  const suitMat = M({ color: suit, roughness: 0.8, metalness: 0.0 });
  const helmetMat = M({ color: helmet, roughness: 0.18, metalness: 0.1, map: stripeTexture(helmet, color) });
  const visorMat = M({ color: 0x0b0d14, roughness: 0.05, metalness: 0.9 });
  const glove = M({ color: 0x111114, roughness: 0.85 });
  const numMat = M({ map: numberTexture(number, "#f4f4f0", "#141414"), roughness: 0.5 });

  const cast = m => { m.castShadow = !ghost; m.receiveShadow = !ghost; return m; };
  const add = (parent, mesh) => { parent.add(cast(mesh)); return mesh; };

  // chassis & bodywork live under `chassis` so they can roll/pitch on the tyres
  const chassis = new THREE.Group();
  g.add(chassis);

  // --- frame tubes
  const tube = (len, r = 0.022) => geo(`tube${len}${r}`, () => new THREE.CylinderGeometry(r, r, len, 10));
  for (const sx of [-1, 1]) {
    const rail = add(chassis, new THREE.Mesh(tube(1.5), chrome));
    rail.rotation.x = Math.PI / 2; rail.position.set(sx * 0.32, 0.075, 0.05);
  }
  for (const z of [-0.55, 0.0, 0.55]) {
    const cross = add(chassis, new THREE.Mesh(tube(0.7), chrome));
    cross.rotation.z = Math.PI / 2; cross.position.set(0, 0.075, z);
  }
  // floor tray
  const tray = add(chassis, new THREE.Mesh(geo("tray", () => new THREE.BoxGeometry(0.5, 0.012, 0.95)), alu));
  tray.position.set(0, 0.07, 0.25);

  // --- front nose fairing (extruded rounded trapezoid, top view)
  const nose = add(chassis, new THREE.Mesh(geo("nose", () => {
    const s = new THREE.Shape();
    s.moveTo(-0.46, 0.0); s.lineTo(0.46, 0.0);
    s.quadraticCurveTo(0.50, 0.18, 0.36, 0.30);
    s.lineTo(-0.36, 0.30);
    s.quadraticCurveTo(-0.50, 0.18, -0.46, 0.0);
    const e = new THREE.ExtrudeGeometry(s, { depth: 0.13, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.035, bevelSegments: 4, curveSegments: 10 });
    e.rotateX(Math.PI / 2);           // shape y -> world z, extrude -> world -y
    e.translate(0, 0.22, 0);
    return e;
  }), body));
  nose.position.set(0, 0, 0.92);

  // front panel / number plate, slanted
  const panel = add(chassis, new THREE.Mesh(geo("panel", () => {
    const e = new THREE.ExtrudeGeometry(roundedRectShape(0.34, 0.26, 0.05), { depth: 0.018, bevelEnabled: false });
    return e;
  }), bodyPlain));
  panel.position.set(0, 0.36, 0.78); panel.rotation.x = -0.55;
  const num = new THREE.Mesh(geo("num", () => new THREE.PlaneGeometry(0.27, 0.19)), numMat);
  num.position.set(0, 0, 0.0195); panel.add(num);

  // --- side pods (side profile extruded across their width)
  for (const sx of [-1, 1]) {
    const pod = add(chassis, new THREE.Mesh(geo("pod", () => {
      const s = new THREE.Shape();
      s.moveTo(-0.38, 0.0); s.lineTo(0.30, 0.0);
      s.quadraticCurveTo(0.42, 0.04, 0.36, 0.16);
      s.lineTo(-0.30, 0.20);
      s.quadraticCurveTo(-0.42, 0.18, -0.38, 0.0);
      const e = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 3, curveSegments: 8 });
      e.rotateY(-Math.PI / 2);         // profile in the y/z plane, depth across x
      e.translate(0.08, 0, 0);
      return e;
    }), body));
    pod.position.set(sx * 0.52, 0.09, 0.0);
  }

  // --- rear bumper
  const rb = add(chassis, new THREE.Mesh(geo("rbump", () => {
    const e = new THREE.ExtrudeGeometry(roundedRectShape(1.22, 0.16, 0.06), { depth: 0.12, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 });
    e.translate(0, 0, -0.06);
    return e;
  }), black));
  rb.position.set(0, 0.17, -0.98);

  // --- seat (shell)
  const seat = add(chassis, new THREE.Mesh(geo("seat", () => {
    const g2 = new THREE.SphereGeometry(0.27, 20, 14, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.65);
    g2.scale(1, 1.25, 1.05);
    return g2;
  }), black));
  seat.material.side = THREE.DoubleSide;
  seat.position.set(0, 0.42, -0.30); seat.rotation.x = -0.25;

  // --- engine, exhaust, chain guard, fuel tank
  const eng = add(chassis, new THREE.Mesh(geo("eng", () => new THREE.BoxGeometry(0.26, 0.28, 0.32)), engineMat));
  eng.position.set(-0.40, 0.25, -0.55);
  const fins = add(chassis, new THREE.Mesh(geo("fins", () => new THREE.CylinderGeometry(0.11, 0.11, 0.22, 16)), alu));
  fins.position.set(-0.40, 0.48, -0.55);
  const airbox = add(chassis, new THREE.Mesh(geo("airbox", () => new THREE.CapsuleGeometry(0.07, 0.18, 6, 12)), black));
  airbox.rotation.z = Math.PI / 2; airbox.position.set(-0.20, 0.40, -0.48);
  const pipe = add(chassis, new THREE.Mesh(geo("pipe", () => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.42, 0.30, -0.42), new THREE.Vector3(-0.58, 0.32, -0.55),
      new THREE.Vector3(-0.60, 0.36, -0.85), new THREE.Vector3(-0.50, 0.40, -1.02),
    ]);
    return new THREE.TubeGeometry(curve, 20, 0.04, 10, false);
  }), chrome));
  pipe.position.set(0, 0, 0);
  const guard = add(chassis, new THREE.Mesh(geo("guard", () => new THREE.BoxGeometry(0.05, 0.16, 0.30)), black));
  guard.position.set(-0.30, 0.20, -0.62);
  const tank = add(chassis, new THREE.Mesh(geo("tank", () => new THREE.CapsuleGeometry(0.08, 0.14, 6, 12)), M({ color: 0xe8e8e0, roughness: 0.4, transparent: ghost, opacity: ghost ? 0.38 : 1 })));
  tank.rotation.x = Math.PI / 2; tank.position.set(0, 0.22, 0.42);

  // --- steering column & wheel
  const col = add(chassis, new THREE.Mesh(tube(0.46, 0.014), chrome));
  col.position.set(0, 0.34, 0.40); col.rotation.x = -0.95;
  const sw = new THREE.Group();
  const rim = add(sw, new THREE.Mesh(geo("swrim", () => new THREE.TorusGeometry(0.15, 0.022, 10, 28)), black));
  for (let k = 0; k < 3; k++) {
    const sp = add(sw, new THREE.Mesh(geo("swsp", () => new THREE.BoxGeometry(0.14, 0.016, 0.026)), alu));
    const a = Math.PI / 2 + k * Math.PI * 2 / 3;
    sp.rotation.z = a; sp.position.set(Math.cos(a) * 0.07, Math.sin(a) * 0.07, 0);
  }
  const hub = add(sw, new THREE.Mesh(geo("swhub", () => new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12)), black));
  hub.rotation.x = Math.PI / 2;
  sw.position.set(0, 0.56, 0.24); sw.rotation.x = 0.62;
  chassis.add(sw);
  void rim;

  // --- wheels: steer pivot (y) -> spin (x)
  const wheels = [];
  function wheel(x, z, R, W, front) {
    const pivot = new THREE.Group();
    pivot.position.set(x, R, z);
    const spin = new THREE.Group();
    pivot.add(spin);
    add(spin, new THREE.Mesh(geo(`tyre${R}${W}`, () => tyreGeometry(R, W)), rubber));
    add(spin, new THREE.Mesh(geo(`rim${R}${W}`, () => rimGeometry(R, W)), alu));
    const face = add(spin, new THREE.Mesh(geo(`face${R}`, () => {
      const c = new THREE.CircleGeometry(R * 0.62, 20); c.rotateY(Math.PI / 2); return c;
    }), alu));
    face.position.x = Math.sign(x) * W * 0.44;
    for (let k = 0; k < 5; k++) {
      const spoke = add(spin, new THREE.Mesh(geo(`spoke${R}`, () => new THREE.BoxGeometry(0.02, R * 1.0, 0.045)), chrome));
      spoke.rotation.x = k * Math.PI * 2 / 5;
      spoke.position.x = Math.sign(x) * W * 0.46;
    }
    g.add(pivot);
    wheels.push({ pivot, spin, front, R });
    return pivot;
  }
  wheel(0.56, 0.62, 0.135, 0.13, true);
  wheel(-0.56, 0.62, 0.135, 0.13, true);
  wheel(0.60, -0.58, 0.14, 0.21, false);
  wheel(-0.60, -0.58, 0.14, 0.21, false);
  // stub axles / rear axle
  const axle = add(chassis, new THREE.Mesh(geo("axle", () => { const c = new THREE.CylinderGeometry(0.025, 0.025, 1.2, 10); c.rotateZ(Math.PI / 2); return c; }), chrome));
  axle.position.set(0, 0.14, -0.58);

  // --- driver
  const driver = new THREE.Group();
  chassis.add(driver);
  const torso = add(driver, new THREE.Mesh(geo("torso", () => new THREE.CapsuleGeometry(0.17, 0.26, 6, 14)), suitMat));
  torso.position.set(0, 0.62, -0.30); torso.rotation.x = -0.28;
  const shoulders = add(driver, new THREE.Mesh(geo("shoulders", () => new THREE.CapsuleGeometry(0.09, 0.26, 6, 10)), suitMat));
  shoulders.rotation.z = Math.PI / 2; shoulders.position.set(0, 0.78, -0.25);
  const neck = add(driver, new THREE.Mesh(geo("neck", () => new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10)), black));
  neck.position.set(0, 0.86, -0.25);
  const arms = [];
  for (const sx of [-1, 1]) {
    // upper arm from shoulder towards the wheel, forearm to the grip
    const upper = add(driver, new THREE.Mesh(geo("uarm", () => { const c = new THREE.CapsuleGeometry(0.048, 0.22, 6, 10); c.translate(0, -0.13, 0); return c; }), suitMat));
    upper.position.set(sx * 0.21, 0.77, -0.24);
    upper.rotation.set(-1.0, 0, sx * 0.25);
    const fore = add(upper, new THREE.Mesh(geo("farm", () => { const c = new THREE.CapsuleGeometry(0.042, 0.2, 6, 10); c.translate(0, -0.12, 0); return c; }), suitMat));
    fore.position.set(0, -0.27, 0); fore.rotation.set(-0.55, 0, -sx * 0.55);
    const hand = add(fore, new THREE.Mesh(geo("hand", () => new THREE.SphereGeometry(0.05, 10, 8)), glove));
    hand.position.set(0, -0.26, 0);
    arms.push(upper);
  }
  for (const sx of [-1, 1]) {
    const thigh = add(driver, new THREE.Mesh(geo("thigh", () => new THREE.CapsuleGeometry(0.075, 0.36, 6, 10)), suitMat));
    thigh.position.set(sx * 0.13, 0.36, 0.0); thigh.rotation.x = Math.PI / 2 - 0.25;
    const shin = add(driver, new THREE.Mesh(geo("shin", () => new THREE.CapsuleGeometry(0.06, 0.34, 6, 10)), suitMat));
    shin.position.set(sx * 0.12, 0.27, 0.40); shin.rotation.x = Math.PI / 2 + 0.18;
    const boot = add(driver, new THREE.Mesh(geo("boot", () => new THREE.BoxGeometry(0.09, 0.12, 0.16)), black));
    boot.position.set(sx * 0.12, 0.22, 0.62);
  }
  const head = new THREE.Group();
  head.position.set(0, 0.98, -0.24);
  driver.add(head);
  const helm = add(head, new THREE.Mesh(geo("helmet", () => { const s = new THREE.SphereGeometry(0.15, 24, 18); s.scale(1, 1.05, 1.12); return s; }), helmetMat));
  helm.rotation.y = -Math.PI / 2;
  const visor = add(head, new THREE.Mesh(geo("visor", () => {
    const s = new THREE.SphereGeometry(0.153, 24, 12, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.36, Math.PI * 0.24);
    s.scale(1, 1.05, 1.12);
    return s;
  }), visorMat));
  void visor;

  g.userData = { chassis, wheels, steeringWheel: sw, head, driver, materials: mats, ghost };
  return g;
}

// per-frame pose from the physics body
export function poseKart(mesh, k, dt) {
  const u = mesh.userData;
  for (const w of u.wheels) {
    if (w.front) w.pivot.rotation.y = k.delta;
    w.spin.rotation.x = k.wheelRot * (0.25 / w.R) % (Math.PI * 2);
  }
  u.steeringWheel.rotation.z = -k.delta * 2.6;
  u.chassis.rotation.z = -k.roll;
  u.chassis.rotation.x = -k.pitch;     // nose dives under braking
  const bump = k.bump ? (Math.random() - 0.5) * 0.012 * k.bump : 0;
  u.chassis.position.y = bump;
  // driver looks into the corner
  u.head.rotation.y += ((k.delta * 1.3) - u.head.rotation.y) * Math.min(1, dt * 6);
  u.head.rotation.z = k.roll * 1.5;
}

export function setKartOpacity(mesh, o) {
  for (const m of mesh.userData.materials) { m.transparent = o < 1; m.opacity = o; m.depthWrite = o >= 1; }
}
