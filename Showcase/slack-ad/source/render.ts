import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));
const APP = path.resolve(HERE, "index.html");
const PACKAGE_ROOT = path.resolve(HERE, "..");
if (path.basename(PACKAGE_ROOT) !== "slack-ad")
  throw new Error(`refusing unsafe package root: ${PACKAGE_ROOT}`);
const RENDERS = path.join(PACKAGE_ROOT, "renders");
const EVIDENCE = path.join(PACKAGE_ROOT, "evidence");
const SNAPSHOTS = path.join(EVIDENCE, "snapshots");
const REFINEMENT = path.join(EVIDENCE, "refinement");
const QA = path.join(EVIDENCE, "qa");
const FRAME_DIR = path.join(EVIDENCE, "render-frames");
const QA_REPORT = path.join(QA, "report.json");
const fullRender = process.argv.includes("--render");
const resume = process.argv.includes("--resume");
const FPS = 30;
const DURATION = 28;
const representative = [
  0.45, 1.35, 2.35, 3.7, 5.72, 6.45, 7.85, 9.25, 10.2, 11.15, 12.35, 13.72, 14.45, 15.3, 17.45,
  18.75, 19.65, 20.7, 21.6, 22.4, 23.55, 24.4, 25.15, 27.1,
];

function findBrowser(): string {
  const candidates = [
    process.env.SEQUENCES_BROWSER_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("Chrome or Edge not found");
  return found;
}

function findFfmpeg(): string {
  const lines = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["ffmpeg"], {
    encoding: "utf8",
  }).split(/\r?\n/);
  const found = lines.map((line) => line.trim()).find(Boolean);
  if (!found) throw new Error("FFmpeg not found");
  return found;
}

function hash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
}

if (!resume) {
  fs.rmSync(SNAPSHOTS, { recursive: true, force: true });
  fs.rmSync(FRAME_DIR, { recursive: true, force: true });
}
fs.mkdirSync(RENDERS, { recursive: true });
fs.mkdirSync(SNAPSHOTS, { recursive: true });
fs.mkdirSync(REFINEMENT, { recursive: true });
fs.mkdirSync(QA, { recursive: true });
if (fullRender) fs.mkdirSync(FRAME_DIR, { recursive: true });

let browser!: import("puppeteer-core").Browser;
let page!: import("puppeteer-core").Page;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchPage() {
  browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ["--hide-scrollbars", "--mute-audio", "--disable-background-timer-throttling"],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(`file:///${APP.replace(/\\/g, "/")}`, { waitUntil: "load", timeout: 20_000 });
  await page.evaluate(() => (document as any).fonts.ready);
}

async function closeBrowser() {
  const process = browser?.process();
  try {
    await Promise.race([browser?.close(), delay(3_000)]);
  } catch {
    /* hard kill below */
  }
  if (process && process.exitCode === null) process.kill("SIGKILL");
}

async function relaunch(reason: string) {
  process.stdout.write(`relaunching browser: ${reason}\n`);
  await closeBrowser();
  await launchPage();
}

await launchPage();

type QaSample = {
  time: number;
  scene: string | null;
  focus: string;
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  safe: boolean;
};
const qa: QaSample[] = [];
function focusFor(t: number): string {
  if (t < 1.05) return ".chat";
  if (t < 1.95) return "#too-tools";
  if (t < 3.2) return "#too-handoffs";
  if (t < 5.45) return "#no-momentum";
  if (t < 7.35) return "#hero-mark";
  if (t < 9.7) return "#messy .typed";
  if (t < 12) return "#channel-modal";
  if (t < 12.6) return "#slack-window";
  if (t < 14.1) return "#message-one p";
  // The superzoom holds until ~17.0; the full row and window exceed the frame
  // by design there, so the focal proof rides the typed reply text itself.
  if (t < 17.75) return "#message-two p";
  if (t < 18.8) return ".decision";
  if (t < 20.4) return ".conversation";
  if (t < 24.15) return t < 21.9 ? "#all-place" : "#all-slack";
  return ".lockup";
}

async function seek(t: number) {
  await page.evaluate((time) => (window as any).__seek(time), t);
  await delay(12);
}

async function capture(t: number, output: string) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await seek(t);
      await Promise.race([
        page.screenshot({ path: output }),
        delay(15_000).then(() => {
          throw new Error(`screenshot timeout at ${t.toFixed(3)}s`);
        }),
      ]);
      if (!fs.existsSync(output) || fs.statSync(output).size < 1_000)
        throw new Error("empty screenshot");
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await relaunch(`capture ${t.toFixed(3)}s attempt ${attempt}: ${String(error)}`);
    }
  }
}

const previousSamples: QaSample[] =
  resume && fs.existsSync(QA_REPORT)
    ? (JSON.parse(fs.readFileSync(QA_REPORT, "utf8")).samples ?? [])
    : [];

