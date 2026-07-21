import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer, { type Page } from "puppeteer";
import { z } from "zod";
import { JobResponseV1Schema, RunReceiptV1Schema } from "../apps/web/src/shared";
import { parseGenerateArguments, websiteProbeProtocolTimeoutMs } from "./generate";

const root = resolve(import.meta.dir, "..");
const descriptorPath = resolve(root, "data", "local-server.json");
const checkUiOnly = process.argv.includes("--check-ui");
const requested = parseGenerateArguments(
  process.argv.slice(2).filter((argument) => argument !== "--check-ui"),
);

if (!checkUiOnly && !requested.prompt) throw new Error("A non-empty video prompt is required");
if (requested.renderQuality) {
  throw new Error(
    "The website Generate action does not render an MP4. Use the website's Render MP4 button as a separate probe.",
  );
}

const descriptor = z
  .object({
    version: z.literal("sequences.local-server.v1"),
    origin: z.string().url(),
    bootToken: z.string().min(32).max(256),
  })
  .parse(JSON.parse(await readFile(descriptorPath, "utf8")) as unknown);
const origin = descriptor.origin.replace(/\/$/, "");
const health = await fetch(`${origin}/api/v1/health`);
if (!health.ok) throw new Error(`The website at ${origin} is not healthy`);

const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: websiteProbeProtocolTimeoutMs(requested.timeoutMinutes),
});
let page: Page | null = null;
let activeJobId: string | null = null;

const cancelFromWebsite = async (): Promise<void> => {
  if (!page || !activeJobId) return;
  try {
    const stop = await page.$("button.button--quiet-danger");
    if (stop) await stop.click();
  } catch {
    // The website may already have reached a terminal state.
  }
};

