// ============================================================================
// Procedural audio (WebAudio, no samples): a two-stroke engine for the player,
// a shared engine bed for nearby opponents, tyre squeal, kerb rumble, impacts
// and start-light beeps.
// ============================================================================

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = this.ctx = new Ctx();
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp); comp.connect(ctx.destination);

    // --- player engine: two detuned saws through a waveshaper and a lowpass
    this.engine = this._engineVoice(0.0);
    // --- opponents bed
    this.others = this._engineVoice(0.0, 0.85);

    // --- noise source for squeal / rumble / wind
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };

    this.squeal = ctx.createGain(); this.squeal.gain.value = 0;
    const sq = ctx.createBiquadFilter(); sq.type = "bandpass"; sq.frequency.value = 1900; sq.Q.value = 9;
    this.squealFilter = sq;
    noise().connect(sq); sq.connect(this.squeal); this.squeal.connect(this.master);

    this.rumbleG = ctx.createGain(); this.rumbleG.gain.value = 0;
    const rb = ctx.createBiquadFilter(); rb.type = "lowpass"; rb.frequency.value = 140;
    const rumbleLfo = ctx.createOscillator(); rumbleLfo.frequency.value = 26;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.4;
    const am = ctx.createGain(); am.gain.value = 0.6;          // tremolo stage
    rumbleLfo.connect(lfoGain); lfoGain.connect(am.gain); rumbleLfo.start();
    this.rumbleLfo = rumbleLfo;
    noise().connect(rb); rb.connect(am); am.connect(this.rumbleG); this.rumbleG.connect(this.master);

    this.wind = ctx.createGain(); this.wind.gain.value = 0;
    const wf = ctx.createBiquadFilter(); wf.type = "highpass"; wf.frequency.value = 600;
    noise().connect(wf); wf.connect(this.wind); this.wind.connect(this.master);
    this.noiseFactory = noise;
  }

  _engineVoice(gain, pitchMul = 1) {
    const ctx = this.ctx;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), o3 = ctx.createOscillator();
    o1.type = "sawtooth"; o2.type = "sawtooth"; o3.type = "square";
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) { const x = i / 256 - 1; curve[i] = Math.tanh(x * 2.4); }
    shaper.curve = curve;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1200; lp.Q.value = 2;
    const g = ctx.createGain(); g.gain.value = gain;
    const mix = ctx.createGain(); mix.gain.value = 0.35;
    o1.connect(mix); o2.connect(mix); o3.connect(mix);
    mix.connect(shaper); shaper.connect(lp); lp.connect(g); g.connect(this.master);
    o1.start(); o2.start(); o3.start();
    return { o1, o2, o3, lp, g, pitchMul };
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  _setEngine(e, rpm01, load, vol) {
    const t = this.ctx.currentTime;
    const f = (58 + rpm01 * 230) * e.pitchMul;
    e.o1.frequency.setTargetAtTime(f, t, 0.03);
    e.o2.frequency.setTargetAtTime(f * 1.007, t, 0.03);
    e.o3.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    e.lp.frequency.setTargetAtTime(500 + rpm01 * 2200 + load * 900, t, 0.05);
    e.g.gain.setTargetAtTime(vol, t, 0.06);
  }

  // per-frame update
  update({ running, speed01, throttle, skid, kerb, offTrack, nearOther, paused }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = running && !paused;
    const rpm = Math.min(1, speed01 * 0.92 + throttle * 0.12);
    this._setEngine(this.engine, rpm, throttle, on ? 0.10 + throttle * 0.10 + speed01 * 0.05 : (paused ? 0 : 0.05));
    this._setEngine(this.others, 0.6 + 0.3 * Math.sin(t * 0.7), 0.6, on ? nearOther * 0.09 : 0);
    this.squeal.gain.setTargetAtTime(on ? Math.min(0.12, skid * 0.12) * (offTrack ? 0 : 1) : 0, t, 0.05);
    this.squealFilter.frequency.setTargetAtTime(1600 + skid * 700, t, 0.1);
    this.rumbleG.gain.setTargetAtTime(on ? (kerb ? 0.35 : 0) + (offTrack ? 0.25 * speed01 : 0) : 0, t, 0.04);
    this.rumbleLfo.frequency.setTargetAtTime(offTrack ? 11 : 18 + speed01 * 20, t, 0.1);
    this.wind.gain.setTargetAtTime(on ? speed01 * speed01 * 0.035 : 0, t, 0.2);
  }

  impact(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = this.noiseFactory();
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.9, 0.15 + strength * 0.12), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.stop(t + 0.4);
  }

  beep(high) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = high ? 1320 : 660;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (high ? 0.6 : 0.25));
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.7);
  }
}