for (let index = 0; index < representative.length; index += 1) {
  const time = representative[index]!;
  const repPath = path.join(SNAPSHOTS, `frame-${String(index).padStart(2, "0")}.png`);
  const previous = previousSamples.find((sample) => sample.time === time);
  if (resume && previous && fs.existsSync(repPath) && fs.statSync(repPath).size >= 1_000) {
    qa.push(previous);
    continue;
  }
  await capture(time, repPath);
  await seek(time);
  const selector = focusFor(time);
  const evidence = await page.evaluate((focus) => {
    const visible = [...document.querySelectorAll<HTMLElement>(".scene")].find(
      (el) =>
        getComputedStyle(el).visibility !== "hidden" && Number(getComputedStyle(el).opacity) > 0.1,
    );
    const el = document.querySelector<HTMLElement>(focus);
    if (!el) throw new Error(`missing focus ${focus}`);
    const r = el.getBoundingClientRect();
    return {
      scene: visible?.dataset.scene ?? null,
      bounds: {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      },
    };
  }, selector);
  const b = evidence.bounds;
  const safe = b.left >= 48 && b.top >= 38 && b.right <= 1872 && b.bottom <= 1042;
  qa.push({ time, scene: evidence.scene, focus: selector, bounds: b, safe });
}

if (fullRender) {
  const totalFrames = DURATION * FPS;
  let newlyCaptured = 0;
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const framePath = path.join(FRAME_DIR, `frame-${String(frame).padStart(5, "0")}.png`);
    if (resume && fs.existsSync(framePath) && fs.statSync(framePath).size >= 1_000) continue;
    if (newlyCaptured > 0 && newlyCaptured % 120 === 0)
      await relaunch(`periodic recycle after ${newlyCaptured} new frames`);
    await capture(frame / FPS, framePath);
    newlyCaptured += 1;
    if (newlyCaptured % 30 === 0)
      process.stdout.write(
        `captured ${newlyCaptured} new; latest frame ${frame}/${totalFrames - 1}\n`,
      );
  }
  const missing = Array.from({ length: totalFrames }, (_, frame) =>
    path.join(FRAME_DIR, `frame-${String(frame).padStart(5, "0")}.png`),
  ).filter((file) => !fs.existsSync(file) || fs.statSync(file).size < 1_000);
  if (missing.length)
    throw new Error(`refusing encode: ${missing.length} missing/empty frames; first ${missing[0]}`);
}
await closeBrowser();

const ffmpeg = findFfmpeg();
const repPattern = path.join(SNAPSHOTS, "frame-%02d.png");
execFileSync(
  ffmpeg,
  [
    "-y",
    "-framerate",
    "1",
    "-i",
    repPattern,
    "-vf",
    "scale=480:270,tile=4x6",
    "-frames:v",
    "1",
    path.join(RENDERS, "contact-sheet.jpg"),
  ],
  { stdio: "ignore" },
);
execFileSync(
  ffmpeg,
  [
    "-y",
    "-framerate",
    "1",
    "-i",
    repPattern,
    "-vf",
    "scale=320:180,tile=8x3",
    "-frames:v",
    "1",
    path.join(REFINEMENT, "temporal-strip.jpg"),
  ],
  { stdio: "ignore" },
);
if (fullRender) {
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-framerate",
      String(FPS),
      "-i",
      path.join(FRAME_DIR, "frame-%05d.png"),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      path.join(RENDERS, "silent.mp4"),
    ],
    { stdio: "inherit" },
  );
}

const hashes = fs
  .readdirSync(SNAPSHOTS)
  .filter((file) => file.endsWith(".png"))
  .map((file) => ({ file, sha256: hash(path.join(SNAPSHOTS, file)) }));
const report = {
  title: "From noise to momentum",
  generatedAt: new Date().toISOString(),
  durationSec: DURATION,
  fps: FPS,
  deterministic: true,
  localOnly: true,
  audio: "none",
  personalInformation: "fictional names and initials only",
  render: fullRender ? "renders/silent.mp4" : null,
  safeFrame: { insetX: 48, insetY: 38, ok: qa.every((sample) => sample.safe) },
  samples: qa,
  representativeHashes: hashes,
};
fs.writeFileSync(QA_REPORT, JSON.stringify(report, null, 2));
fs.writeFileSync(
  path.join(QA, "last-run.txt"),
  `Slack showcase render\nDuration: ${DURATION.toFixed(1)} seconds\nAudio: none\nQA safe frame: ${report.safeFrame.ok ? "PASS" : "REVIEW"}\nSource: source/index.html\n`,
);
console.log(
  JSON.stringify(
    {
      packageRoot: PACKAGE_ROOT,
      mp4: fullRender,
      safeFrame: report.safeFrame.ok,
      unsafe: qa.filter((sample) => !sample.safe),
    },
    null,
    2,
  ),
);