const interrupt = (): void => {
  void cancelFromWebsite().finally(() => browser.close());
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  page = await browser.newPage();
  page.on("console", (message) =>
    console.error(`browser ${message.type()} · ${message.text().slice(0, 2_000)}`),
  );
  page.on("pageerror", (error) => console.error(`browser pageerror · ${String(error)}`));
  page.on("requestfailed", (request) =>
    console.error(
      `browser request failed · ${request.method()} ${new URL(request.url()).pathname} · ${request.failure()?.errorText ?? "unknown"}`,
    ),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) {
      console.error(
        `browser response · ${String(response.status())} ${response.request().method()} ${new URL(response.url()).pathname}`,
      );
    }
  });
  page.on("request", (request) => {
    if (request.method() === "POST") {
      console.error(`browser request · POST ${new URL(request.url()).pathname}`);
    }
  });
  await page.goto(`${origin}/?boot=${encodeURIComponent(descriptor.bootToken)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForSelector("#video-prompt", { visible: true });

  probe: {
    if (checkUiOnly) {
      const promptControls = await page.$$("#video-prompt");
      const generateButtons = await page.$$('button[type="submit"]');
      if (promptControls.length !== 1 || generateButtons.length !== 1) {
        throw new Error("The website Prompt and Generate controls are not unique");
      }
      const viewerEvidence = await verifyLatestViewer(page, "website-viewer-check");
      console.log(
        JSON.stringify(
          {
            version: "sequences.website-ui-check.v1",
            promptControls: promptControls.length,
            generateButtons: generateButtons.length,
            generateLabel: await generateButtons[0]!.evaluate((element) =>
              element.textContent?.trim(),
            ),
            ...viewerEvidence,
            origin: new URL(page.url()).origin,
            submitted: false,
          },
          null,
          2,
        ),
      );
      break probe;
    }

    if (requested.imageFiles.length > 0) {
      const input = await page.$('input[type="file"]');
      if (!input) throw new Error("The website image attachment input is missing");
      await input.uploadFile(...requested.imageFiles.map((path) => resolve(path)));
      await page.waitForFunction(
        (expectedCount) =>
          document.querySelectorAll(".image-attachment").length === expectedCount &&
          !document.querySelector(".image-attachment--uploading"),
        { timeout: 120_000 },
        requested.imageFiles.length,
      );
      if (await page.$(".image-attachment--error")) {
        throw new Error("The website rejected at least one image attachment");
      }
    }

    await page.type("#video-prompt", requested.prompt);
    const generate = await page.$('button[type="submit"]');
    if (!generate) throw new Error("The website Generate button is missing");
    if (!(await generate.evaluate((element) => !(element as HTMLButtonElement).disabled))) {
      throw new Error("The website Generate button is disabled");
    }

    const startedResponse = page.waitForResponse(
      (response) => {
        const request = response.request();
        return (
          request.method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/projects/release-a/jobs"
        );
      },
      { timeout: 30_000 },
    );
    await generate.evaluate((element) => (element as HTMLButtonElement).click());
    await Bun.sleep(250);
    const submitState = await page.evaluate(() => ({
      status: document.querySelector(".header-status")?.textContent?.trim() ?? null,
      button: document.querySelector('button[type="submit"]')?.textContent?.trim() ?? null,
      error: document.querySelector(".notice--error")?.textContent?.trim() ?? null,
    }));
    console.error(`website submit state · ${JSON.stringify(submitState)}`);
    const startedHttp = await startedResponse;
    if (startedHttp.status() !== 202) {
      throw new Error(
        `Website Generate returned HTTP ${startedHttp.status()}: ${(await startedHttp.text()).slice(0, 2_000)}`,
      );
    }
    const started = JobResponseV1Schema.parse(await startedHttp.json());
    activeJobId = started.receipt.jobId;
    console.error(`website queued · ${activeJobId}`);

    const timeoutMs = requested.timeoutMinutes * 60_000;
    try {
      await page.waitForFunction(
        (jobId) => {
          const card = document.querySelector<HTMLElement>(`.job-card[data-job-id="${jobId}"]`);
          return ["success", "failure"].includes(card?.dataset.jobOutcome ?? "");
        },
        { polling: 1_000, timeout: timeoutMs },
        activeJobId,
      );
    } catch (error) {
      await cancelFromWebsite();
      throw new Error(
        `Website generation did not reach a terminal UI state within ${String(requested.timeoutMinutes)} minutes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const uiTerminal = await page.evaluate((jobId) => {
      const card = document.querySelector<HTMLElement>(`.job-card[data-job-id="${jobId}"]`);
      return {
        jobId: card?.dataset.jobId ?? null,
        outcome: card?.dataset.jobOutcome ?? null,
        status: card?.querySelector(".state-pill")?.textContent?.trim() ?? null,
        result: card?.textContent?.replace(/\s+/g, " ").trim().slice(0, 2_000) ?? null,
        pageError: document.querySelector(".notice--error")?.textContent?.trim() ?? null,
      };
    }, activeJobId);
    console.error(`website terminal state · ${JSON.stringify(uiTerminal)}`);
    const current = await readPersistedReceipt(activeJobId);
    activeJobId = null;

    if (
      (uiTerminal.outcome === "success" && current.state !== "applied") ||
      (uiTerminal.outcome === "failure" && current.state === "applied")
    ) {
      throw new Error(
        `Website showed ${uiTerminal.outcome ?? "no terminal outcome"}, but the persisted run ended in ${current.state}\nRun receipt: data/runs/release-a/${current.jobId}/receipt.json`,
      );
    }
    if (uiTerminal.outcome !== "success" || current.state !== "applied") {
      throw new Error(
        `${current.error?.message ?? uiTerminal.result ?? `Website generation ended in ${current.state}`}\nRun receipt: data/runs/release-a/${current.jobId}/receipt.json`,
      );
    }
    await page.waitForFunction(
      () => document.body.textContent?.includes("Generated video is now on the timeline.") === true,
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      () => document.querySelector(".viewer__state")?.textContent?.trim() === "ready",
      { timeout: 60_000 },
    );
    const viewerEvidence = await verifyLatestViewer(page, `website-viewer-${current.jobId}`);

    console.log(
      JSON.stringify(
        {
          version: "sequences.website-ui-probe.v1",
          jobId: current.jobId,
          state: current.state,
          runReceiptPath: `data/runs/release-a/${current.jobId}/receipt.json`,
          candidateUrl: new URL(started.candidateUrl, origin).toString(),
          qa: current.qa?.summary ?? null,
          ...viewerEvidence,
        },
        null,
        2,
      ),
    );
  }
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await browser.close();
}

async function readPersistedReceipt(jobId: string) {
  return RunReceiptV1Schema.parse(
    JSON.parse(
      await readFile(resolve(root, "data", "runs", "release-a", jobId, "receipt.json"), "utf8"),
    ) as unknown,
  );
}

