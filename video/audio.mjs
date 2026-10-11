// Synthesises the soundtrack: a four-on-the-floor beat, a bass line, a plucky arpeggio, whooshes on every
// cut and a thud on every stamp. Pure maths, no samples, so it can be regenerated and tweaked.
import { writeFileSync } from "node:fs";

const SR = 44100;
const BPM = 128;
const BEAT = 60 / BPM;

export function makeAudio(path, total, cuts, slams, voice = []) {
  const n = Math.floor(total * SR);
  const out = new Float32Array(n);
  let seed = 12345;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const add = (i, v) => { if (i >= 0 && i < n) out[i] += v; };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  const kicks = [];
  const beats = Math.floor(total / BEAT);

  for (let b = 0; b < beats; b++) {
    const t0 = b * BEAT;
    const i0 = Math.floor(t0 * SR);
    // kick
    kicks.push(t0);
    let ph = 0;
    for (let k = 0; k < 0.3 * SR; k++) {
      const t = k / SR;
      const f = 45 + 120 * Math.exp(-t * 28);
      ph += (2 * Math.PI * f) / SR;
      add(i0 + k, Math.sin(ph) * Math.exp(-t * 11) * 0.95);
    }
    // clap on 2 and 4
    if (b % 2 === 1) {
      let prev = 0;
      for (let k = 0; k < 0.16 * SR; k++) {
        const t = k / SR;
        const x = noise();
        const hp = x - prev; prev = x;
        add(i0 + k, hp * Math.exp(-t * 26) * 0.32);
      }
    }
    // off-beat hat
    {
      const io = i0 + Math.floor((BEAT / 2) * SR);
      let prev = 0;
      for (let k = 0; k < 0.05 * SR; k++) {
        const t = k / SR;
        const x = noise();
        const hp = x - prev; prev = x;
        add(io + k, hp * Math.exp(-t * 90) * 0.2);
      }
    }
    // closed hat on the beat, quieter
    {
      let prev = 0;
      for (let k = 0; k < 0.03 * SR; k++) {
        const t = k / SR;
        const x = noise();
        const hp = x - prev; prev = x;
        add(i0 + k, hp * Math.exp(-t * 130) * 0.09);
      }
    }
  }

  const duck = (t) => {
    let last = -1;
    for (let j = Math.floor(t / BEAT); j >= 0 && j >= Math.floor(t / BEAT) - 1; j--) last = j * BEAT;
    return 1 - 0.7 * Math.exp(-(t - last) * 14);
  };

  // chords per bar (A minor, F, G, A minor): root + 3 notes for the arpeggio
  const bars = [
    { bass: 33, notes: [69, 72, 76, 81] },
    { bass: 29, notes: [65, 69, 72, 77] },
    { bass: 31, notes: [67, 71, 74, 79] },
    { bass: 33, notes: [69, 72, 76, 81] },
  ];
  const eighth = BEAT / 2;
  const sixteenth = BEAT / 4;
  const steps = Math.floor(total / sixteenth);
  for (let s = 0; s < steps; s++) {
    const t0 = s * sixteenth;
    const bar = bars[Math.floor(t0 / (BEAT * 4)) % 4];
    // bass on every eighth, a little off the root now and then
    if (s % 2 === 0) {
      const eighthIdx = s / 2;
      const m = bar.bass + ([0, 0, 12, 0, 0, 7, 12, 0][eighthIdx % 8] ?? 0);
      const f = hz(m);
      const i0 = Math.floor(t0 * SR);
      let lp = 0;
      for (let k = 0; k < eighth * SR * 0.9; k++) {
        const t = k / SR;
        const saw = 2 * ((f * t) % 1) - 1;
        lp += (saw - lp) * 0.09;
        add(i0 + k, lp * Math.exp(-t * 5) * 0.55 * duck(t0 + t));
      }
    }
    // arpeggio from 2.4 s on
    if (t0 >= 2.3) {
      const m = bar.notes[[0, 1, 2, 3, 2, 1, 2, 3][s % 8]] + (s % 16 >= 8 ? 12 : 0);
      const f = hz(m);
      const i0 = Math.floor(t0 * SR);
      for (let k = 0; k < sixteenth * SR * 1.8; k++) {
        const t = k / SR;
        const sq = Math.sign(Math.sin(2 * Math.PI * f * t)) * 0.6 + Math.sin(2 * Math.PI * f * 2 * t) * 0.25;
        add(i0 + k, sq * Math.exp(-t * 16) * 0.13 * duck(t0 + t));
      }
    }
  }

  // whooshes: noise swelling into each cut
  for (const c of cuts) {
    const len = 0.5;
    const start = Math.floor((c - len * 0.8) * SR);
    let lp = 0;
    for (let k = 0; k < len * SR; k++) {
      const t = k / SR;
      const env = Math.pow(t / len, 2.2) * Math.exp(-Math.max(0, t - len * 0.8) * 30);
      lp += (noise() - lp) * (0.02 + 0.5 * (t / len));
      add(start + k, lp * env * 0.9);
    }
  }

  // stamp thuds
  for (const s of slams) {
    const i0 = Math.floor(s * SR);
    let ph = 0;
    let prev = 0;
    for (let k = 0; k < 0.4 * SR; k++) {
      const t = k / SR;
      ph += (2 * Math.PI * (38 + 90 * Math.exp(-t * 22))) / SR;
      const x = noise();
      const hp = x - prev; prev = x;
      add(i0 + k, Math.sin(ph) * Math.exp(-t * 9) * 0.9 + hp * Math.exp(-t * 70) * 0.35);
    }
  }

  // narration: duck everything else while someone is talking, then lay the voice on top
  if (voice.length) {
    const active = new Float32Array(n);
    const vox = new Float32Array(n);
    for (const v of voice) {
      const i0 = Math.floor(v.start * SR);
      for (let k = 0; k < v.samples.length; k++) { if (i0 + k < n) { vox[i0 + k] += v.samples[k]; active[i0 + k] = 1; } }
    }
    let g = 0;
    for (let i = 0; i < n; i++) {
      g += (active[i] - g) * (active[i] > g ? 0.002 : 0.00008);
      out[i] = out[i] * (1 - 0.55 * g) + vox[i] * 1.5;
    }
  }

  // master: fade out, soft clip, normalise
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = out[i];
    if (t > total - 0.9) v *= Math.max(0, (total - t) / 0.9);
    if (t < 0.02) v *= t / 0.02;
    v = Math.tanh(v * 1.25);
    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  const g = 0.89 / peak;

  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, out[i] * g));
    const s16 = Math.round(v * 32767);
    buf.writeInt16LE(s16, 44 + i * 4);
    buf.writeInt16LE(s16, 46 + i * 4);
  }
  writeFileSync(path, buf);
}
