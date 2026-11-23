// SoundBank: every sound in the game is synthesised on the fly with WebAudio.
//
// Three ideas keep this small:
//   * One shared one-second white-noise sample feeds every noise burst (gunshot,
//     footstep, crash, hat), so random data is generated once, not per effect.
//   * Engine, siren and tyre screech are persistent nodes built once; only their
//     parameters move, which is why they can follow speed smoothly.
//   * Every one-shot is described as data — a burst spec, a tone spec, or a
//     short timed sequence of them — played by two primitives below.
// No audio files, no network, nothing to load.
export class SoundBank {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;

    // Persistent voices, created lazily by ensure().
    this.engine = null;         // { osc, filter, gain }
    this.siren = null;          // { osc, gain }
    this.screech = null;        // { gain } — the looping noise node

    this._noise = null;         // shared white-noise AudioBuffer
    this.radioTimer = 0;
    // The radio's step counter lives here rather than on the wall clock, so a
    // backgrounded tab resumes mid-loop instead of firing a catch-up burst.
    this._radioStep = -1;
  }

  /** Create the context and the persistent voices. Safe to call repeatedly. */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);

    const ctx = this.ctx;
    // Engine: a saw through a lowpass, gain parked at silence until driving.
    const eOsc = ctx.createOscillator();
    eOsc.type = 'sawtooth';
    eOsc.frequency.value = 55;
    const eFilter = ctx.createBiquadFilter();
    eFilter.type = 'lowpass';
    eFilter.frequency.value = 320;
    const eGain = ctx.createGain();
    eGain.gain.value = 0;
    eOsc.connect(eFilter).connect(eGain).connect(this.master);
    eOsc.start();
    this.engine = { osc: eOsc, filter: eFilter, gain: eGain };

    // Siren: a triangle whose frequency alternates between two tones.
    const sOsc = ctx.createOscillator();
    sOsc.type = 'triangle';
    sOsc.frequency.value = 720;
    const sGain = ctx.createGain();
    sGain.gain.value = 0;
    sOsc.connect(sGain).connect(this.master);
    sOsc.start();
    this.siren = { osc: sOsc, gain: sGain };
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.5;
  }

  // ---- continuous voices -----------------------------------------------------

  /** The car's engine hum follows speed while seated; `on` mutes it on foot. */
  setEngine(speedKmh, on) {
    if (!this.engine) return;
    const t = this.ctx.currentTime;
    const e = this.engine;
    e.gain.gain.setTargetAtTime(on ? 0.04 + Math.min(0.05, speedKmh / 4200) : 0, t, 0.1);
    e.osc.frequency.setTargetAtTime(50 + speedKmh * 1.15, t, 0.08);
    e.filter.frequency.setTargetAtTime(280 + speedKmh * 6, t, 0.1);
  }

  /**
   * The police siren. Louder when a cruiser is near, faster wail above four
   * stars, and it keeps cycling off-screen so the heat stays audible.
   */
  setSiren(on, near, level = 1) {
    if (!this.siren) return;
    const t = this.ctx.currentTime;
    const s = this.siren;
    s.gain.gain.setTargetAtTime(on ? (near ? 0.05 : 0.022) * (0.7 + level * 0.12) : 0, t, 0.2);
    if (!on) return;
    const phase = Math.floor(t / (level >= 4 ? 0.3 : 0.45)) % 2;
    s.osc.frequency.setTargetAtTime(phase === 0 ? 660 : 920, t, 0.05);
  }

  /** Tyre screech under a handbrake slide; `amount` is 0..1. */
  setScreech(amount) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!this.screech) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer(1);
      src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1400;
      f.Q.value = 6;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      this.screech = { gain: g };
    }
    this.screech.gain.gain.setTargetAtTime(Math.min(0.09, amount * 0.09), t, 0.06);
  }

  // ---- primitives -----------------------------------------------------------

  /** A shared white-noise buffer of `seconds`, built once and reused. */
  noiseBuffer(seconds) {
    if (this._noise && this._noise.duration >= seconds) return this._noise;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;
    return buf;
  }

  /**
   * A filtered noise burst: [dur, freq, gain] plus an optional filter type
   * (default bandpass). A fresh copy of the shared noise is windowed down over
   * `dur`, so the same sample yields a pistol crack, a shotgun boom, a footstep
   * and a cymbal hat without allocating a buffer per shot.
   */
  _burst(spec, type = 'bandpass') {
    if (!this.ctx) return;
    const [dur, freq, gain] = spec;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.window(dur);
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** A `dur`-second slice of the shared noise, faded out linearly. */
  window(dur) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const out = buf.getChannelData(0);
    const src = this.noiseBuffer(1).getChannelData(0);
    const n = src.length;
    for (let i = 0; i < len; i++) out[i] = src[Math.floor((i / len) * n)] * (1 - i / len);
    return buf;
  }

  /** An oscillator blip, optionally sliding down/up to `slideTo` over `dur`. */
  _tone([freq, dur, gain], type = 'square', slideTo = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /**
   * Play a cue: a list of `[atMs, kind, ...args]` steps, where `kind` is
   *   'b' -> _burst([dur, freq, gain, type?])
   *   't' -> _tone([freq, dur, gain, type?, slideTo?])
   * Steps sharing an `atMs` start together, which is how a gunshot's crack and
   * its low body land as one hit.
   */
  _cue(steps) {
    for (const [at, kind, ...args] of steps) {
      setTimeout(() => {
        if (!this.ctx) return;
        if (kind === 'b') this._burst(args.slice(0, 3), args[3] ?? 'bandpass');
        else this._tone(args.slice(0, 3), args[3] ?? 'square', args[4] ?? null);
      }, at);
    }
  }

  // ---- public cues ----------------------------------------------------------

  /**
   * Fire the current weapon. Each entry is one step of the recipe; the melee
   * swing is a single soft thump, and anything unrecognised fires a pistol.
   */
  gunshot(kind) {
    const recipes = {
      melee: [[0, 'b', 0.1, 420, 0.25, 'lowpass']],
      shotgun: [[0, 'b', 0.24, 850, 0.5, 'lowpass'], [0, 't', 88, 0.18, 0.24, 'sine', 38]],
      rifle: [[0, 'b', 0.15, 1600, 0.4], [0, 't', 140, 0.1, 0.2, 'sine', 60]],
      smg: [[0, 'b', 0.08, 2300, 0.3]],
      pistol: [[0, 'b', 0.11, 1800, 0.35]],
    };
    this._cue(recipes[kind] ?? recipes.pistol);
  }

  /** A heavy impact: a low noise thump plus a falling body tone. */
  thud(strength = 1) {
    this._burst([0.18, 220, 0.34 * strength], 'lowpass');
    this._tone([70, 0.16, 0.3 * strength], 'sine', 34);
  }

  pickup() { this._cue([[0, 't', 660, 0.09, 0.2, 'sine'], [90, 't', 990, 0.15, 0.2, 'sine']]); }

  cash() {
    this._cue([[0, 't', 880, 0.06, 0.18], [60, 't', 1320, 0.1, 0.18], [160, 't', 1760, 0.16, 0.16]]);
  }

  click() { this._tone([1200, 0.04, 0.12]); }
  denied() { this._tone([180, 0.16, 0.2], 'square', 120); }
  mission() {
    this._cue([[0, 't', 523, 0.12, 0.22, 'sine'], [120, 't', 659, 0.12, 0.22, 'sine'], [240, 't', 784, 0.24, 0.22, 'sine']]);
  }
  busted() {
    this._cue([[0, 't', 392, 0.25, 0.25, 'sawtooth', 196], [0, 't', 311, 0.42, 0.25, 'sawtooth', 155]]);
  }
  wasted() {
    this._cue([[0, 't', 311, 0.3, 0.25, 'sawtooth', 155], [0, 't', 233, 0.55, 0.25, 'sawtooth', 116]]);
  }
  radioBlip() { this._cue([[0, 't', 880, 0.05, 0.1], [0, 't', 1174, 0.07, 0.1]]); }
  honk() { this._cue([[0, 't', 340, 0.16, 0.16], [0, 't', 425, 0.16, 0.14]]); }

  crash(hard = false) {
    this._burst(hard ? [0.34, 300, 0.5] : [0.2, 500, 0.3], 'lowpass');
    this._tone([hard ? 60 : 90, 0.22, 0.24], 'sine', 30);
  }

  spike() {
    this._burst([0.14, 2600, 0.3], 'highpass');
    this._tone([140, 0.2, 0.2], 'square', 70);
  }

  arrest() {
    this._cue([[0, 't', 660, 0.14, 0.2, 'square', 440], [0, 't', 440, 0.3, 0.2, 'square', 220]]);
  }

  engineStart() { this._tone([70, 0.5, 0.2], 'sawtooth', 180); }

  levelUp() {
    this._cue([[0, 't', 523, 0.16, 0.2, 'sine'], [90, 't', 659, 0.16, 0.2, 'sine'],
      [180, 't', 784, 0.16, 0.2, 'sine'], [270, 't', 1046, 0.16, 0.2, 'sine']]);
  }

  /** A single footstep; sprinting is louder and higher. */
  footstep(sprint = false) {
    this._burst(sprint ? [0.05, 900, 0.085] : [0.05, 600, 0.055], 'lowpass');
  }
  blip() { this._tone([980, 0.05, 0.09], 'sine'); }
  jump() { this._tone([280, 0.13, 0.07], 'sine', 470); }
  land(strength = 1) {
    this._burst([0.09, 300, 0.11 * strength], 'lowpass');
    this._tone([96, 0.1, 0.1 * strength], 'sine', 48);
  }

  /** A tiny synthesized car-radio loop: an eight-step bassline plus hats. */
  radioTick(dt, on) {
    if (!this.ctx) return;
    if (!on) {
      // Drop the pending step, so re-enabling the radio does not fire a burst
      // of catch-up notes from a timer that ran down while it was silent.
      this.radioTimer = 0;
      return;
    }
    this.radioTimer -= dt;
    if (this.radioTimer > 0) return;
    this.radioTimer = 0.23;
    const notes = [110, 0, 130.8, 0, 98, 0, 146.8, 123.5];
    this._radioStep = (this._radioStep + 1) % notes.length;
    if (notes[this._radioStep]) this._tone([notes[this._radioStep], 0.2, 0.05], 'triangle');
    if (this._radioStep % 2 === 0) this._burst([0.03, 6200, 0.028], 'highpass');
  }
}