async function verifyLatestViewer(page: Page, screenshotStem: string) {
  const latestButton = await page.$(".viewer-source button:last-child");
  if (!latestButton) throw new Error("The website Latest viewer control is missing");
  await latestButton.click();
  await page.waitForFunction(
    () => document.querySelector(".viewer__state")?.textContent?.trim() === "ready",
    { timeout: 30_000 },
  );
  const compositionFrame = page
    .frames()
    .find((frame) => new URL(frame.url()).pathname.includes("/accepted/index.html"));
  if (!compositionFrame) throw new Error("The Latest composition iframe did not load");

  const viewer = await compositionFrame.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-composition-id]");
    const mounted = document.querySelector<HTMLElement>('[data-hf-inner-root="true"]');
    const mountedHost = mounted?.closest<HTMLElement>("[data-composition-id]") ?? null;
    const rootStyle = root ? getComputedStyle(root) : null;
    const mountedStyle = mounted ? getComputedStyle(mounted) : null;
    const timelines = (window as Window & { __timelines?: Record<string, unknown> }).__timelines;
    const mountedCompositionId = mountedHost?.dataset.compositionId ?? null;
    return {
      url: location.href,
      styleElements: document.querySelectorAll("style").length,
      styleSheets: document.styleSheets.length,
      injectedStylePresent: Array.from(document.querySelectorAll("style")).some((style) =>
        style.textContent?.includes("data-hf-authored-id"),
      ),
      mountedCompositionId,
      mountedTimelineRegistered: Boolean(
        mountedCompositionId && timelines && mountedCompositionId in timelines,
      ),
      root: root
        ? {
            id: root.id,
            width: rootStyle?.width ?? null,
            height: rootStyle?.height ?? null,
            position: rootStyle?.position ?? null,
          }
        : null,
      mounted: mounted
        ? {
            width: mountedStyle?.width ?? null,
            height: mountedStyle?.height ?? null,
            position: mountedStyle?.position ?? null,
            fontFamily: mountedStyle?.fontFamily ?? null,
          }
        : null,
    };
  });
  if (
    !viewer.injectedStylePresent ||
    !viewer.mounted ||
    viewer.mounted.position === "static" ||
    /Times New Roman/i.test(viewer.mounted.fontFamily ?? "") ||
    !viewer.mountedTimelineRegistered
  ) {
    throw new Error(`Latest composition failed website playback parity: ${JSON.stringify(viewer)}`);
  }
  if (new URL(viewer.url).origin !== new URL(page.url()).origin) {
    throw new Error(`Latest composition left the IPv4 website origin: ${viewer.url}`);
  }

  const viewerScreenshot = resolve(root, "artifacts", `${screenshotStem}.png`);
  await page.screenshot({ path: viewerScreenshot });
  const seekTime = await page.evaluate(() => {
    const player = document.querySelector("hyperframes-player") as HTMLElement & {
      duration?: number;
      seek?: (time: number) => void;
    };
    if (typeof player?.seek !== "function") throw new Error("The Latest player cannot seek");
    const duration = typeof player.duration === "number" ? player.duration : 20;
    const time = Math.max(0.5, Math.min(5, duration * 0.35));
    player.seek(time);
    return time;
  });
  await compositionFrame.waitForFunction(
    (compositionId) => {
      const timelines = (
        window as Window & {
          __timelines?: Record<string, { time?: () => number }>;
        }
      ).__timelines;
      const time = compositionId ? timelines?.[compositionId]?.time?.() : null;
      return typeof time === "number" && time > 0;
    },
    { timeout: 5_000 },
    viewer.mountedCompositionId,
  );
  const motion = await compositionFrame.evaluate(
    (compositionId, expectedSeekTime) => {
      const timelines = (
        window as Window & {
          __timelines?: Record<string, { time?: () => number; progress?: () => number }>;
        }
      ).__timelines;
      const timeline = compositionId ? timelines?.[compositionId] : null;
      return {
        seekTime: expectedSeekTime,
        timelineTime: timeline?.time?.() ?? null,
        timelineProgress: timeline?.progress?.() ?? null,
      };
    },
    viewer.mountedCompositionId,
    seekTime,
  );
  const motionScreenshot = resolve(root, "artifacts", `${screenshotStem}-motion.png`);
  await page.screenshot({ path: motionScreenshot });

  return { viewer, viewerScreenshot, motion, motionScreenshot };
}
