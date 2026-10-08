// ============================================================================
// Skid marks (a ring buffer of quads laid on the tarmac) and particles (tyre
// smoke, grass/dirt spray, sparks) in a single soft-point shader.
// ============================================================================

import * as THREE from "three";

export class SkidMarks {
  constructor(scene, max = 3000) {
    this.max = max;
    this.n = 0;
    this.head = 0;
    const pos = new Float32Array(max * 4 * 3);
    const alpha = new Float32Array(max * 4);
    const idx = new Uint32Array(max * 6);
    for (let k = 0; k < max; k++) {
      const v = k * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], k * 6);
    }
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.posAttr);
    g.setAttribute("alpha", this.alphaAttr);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      vertexShader: `attribute float alpha; varying float vA;
        #include <common>
        #include <fog_pars_vertex>
        void main(){ vA = alpha; vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: `varying float vA;
        #include <common>
        #include <fog_pars_fragment>
        void main(){ gl_FragColor = vec4(0.04,0.04,0.045, vA);
        #include <fog_fragment>
        }`,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.last = new Map();   // per wheel key -> previous point
  }

  // add/continue a mark for wheel `key` at world (x,y,z) with lateral dir (rx,rz)
  add(key, x, y, z, rx, rz, strength, width = 0.16) {
    const prev = this.last.get(key);
    if (strength < 0.05) { this.last.delete(key); return; }
    const cur = { x, y: y + 0.02, z, rx, rz };
    if (prev && Math.hypot(x - prev.x, z - prev.z) < 0.35) return;
    this.last.set(key, cur);
    if (!prev || Math.hypot(x - prev.x, z - prev.z) > 2.5) return;
    const k = this.head;
    this.head = (this.head + 1) % this.max;
    this.n = Math.min(this.max, this.n + 1);
    const p = this.posAttr.array, a = this.alphaAttr.array, o = k * 12;
    const w = width / 2;
    p[o] = prev.x - prev.rx * w; p[o + 1] = prev.y; p[o + 2] = prev.z - prev.rz * w;
    p[o + 3] = prev.x + prev.rx * w; p[o + 4] = prev.y; p[o + 5] = prev.z + prev.rz * w;
    p[o + 6] = x - rx * w; p[o + 7] = cur.y; p[o + 8] = z - rz * w;
    p[o + 9] = x + rx * w; p[o + 10] = cur.y; p[o + 11] = z + rz * w;
    const al = Math.min(0.55, 0.15 + strength * 0.45);
    a.fill(al, k * 4, k * 4 + 4);
    this.posAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  clear() {
    this.alphaAttr.array.fill(0);
    this.alphaAttr.needsUpdate = true;
    this.last.clear();
  }
}

export class Particles {
  constructor(scene, max = 1500) {
    this.max = max;
    this.p = [];
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("size", new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { scale: { value: 600 } },
      vertexShader: `attribute float size; attribute vec4 color; varying vec4 vC; uniform float scale;
        void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * scale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec4 vC;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d)*4.0; if (r > 1.0) discard;
          gl_FragColor = vec4(vC.rgb, vC.a * (1.0 - r) * (1.0 - r)); }`,
    });
    this.mat = mat;
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
  }

  setViewport(h) { this.mat.uniforms.scale.value = h * 0.6; }

  emit(kind, x, y, z, vx, vz, n = 1) {
    for (let k = 0; k < n; k++) {
      if (this.p.length >= this.max) this.p.shift();
      const r = Math.random;
      if (kind === "smoke") {
        this.p.push({ x: x + (r() - 0.5) * 0.2, y: y + 0.1, z: z + (r() - 0.5) * 0.2,
          vx: vx * 0.3 + (r() - 0.5) * 0.6, vy: 0.4 + r() * 0.5, vz: vz * 0.3 + (r() - 0.5) * 0.6,
          life: 0, max: 1.4 + r() * 0.8, s0: 0.35, s1: 2.2, c: [0.86, 0.86, 0.86], a: 0.32, g: -0.05, drag: 1.8 });
      } else if (kind === "grass") {
        this.p.push({ x, y: y + 0.05, z, vx: vx * 0.4 + (r() - 0.5) * 1.6, vy: 1.2 + r() * 1.8, vz: vz * 0.4 + (r() - 0.5) * 1.6,
          life: 0, max: 0.6 + r() * 0.4, s0: 0.10, s1: 0.06, c: r() < 0.5 ? [0.32, 0.45, 0.18] : [0.36, 0.28, 0.18], a: 0.95, g: 9, drag: 0.8 });
      } else if (kind === "dust") {
        this.p.push({ x, y: y + 0.1, z, vx: vx * 0.2 + (r() - 0.5) * 0.5, vy: 0.3 + r() * 0.3, vz: vz * 0.2 + (r() - 0.5) * 0.5,
          life: 0, max: 1.2 + r() * 0.6, s0: 0.4, s1: 1.8, c: [0.62, 0.56, 0.44], a: 0.22, g: 0, drag: 1.5 });
      } else if (kind === "spark") {
        this.p.push({ x, y: y + 0.2, z, vx: (r() - 0.5) * 5, vy: 1 + r() * 3, vz: (r() - 0.5) * 5,
          life: 0, max: 0.25 + r() * 0.25, s0: 0.06, s1: 0.02, c: [1.0, 0.75, 0.3], a: 1, g: 9, drag: 0.5 });
      }
    }
  }

  update(dt) {
    const ps = this.p;
    let w = 0;
    for (let k = 0; k < ps.length; k++) {
      const q = ps[k];
      q.life += dt;
      if (q.life >= q.max) continue;
      const f = Math.exp(-q.drag * dt);
      q.vx *= f; q.vz *= f; q.vy = q.vy * f - q.g * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      ps[w++] = q;
    }
    ps.length = w;
    for (let k = 0; k < ps.length; k++) {
      const q = ps[k], t = q.life / q.max;
      this.pos[k * 3] = q.x; this.pos[k * 3 + 1] = q.y; this.pos[k * 3 + 2] = q.z;
      this.col[k * 4] = q.c[0]; this.col[k * 4 + 1] = q.c[1]; this.col[k * 4 + 2] = q.c[2];
      this.col[k * 4 + 3] = q.a * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
      this.size[k] = q.s0 + (q.s1 - q.s0) * t;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, ps.length);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
  }
}
