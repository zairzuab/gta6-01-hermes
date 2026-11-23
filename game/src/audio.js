// Sound: every effect is synthesised with WebAudio — engine hum, a two-tone
// police siren, gunshots per weapon, melee thuds, radio bleeps and a small
// synthesized car-radio loop. No audio files, no network.
export class SoundBank {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.engineOsc = null;
    this.engineGain = null;
    this.engineFilter = null;
    this.sirenOsc = null;
    this.sirenGain = null;
    this.radioTimer = 0;
    // The radio's step counter lives here so a backgrounded tab does not make
    // the loop skip notes; see radioTick.
    this._radioStep = -1;
  }

  /** Create the context and the persistent engine/siren voices (on first use). */
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

    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 55;
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 320;
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();

    this.sirenOsc = this.ctx.createOscillator();
    this.sirenOsc.type = 'triangle';
    this.sirenOsc.frequency.value = 720;
    this.sirenGain = this.ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenGain);
    this.sirenGain.connect(this.master);
    this.sirenOsc.start();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  setEngine(speedKmh, on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(on ? 0.04 + Math.min(0.05, speedKmh / 4200) : 0, t, 0.1);
    this.engineOsc.frequency.setTargetAtTime(50 + speedKmh * 1.15, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(280 + speedKmh * 6, t, 0.1);
  }

  setSiren(on, near, level = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const gain = on ? (near ? 0.05 : 0.022) * (0.7 + level * 0.12) : 0;
    this.sirenGain.gain.setTargetAtTime(gain, t, 0.2);
    if (on) {
      const phase = Math.floor(t / (level >= 4 ? 0.3 : 0.45)) % 2;
      this.sirenOsc.frequency.setTargetAtTime(phase === 0 ? 660 : 920, t, 0.05);
    }
  }

  /** Tyre screech while the handbrake slides; `amount` 0..1. */
  setScreech(amount) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!this.screechGain) {
      const len = Math.floor(this.ctx.sampleRate * 1);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 6;
      this.screechGain = this.ctx.createGain();
      this.screechGain.gain.value = 0;
      src.connect(f); f.connect(this.screechGain); this.screechGain.connect(this.master);
      src.start();
    }
    this.screechGain.gain.setTargetAtTime(Math.min(0.09, amount * 0.09), t, 0.06);
  }

  _noiseBurst(dur, filterFreq, gain, type = 'bandpass') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Every burst is white noise; the filter and the decay shape the sound, so
    // one shared buffer serves every gunshot, footstep and crash instead of
    // allocating (and uploading) a fresh one per effect.
    if (!this._noise) {
      const n = Math.floor(this.ctx.sampleRate * 0.5);
      this._noise = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const nd = this._noise.getChannelData(0);
      for (let i = 0; i < n; i++) nd[i] = Math.random() * 2 - 1;
    }
    const srcData = this._noise.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = srcData[Math.floor((i / len) * this._noise.length)] * (1 - i / len);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t);
  }

  _tone(freq, dur, gain, type = 'square', slideTo = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  gunshot(kind) {
    if (kind === 'melee') { this._noiseBurst(0.1, 420, 0.25, 'lowpass'); return; }
    if (kind === 'shotgun') { this._noiseBurst(0.24, 850, 0.5, 'lowpass'); this._tone(88, 0.18, 0.24, 'sine', 38); }
    else if (kind === 'rifle') { this._noiseBurst(0.15, 1600, 0.4); this._tone(140, 0.1, 0.2, 'sine', 60); }
    else if (kind === 'smg') { this._noiseBurst(0.08, 2300, 0.3); }
    else { this._noiseBurst(0.11, 1800, 0.35); }
  }

  thud(strength = 1) {
    this._noiseBurst(0.18, 220, 0.34 * strength, 'lowpass');
    this._tone(70, 0.16, 0.3 * strength, 'sine', 34);
  }

  pickup() { this._tone(660, 0.09, 0.2, 'sine'); this._tone(990, 0.15, 0.2, 'sine'); }
  cash() { this._tone(880, 0.06, 0.18, 'square'); this._tone(1320, 0.1, 0.18, 'square'); this._tone(1760, 0.16, 0.16, 'square'); }
  click() { this._tone(1200, 0.04, 0.12, 'square'); }
  /** A denied action: a low, falling buzz, distinct from the UI click. */
  denied() { this._tone(180, 0.16, 0.2, 'square', 120); }
  /** A pick-up or a job stage: two rising notes, the game's "good" cue. */
  mission() { this._tone(523, 0.12, 0.22, 'sine'); this._tone(659, 0.12, 0.22, 'sine'); this._tone(784, 0.24, 0.22, 'sine'); }
  busted() { this._tone(392, 0.25, 0.25, 'sawtooth', 196); this._tone(311, 0.42, 0.25, 'sawtooth', 155); }
  wasted() { this._tone(311, 0.3, 0.25, 'sawtooth', 155); this._tone(233, 0.55, 0.25, 'sawtooth', 116); }
  radioBlip() { this._tone(880, 0.05, 0.1, 'square'); this._tone(1174, 0.07, 0.1, 'square'); }
  honk() { this._tone(340, 0.16, 0.16, 'square'); this._tone(425, 0.16, 0.14, 'square'); }
  crash(hard = false) {
    this._noiseBurst(hard ? 0.34 : 0.2, hard ? 300 : 500, hard ? 0.5 : 0.3, 'lowpass');
    this._tone(hard ? 60 : 90, 0.22, 0.24, 'sine', 30);
  }
  spike() { this._noiseBurst(0.14, 2600, 0.3, 'highpass'); this._tone(140, 0.2, 0.2, 'square', 70); }
  arrest() { this._tone(660, 0.14, 0.2, 'square', 440); this._tone(440, 0.3, 0.2, 'square', 220); }
  engineStart() { this._tone(70, 0.5, 0.2, 'sawtooth', 180); }
  levelUp() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this._tone(f, 0.16, 0.2, 'sine'), i * 90)); }

  /** A single footstep; sprinting is louder and higher. */
  footstep(sprint = false) {
    this._noiseBurst(0.05, sprint ? 900 : 600, sprint ? 0.085 : 0.055, 'lowpass');
  }
  /** A short, quiet confirm for a menu click or a job stage. */
  blip() { this._tone(980, 0.05, 0.09, 'sine'); }
  jump() { this._tone(280, 0.13, 0.07, 'sine', 470); }
  land(strength = 1) {
    this._noiseBurst(0.09, 300, 0.11 * strength, 'lowpass');
    this._tone(96, 0.1, 0.1 * strength, 'sine', 48);
  }

  /** A little synthesized radio: a looping bassline plus hats. */
  radioTick(dt, on) {
    if (!this.ctx) return;
    if (!on) {
      // Forget the pending step, so turning the radio back on does not fire a
      // burst of catch-up notes from a timer that ran down while it was off.
      this.radioTimer = 0;
      return;
    }
    this.radioTimer -= dt;
    if (this.radioTimer > 0) return;
    this.radioTimer = 0.23;
    const notes = [110, 0, 130.8, 0, 98, 0, 146.8, 123.5];
    // Step a counter, not the wall clock: deriving the note from currentTime
    // skips and repeats notes after a tab is backgrounded and resumed.
    this._radioStep = (this._radioStep + 1) % notes.length;
    const n = notes[this._radioStep];
    if (n) this._tone(n, 0.2, 0.05, 'triangle');
    if (this._radioStep % 2 === 0) this._noiseBurst(0.03, 6200, 0.028, 'highpass');
  }
}
