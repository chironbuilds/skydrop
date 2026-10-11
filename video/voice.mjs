// Narration: one line per scene, spoken by a neural voice (edge-tts, which calls Microsoft's speech service),
// decoded to PCM and sped up just enough to fit its scene. Needs Python with `pip install edge-tts` and a network
// connection the first time. The mp3s are cached in voice/, so re-rendering the video is offline.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const here = dirname(fileURLToPath(import.meta.url));
const SR = 44100;
const VOICE = process.env.VOICE || "en-US-AvaNeural";
const RATE = process.env.VOICE_RATE || "+14%";

// start: seconds into the video. max: the longest the line may run before it is sped up.
export const LINES = [
  { start: 0.12, max: 2.2, text: "Send Tari to anyone on Bluesky." },
  { start: 2.55, max: 2.2, text: "Type their handle." },
  { start: 5.0, max: 1.8, text: "Pick an amount." },
  { start: 7.05, max: 2.1, text: "Hit send. It's locked on-chain." },
  { start: 9.45, max: 2.1, text: "A bot lets her know." },
  { start: 11.85, max: 2.5, text: "She posts one line to prove it's her." },
  { start: 14.65, max: 3.9, text: "The contract checks Bluesky's own signatures. No oracle. No middleman." },
  { start: 18.85, max: 2.5, text: "Then she collects." },
  { start: 21.75, max: 2.3, text: "No wallet? We make one. Fees covered." },
  { start: 24.35, max: 3.1, text: "Or just tip by posting. The post is the proof." },
  { start: 27.75, max: 3.1, text: "Try it at skydrop dot tari dot M W. Testnet only." },
];

function decode(file, tempo) {
  const args = ["-v", "error", "-i", file];
  if (tempo && tempo > 1.001) args.push("-af", `atempo=${tempo.toFixed(3)}`);
  args.push("-f", "f32le", "-ar", String(SR), "-ac", "1", "pipe:1");
  const r = spawnSync(ffmpegPath, args, { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error("ffmpeg failed to decode " + file + ": " + r.stderr);
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)).slice();
}

export function loadVoice() {
  const dir = join(here, "voice");
  mkdirSync(dir, { recursive: true });
  return LINES.map((line, i) => {
    const file = join(dir, `line${String(i).padStart(2, "0")}.mp3`);
    if (!existsSync(file)) {
      const r = spawnSync("python", ["-m", "edge_tts", "--voice", VOICE, `--rate=${RATE}`, "--text", line.text, "--write-media", file], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`edge-tts failed for "${line.text}": ${r.stderr || r.stdout}`);
    }
    let samples = decode(file);
    const dur = samples.length / SR;
    if (dur > line.max) {
      const tempo = Math.min(1.4, dur / line.max);
      samples = decode(file, tempo);
      console.log(`line ${i}: ${dur.toFixed(2)}s sped up x${tempo.toFixed(2)} to ${(samples.length / SR).toFixed(2)}s`);
    } else {
      console.log(`line ${i}: ${dur.toFixed(2)}s`);
    }
    return { start: line.start, samples };
  });
}
