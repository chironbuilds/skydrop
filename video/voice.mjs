// Narration: one line per scene, spoken by a neural voice (edge-tts, which calls Microsoft's speech service),
// decoded to PCM and lightly polished. Needs Python with `pip install edge-tts` and a network connection the first
// time. The mp3s are cached in voice/ by voice, rate and text, so re-rendering is offline.
//
// Lines are written to fit their scenes at a natural pace. Time-stretching is what makes a voice sound robotic, so a
// line is only ever sped up a little, and a warning is printed when it still doesn't fit: shorten the line instead.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const here = dirname(fileURLToPath(import.meta.url));
const SR = 44100;
const RATE = process.env.VOICE_RATE || "+4%";
const MAX_STRETCH = 1.1;

// start: seconds into the video. max: the longest the line may run.
export const LINES = [
  { start: 0.15, max: 2.2, text: "Send Tari to anyone on Bluesky." },
  { start: 2.55, max: 2.2, text: "Just type their handle." },
  { start: 5.0, max: 1.9, text: "Pick an amount." },
  { start: 7.1, max: 2.2, text: "Hit send. Locked on-chain." },
  { start: 9.45, max: 2.2, text: "A bot lets her know." },
  { start: 11.85, max: 2.6, text: "She posts one line to prove it's her." },
  { start: 14.65, max: 4.0, text: "The contract checks Bluesky's signatures itself. No middleman." },
  { start: 18.85, max: 2.5, text: "Then she collects." },
  { start: 21.75, max: 2.4, text: "No wallet? We make one." },
  { start: 24.35, max: 3.2, text: "Or tip by posting. Your post is the proof." },
  { start: 27.8, max: 5.0, text: "Try it at skydrop dot tari dot M W. Testnet only." },
];

// a little body and consistency: trim rumble, even out the level, warm the presence
// the service pads every clip with up to a second of silence, which is not speech and must not count when fitting
const TRIM = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.04,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse";
const POLISH = TRIM + ",highpass=f=80,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120:makeup=3,equalizer=f=2800:t=q:w=1.2:g=1.5";

function decode(file, tempo) {
  const filters = [];
  if (tempo && tempo > 1.001) filters.push(`atempo=${tempo.toFixed(3)}`);
  filters.push(POLISH);
  const r = spawnSync(ffmpegPath, ["-v", "error", "-i", file, "-af", filters.join(","), "-f", "f32le", "-ar", String(SR), "-ac", "1", "pipe:1"], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error("ffmpeg failed to decode " + file + ": " + r.stderr);
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)).slice();
}

export function loadVoice(voice) {
  const dir = join(here, "voice");
  mkdirSync(dir, { recursive: true });
  return LINES.map((line, i) => {
    const key = createHash("sha1").update(`${voice}|${RATE}|${line.text}`).digest("hex").slice(0, 10);
    const file = join(dir, `${voice}-${i}-${key}.mp3`);
    if (!existsSync(file)) {
      const r = spawnSync("python", ["-m", "edge_tts", "--voice", voice, `--rate=${RATE}`, "--text", line.text, "--write-media", file], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`edge-tts failed for "${line.text}": ${r.stderr || r.stdout}`);
    }
    let samples = decode(file);
    const dur = samples.length / SR;
    if (dur > line.max) {
      const tempo = Math.min(MAX_STRETCH, dur / line.max);
      samples = decode(file, tempo);
      const now = samples.length / SR;
      console.log(`line ${i}: ${dur.toFixed(2)}s, sped up x${tempo.toFixed(2)} to ${now.toFixed(2)}s${now > line.max + 0.05 ? "  <-- still too long, shorten the line" : ""}`);
    } else {
      console.log(`line ${i}: ${dur.toFixed(2)}s (fits ${line.max}s)`);
    }
    return { start: line.start, samples };
  });
}
