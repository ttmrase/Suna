// Suna — sound, synthesised on the fly (no audio files).
//
//   stream : filtered noise whose loudness follows how much water is moving
//   sea    : a low wash that swells and fades like small waves
//   scrape : a hiss while a finger works the sand

function noiseBuffer(ctx, seconds, brown) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * white) / 1.02; d[i] = last * 3.5; } else d[i] = white;
  }
  // cross-fade the tail into the head so the loop has no click
  const fade = Math.min(n >> 2, 2048);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[i] = d[i] * k + d[n - fade + i] * (1 - k);
  }
  return buf;
}

export class Sound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this._flow = 0;
    this._scrape = 0;
  }

  /** Browsers only allow sound after a touch; call this from one. */
  unlock() {
    if (!this.enabled) return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try { ctx = new AC(); } catch { return; }
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    master.gain.setTargetAtTime(1.6, ctx.currentTime, 0.6);
    this.master = master;

    const white = noiseBuffer(ctx, 2.7, false);
    const brown = noiseBuffer(ctx, 3.3, true);
    const loop = (buf) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true; src.start();
      return src;
    };
    const filter = (type, freq, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      return f;
    };
    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const wobble = (param, rate, depth) => {
      const o = ctx.createOscillator(), g = gain(depth);
      o.frequency.value = rate; o.connect(g); g.connect(param); o.start();
    };

    // stream: a soft rush plus two wandering resonances that give it a babble
    const src = loop(white);
    this.rush = gain(0);
    const rushBand = filter('bandpass', 950, 0.7);
    src.connect(rushBand); rushBand.connect(this.rush); this.rush.connect(master);
    this.babble = gain(0);
    const b1 = filter('bandpass', 1500, 5), b2 = filter('bandpass', 2600, 7);
    wobble(b1.frequency, 2.3, 420); wobble(b1.frequency, 0.37, 300);
    wobble(b2.frequency, 3.7, 700); wobble(b2.frequency, 0.61, 500);
    src.connect(b1); src.connect(b2);
    b1.connect(this.babble); b2.connect(this.babble); this.babble.connect(master);

    // sea: slow swell
    const seaSrc = loop(brown);
    const seaLow = filter('lowpass', 520, 0.3);
    const sea = gain(0.05);
    wobble(sea.gain, 0.18, 0.035);
    wobble(seaLow.frequency, 0.18, 180);
    seaSrc.connect(seaLow); seaLow.connect(sea); sea.connect(master);

    // scrape: bright hiss
    const scrSrc = loop(white);
    scrSrc.playbackRate.value = 0.8;
    const scrHigh = filter('highpass', 2200, 0.5), scrBand = filter('bandpass', 4200, 0.9);
    this.scrape = gain(0);
    scrSrc.connect(scrHigh); scrHigh.connect(scrBand); scrBand.connect(this.scrape); this.scrape.connect(master);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return;
    if (on) this.ctx.resume().catch(() => {});
    else this.ctx.suspend().catch(() => {});
  }

  suspend() { if (this.ctx) this.ctx.suspend().catch(() => {}); }
  resume() { if (this.ctx && this.enabled) this.ctx.resume().catch(() => {}); }

  /** energy: sum of speed^2 over wet cells; slide: sand volume that slid this step; splash: 0..1 */
  setFlow(energy, slide, splash) {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    const level = Math.min(1, Math.sqrt(energy / 260));
    const target = Math.min(1, level + splash * 0.35);
    this.rush.gain.setTargetAtTime(0.02 + target * 0.11, now, 0.25);
    this.babble.gain.setTargetAtTime(target * 0.10, now, 0.18);
  }

  /** 0..1: how hard the sand is being worked */
  setScrape(v) {
    if (!this.ctx || !this.enabled) return;
    this.scrape.gain.setTargetAtTime(v * 0.09, this.ctx.currentTime, v > this._scrape ? 0.03 : 0.09);
    this._scrape = v;
  }
}
