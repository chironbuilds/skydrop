// Renders scene.html frame by frame in headless Chrome, pipes the frames into ffmpeg and muxes the soundtrack.
//   node build.mjs                 full render -> skydrop-explainer.mp4
//   node build.mjs --still 3.5     one frame at t=3.5s -> still.png (to check a scene)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";
import { makeAudio } from "./audio.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const CHROME = [
  process.env.CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("Set CHROME to a Chrome or Chromium executable");

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1"] });
const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, "scene.html")).href, { waitUntil: "networkidle0" });
await page.evaluate(() => window.ready);
const { total, cuts } = await page.evaluate(() => ({ total: window.TOTAL, cuts: window.CUTS }));

const stillIdx = process.argv.indexOf("--still");
if (stillIdx > 0) {
  const t = Number(process.argv[stillIdx + 1]);
  await page.evaluate((x) => window.render(x), t);
  await page.screenshot({ path: join(here, "still.png"), type: "png" });
  console.log("wrote still.png at", t);
  await browser.close();
  process.exit(0);
}

const slams = [1.1, 8.6, 17.2, 19.95, 28.1];
const wav = join(here, "audio.wav");
makeAudio(wav, total, cuts, slams);
console.log("audio ready");

const out = join(here, "skydrop-explainer.mp4");
const ff = spawn(ffmpegPath, [
  "-y", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
  "-i", wav,
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS),
  "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
  out,
], { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((res, rej) => { ff.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg exited " + c)))); });

const frames = Math.round(total * FPS);
for (let i = 0; i < frames; i++) {
  await page.evaluate((t) => window.render(t), i / FPS);
  const jpg = await page.screenshot({ type: "jpeg", quality: 93 });
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 60 === 0) console.log(`frame ${i}/${frames}`);
}
ff.stdin.end();
await done;
await browser.close();
console.log("wrote", out);
