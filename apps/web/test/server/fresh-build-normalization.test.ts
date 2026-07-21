import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureFreshClipClasses,
  ensureFreshGsapTargets,
  normalizeFreshFontFallbacks,
  normalizeFreshCompositionRoots,
  normalizeFreshClipTracks,
  normalizeFreshGsapLifecycle,
  normalizeReadablePointerEvents,
  repairFreshGsapTransformConflicts,
  scopeFreshGsapSelectors,
} from "../../src/server/job-manager";
import { SequenceArtifactV1Schema } from "../../src/shared";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fresh build normalization", () => {
  it("adds class=clip to elements carrying the full timed-clip signature", async () => {
    // Specimen from run_ac9bbbea: six correct timed sections, direct children
    // of the authored root, failed lint only on the missing clip marker.
    const root = await projectWithComposition(`
      <div id="meridian-world" data-hf-id="meridian-world-root" data-composition-id="meridian-world"
        data-start="0" data-duration="22" data-width="1920" data-height="1080" data-fps="30">
        <div id="meridian-fill" aria-hidden="true"></div>
        <section id="friction-zone" data-start="0" data-duration="4" data-track-index="2"></section>
        <section id="cta-lockup" class="lockup" data-start="18" data-duration="4" data-track-index="10"></section>
        <div data-composition-id="meridian-detail" data-composition-src="compositions/detail.html"
          data-start="4" data-duration="6" data-track-index="3"></div>
        <div id="untimed-decor" data-start="2"></div>
      </div>
    `);

    await ensureFreshClipClasses(root);

    const html = await readFile(join(root, "compositions", "film.html"), "utf8");
    expect(html).toContain('<section class="clip" id="friction-zone"');
    expect(html).toContain('class="clip lockup"');
    expect(html).toMatch(/class="clip"[^>]*data-composition-src="compositions\/detail\.html"/);
    // The composition root declares its own timing and is never a clip.
    expect(html).not.toMatch(/id="meridian-world"[^>]*class=/);
    // Elements without the full signature are untouched.
    expect(html).toContain('<div id="untimed-decor" data-start="2"></div>');

    // Idempotent: a second pass changes nothing.
    await ensureFreshClipClasses(root);
    expect(await readFile(join(root, "compositions", "film.html"), "utf8")).toBe(html);
  });

  it("moves overlapping clips to free tracks while preserving sequential reuse", async () => {
    const root = await projectWithComposition(`
      <main id="film" data-composition-id="film" data-start="0" data-duration="12">
        <div id="ground" class="clip" data-start="0" data-duration="12" data-track-index="0"></div>
        <div id="grid" class="clip" data-start="0" data-duration="12" data-track-index="0"></div>
        <div id="product" class="clip" data-start="0" data-duration="12" data-track-index="1"></div>
        <div id="outro" class="clip" data-start="12" data-duration="2" data-track-index="0"></div>
      </main>
    `);

    await normalizeFreshClipTracks(root);

    const html = await readFile(join(root, "compositions", "film.html"), "utf8");
    expect(html).toMatch(/id="ground"[^>]*data-track-index="0"/);
    expect(html).toMatch(/id="grid"[^>]*data-track-index="1"/);
    expect(html).toMatch(/id="product"[^>]*data-track-index="2"/);
    expect(html).toMatch(/id="outro"[^>]*data-track-index="0"/);

    await normalizeFreshClipTracks(root);
    expect(await readFile(join(root, "compositions", "film.html"), "utf8")).toBe(html);
  });

  it("never invents overlap suppression for decorative or aria-hidden elements", async () => {
    const root = await projectWithComposition(`
      <main id="root"><div class="content"><div id="cursor" aria-hidden="true"></div></div></main>
    `);

    await normalizeFreshCompositionRoots(root);

    const html = await readFile(join(root, "compositions", "film.html"), "utf8");
    expect(html).toContain('data-composition-id="fresh-build-compositions-film-html"');
    expect(html).not.toContain("data-layout-allow-overlap");
    expect(html).not.toContain("data-layout-allow-occlusion");
  });

  it("preserves an authored entry composition whose id is not literally root", async () => {
    const root = await projectWithIndex(`
      <main id="entry-root" data-hf-id="kite-film-root" data-composition-id="kite-film"
        data-start="0" data-duration="12" data-width="1920" data-height="1080" data-fps="30">
        <div data-composition-id="kite-world" data-composition-src="compositions/film.html"></div>
      </main>
    `);

    await normalizeFreshCompositionRoots(root);

    const html = await readFile(join(root, "index.html"), "utf8");
    expect(html).toContain('id="entry-root"');
    expect(html).toContain('data-composition-id="kite-film"');
    expect(html).not.toContain('data-composition-id="fresh-build"');
  });

  it("restores the top-level timeline registry before the runtime script", async () => {
    const root = await projectWithIndex(`
      <main id="root" data-hf-id="ledgerly-film-root" data-composition-id="ledgerly-film"
        data-start="0" data-duration="10" data-width="1920" data-height="1080" data-fps="30">
        <div data-composition-id="ledgerly-world" data-composition-src="compositions/film.html"></div>
      </main>
      <script src="assets/vendor/hyperframe.runtime.iife.js"></script>
    `);

    await normalizeFreshCompositionRoots(root, launchSequence(10));

    const html = await readFile(join(root, "index.html"), "utf8");
    expect(html).toContain("window.__timelines = window.__timelines || {};");
    expect(html).toContain(
      'window.__timelines["ledgerly-film"] = gsap.timeline({ paused: true, defaults: { overwrite: "auto" } });',
    );
    expect(html.indexOf('window.__timelines["ledgerly-film"]')).toBeLessThan(
      html.indexOf("hyperframe.runtime.iife.js"),
    );

    await normalizeFreshCompositionRoots(root, launchSequence(10));
    expect(
      (await readFile(join(root, "index.html"), "utf8")).match(
        /window\.__timelines\["ledgerly-film"\]/g,
      ),
    ).toHaveLength(1);
  });

  it("unwraps the five-second scaffold when Luna nests a real entry composition", async () => {
    const root = await projectWithIndex(`
      <div id="root" data-hf-id="fresh-build-root" data-composition-id="fresh-build"
        data-start="0" data-duration="5" data-width="1920" data-height="1080" data-fps="30">
        <main id="entry-root" data-hf-id="kite-film-root" data-composition-id="kite-film"
          data-start="0" data-duration="12" data-width="1920" data-height="1080" data-fps="30">
          <div data-composition-id="kite-world" data-composition-src="compositions/film.html"></div>
        </main>
        <script>window.__timelines["kite-film"] = gsap.timeline({ paused: true });</script>
      </div>
    `);

    await normalizeFreshCompositionRoots(root, launchSequence(12));

    const html = await readFile(join(root, "index.html"), "utf8");
    expect(html).not.toContain('data-hf-id="fresh-build-root"');
    expect(html).not.toContain('data-duration="5"');
    expect(html).toContain('id="entry-root"');
    expect(html).toContain('data-composition-id="kite-film"');
    expect(html).toContain('data-duration="12"');
    expect(html).toContain('window.__timelines["kite-film"]');
  });

  it("unwraps and retimes the technical subcomposition scaffold", async () => {
    const root = await projectWithComposition(`
      <div id="root" data-hf-id="fresh-build-subcomposition"
        data-composition-id="fresh-build-subcomposition" data-start="0" data-duration="5"
        data-width="1920" data-height="1080" data-fps="30">
        <main id="product-world" data-hf-id="patch-world-root" data-composition-id="patch-world"
          data-start="0" data-duration="12" data-width="1920" data-height="1080" data-fps="30">
          Product
        </main>
        <script>window.__timelines["patch-world"] = gsap.timeline({ paused: true });</script>
      </div>
    `);

    await normalizeFreshCompositionRoots(root, launchSequence(12));

    const html = await readFile(join(root, "compositions", "film.html"), "utf8");
    expect(html).not.toContain('data-composition-id="fresh-build-subcomposition"');
    expect(html).not.toContain('data-duration="5"');
    expect(html).toContain('data-composition-id="patch-world"');
    expect(html).toContain('data-duration="12"');
  });

  it("scopes class and pseudo selectors for any registered timeline variable", async () => {
    const root = await projectWithComposition(`
      <main id="root" data-composition-id="pulse-film"></main>
      <script>
        const pulseTimeline = gsap.timeline({ paused: true });
        pulseTimeline.fromTo(".pulse-row", { opacity: 0 }, { opacity: 1 });
        pulseTimeline.to(".pulse-chart-dot:not(.after)", { opacity: 0 });
        pulseTimeline.to(".title, .subtitle, #unique-target, .item:not(.after,.before)", { opacity: 1 });
        pulseTimeline.to("#unique-target", { opacity: 1 });
        window.__timelines["pulse-film"] = pulseTimeline;
      </script>
    `);

    await scopeFreshGsapSelectors(root);

    const html = await readFile(join(root, "compositions", "film.html"), "utf8");
    expect(html).toContain(`pulseTimeline.fromTo("[data-composition-id='pulse-film'] .pulse-row"`);
    expect(html).toContain(
      `pulseTimeline.to("[data-composition-id='pulse-film'] .pulse-chart-dot:not(.after)"`,
    );
    expect(html).toContain(
      `pulseTimeline.to("[data-composition-id='pulse-film'] .title, [data-composition-id='pulse-film'] .subtitle, #unique-target, [data-composition-id='pulse-film'] .item:not(.after,.before)"`,
    );
    expect(html).toContain('pulseTimeline.to("#unique-target"');
  });

  it("removes renderer-dependent named system fallbacks while preserving bundled faces", async () => {
    const root = await projectWithIndex(`
      <style>body { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }</style>
      <main id="root"></main>
    `);

    await normalizeFreshFontFallbacks(root);

    const html = await readFile(join(root, "index.html"), "utf8");
    expect(html).toContain('font-family: "IBM Plex Mono", monospace');
    expect(html).not.toContain("SFMono-Regular");
    expect(html).not.toContain("Menlo");
    expect(html).not.toContain("ui-monospace");
  });

  it("normalizes split composition timeline and stylesheet files", async () => {
    const root = await projectWithComposition('<main id="root"></main>');
    await writeFile(
      join(root, "compositions", "timeline.js"),
      [
        "const filmTimeline = gsap.timeline({ paused: true });",
        'filmTimeline.to(".row, .dot", { opacity: 1 });',
        'window.__timelines["film"] = filmTimeline;',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(root, "compositions", "style.css"),
      '.row { font-family: "IBM Plex Mono", Consolas, monospace; }',
      "utf8",
    );

    await scopeFreshGsapSelectors(root);
    await normalizeFreshFontFallbacks(root);

    const script = await readFile(join(root, "compositions", "timeline.js"), "utf8");
    const stylesheet = await readFile(join(root, "compositions", "style.css"), "utf8");
    expect(script).toContain(
      `filmTimeline.to("[data-composition-id='film'] .row, [data-composition-id='film'] .dot"`,
    );
    expect(stylesheet).toContain('font-family: "IBM Plex Mono", monospace');
    expect(stylesheet).not.toContain("Consolas");
  });

  it("repairs unique class and semantic identities targeted by any timeline variable", async () => {
    const root = await projectWithIndex(`
      <main id="root" data-composition-id="film">
        <div class="world-label">Patch</div>
        <div data-hf-id="diff-panel">Diff</div>
        <div class="approval-panel" id="approval-control">Approve</div>
      </main>
      <script>
        const masterTimeline = gsap.timeline({ paused: true });
        masterTimeline.fromTo("#world-label", { opacity: 0 }, { opacity: 1 });
        masterTimeline.to("#diff-panel", { opacity: 1 });
        masterTimeline.to("#approval-panel", { opacity: 1 });
        window.__timelines["film"] = masterTimeline;
      </script>
    `);

    await ensureFreshGsapTargets(root);

    const html = await readFile(join(root, "index.html"), "utf8");
    expect(html).toContain('class="world-label" id="world-label"');
    expect(html).toContain('data-hf-id="diff-panel" id="diff-panel"');
    expect(html).toContain('class="approval-panel" id="approval-control"');
    expect(html).not.toContain('id="approval-control" id="approval-panel"');
    expect(html).toContain('masterTimeline.to("#approval-control"');
  });

  it("normalizes persistent UI lifecycle without replaying a visible entrance", async () => {
    const root = await projectWithIndex(`
      <main id="root" data-composition-id="film">
        <div id="product-surface">Product</div>
        <div id="state-layer">State</div>
      </main>
      <script>
        const productTimeline = gsap.timeline({ paused: true });
        const emptyTimeline = gsap.timeline();
        productTimeline.fromTo("#product-surface", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.5, immediateRender: false }, 0.2);
        productTimeline.fromTo("#state-layer", { opacity: 0 }, { opacity: 1, duration: 0.3, immediateRender: false }, 1.0);
        productTimeline.fromTo("#product-surface", { opacity: 1, y: 0 }, { opacity: 0.8, y: -12, duration: 0.4, immediateRender: false }, 5.0);
        window.__timelines["film"] = productTimeline;
      </script>
    `);

    await normalizeFreshGsapLifecycle(root);

    const html = await readFile(join(root, "index.html"), "utf8");
    expect(html).toContain('gsap.timeline({ paused: true, defaults: { overwrite: "auto" } })');
    expect(html).toContain('gsap.timeline({ defaults: { overwrite: "auto" } })');
    expect(html).toContain(
      'productTimeline.fromTo("#product-surface", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.5',
    );
    expect(html).toContain(
      'productTimeline.to("#product-surface", { opacity: 0.8, y: -12, duration: 0.4',
    );
    expect(html).not.toContain("immediateRender: false");
  });

  it("lands first-beat persistent component roots at time zero", async () => {
    const root = await projectWithIndex(`
      <main id="root" data-composition-id="film">
        <section id="product-surface">Product</section>
        <section id="later-surface">Later</section>
        <div id="subordinate-detail">Detail</div>
      </main>
      <script>
        const productTimeline = gsap.timeline({ paused: true });
        productTimeline.fromTo("#product-surface", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.55, ease: "power3.out" }, 0.05);
        productTimeline.fromTo("#later-surface", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 4.0);
        productTimeline.fromTo("#subordinate-detail", { opacity: 0 }, { opacity: 1, duration: 0.3 }, 0.2);
        window.__timelines["film"] = productTimeline;
      </script>
    `);
    const sequence = launchSequence(8);
    sequence.beats[0]!.entities = [
      { id: "product-surface", role: "Persistent opening product", parts: [] },
    ];
    await mkdir(join(root, "story"), { recursive: true });
    await writeFile(join(root, "sequence.json"), `${JSON.stringify(sequence)}\n`, "utf8");
    await writeFile(
      join(root, "story", "component-plan.json"),
      `${JSON.stringify({
        components: [
          {
            continuity: "persistent",
            rootHfId: "product-surface",
            usedInBeatIds: ["test-beat"],
          },
          {
            continuity: "persistent",
            rootHfId: "later-surface",
            usedInBeatIds: ["later-beat"],
          },
        ],
      })}\n`,
      "utf8",
    );

    await normalizeFreshGsapLifecycle(root);

    const html = await readFile(join(root, "index.html"), "utf8");
    expect(html).toContain('productTimeline.set("#product-surface", { opacity: 1, y: 0 }, 0);');
    expect(html).not.toContain('fromTo("#product-surface"');
    expect(html).toContain('fromTo("#later-surface"');
    expect(html).toContain('fromTo("#subordinate-detail"');

    await normalizeFreshGsapLifecycle(root);
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(html);
  });

  it("owns future visibility reveals without rewriting initialization or hides", async () => {
    const root = await projectWithIndex(`
      <main id="root" data-composition-id="film">
        <div id="initial-state">Initial</div>
        <div id="future-state">Future</div>
        <div id="retired-state">Retired</div>
      </main>
      <script>
        const productTimeline = gsap.timeline({ paused: true });
        productTimeline.set("#initial-state", { display: "block", autoAlpha: 1 }, 0);
        productTimeline.set("#future-state", { display: "block", autoAlpha: 1 }, 7.82);
        productTimeline.set("#retired-state", { display: "none", autoAlpha: 0 }, 8.5);
        window.__timelines["film"] = productTimeline;
      </script>
    `);

    await normalizeFreshGsapLifecycle(root);

    const normalized = await readFile(join(root, "index.html"), "utf8");
    expect(normalized).toContain(
      'productTimeline.fromTo("#future-state", { display: "none", autoAlpha: 0 }, { display: "block", autoAlpha: 1, duration: 0.001, ease: "none" }, 7.82)',
    );
    expect(normalized).toContain(
      'productTimeline.set("#initial-state", { display: "block", autoAlpha: 1 }, 0)',
    );
    expect(normalized).toContain(
      'productTimeline.set("#retired-state", { display: "none", autoAlpha: 0 }, 8.5)',
    );

    await normalizeFreshGsapLifecycle(root);
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(normalized);
  });

  it("moves an initial CSS scale into the first matching GSAP tween", async () => {
    const root = await projectWithComposition(`
      <style>#progress-fill{display:block;width:100%;height:100%;transform-origin:left center;transform:scaleX(0)}</style>
      <main id="root" data-composition-id="film"><div id="progress-fill"></div></main>
      <script>
        const productTimeline=gsap.timeline({paused:true})
          .to("#progress-fill",{scaleX:.5,duration:.8,ease:"power2.out"},4.15)
          .to("#progress-fill",{scaleX:1,duration:.8,ease:"power2.out"},5.15);
        window.__timelines["film"]=productTimeline;
      </script>
    `);

    await repairFreshGsapTransformConflicts(root);

    const normalized = await readFile(join(root, "compositions", "film.html"), "utf8");
    expect(normalized).not.toContain("transform:scaleX(0)");
    expect(normalized).toContain(
      '.fromTo("#progress-fill", { scaleX: 0 }, {scaleX:.5,duration:.8,ease:"power2.out"},4.15)',
    );
    expect(normalized).toContain(
      '.to("#progress-fill",{scaleX:1,duration:.8,ease:"power2.out"},5.15)',
    );

    await repairFreshGsapTransformConflicts(root);
    expect(await readFile(join(root, "compositions", "film.html"), "utf8")).toBe(normalized);
  });

  it("keeps readable UI containers in the browser hit-test stack", async () => {
    const root = await projectWithIndex(`
      <style>
        #dashboard { pointer-events: none; }
        .state-layer { position: absolute; pointer-events: none; }
        .ambient-glow { pointer-events: none; }
      </style>
      <main id="root" data-composition-id="film">
        <section id="dashboard"><h1>Release health</h1></section>
        <section class="state-layer"><p>All systems ready</p></section>
        <div class="ambient-glow"></div>
      </main>
    `);

    await normalizeReadablePointerEvents(root);

    const html = await readFile(join(root, "index.html"), "utf8");
    expect(html).toMatch(/#dashboard\s*\{\s*pointer-events:\s*auto/);
    expect(html).toMatch(/\.state-layer\s*\{[^}]*pointer-events:\s*auto/);
    expect(html).toMatch(/\.ambient-glow\s*\{\s*pointer-events:\s*none/);
  });
});

function launchSequence(duration: number) {
  return SequenceArtifactV1Schema.parse({
    version: "sequences.sequence.v1",
    format: { width: 1920, height: 1080, fps: 30, targetDuration: duration },
    concept: {
      summary: "Test launch",
      hierarchy: ["test-beat"],
      motionGrammar: ["deterministic"],
      rejectedChoices: [],
    },
    beats: [
      {
        id: "test-beat",
        role: "hook",
        start: 0,
        duration,
        purpose: "Exercise entry timing",
        claims: [],
        entities: [],
        sourceIds: [],
        musicAnchors: [],
        proofTimes: [0],
        implementationFiles: ["index.html"],
      },
    ],
    transitions: [],
    overlapIntents: [],
    revision: null,
  });
}

async function projectWithComposition(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sequences-fresh-normalization-"));
  roots.push(root);
  await mkdir(join(root, "compositions"), { recursive: true });
  await writeFile(join(root, "index.html"), '<main id="root"></main>', "utf8");
  await writeFile(join(root, "compositions", "film.html"), source, "utf8");
  return root;
}

async function projectWithIndex(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sequences-fresh-entry-"));
  roots.push(root);
  await mkdir(join(root, "compositions"), { recursive: true });
  await writeFile(join(root, "index.html"), source, "utf8");
  await writeFile(join(root, "compositions", "film.html"), '<main id="root"></main>', "utf8");
  return root;
}
