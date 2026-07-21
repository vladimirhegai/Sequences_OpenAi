import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeFreshCompositionSelfSelectors } from "../../src/server/job-manager";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const HOST_INDEX =
  '<div id="host" data-hf-id="fresh-build" data-composition-id="fresh-build" data-start="0" data-duration="22" data-width="1920" data-height="1080" data-fps="30"></div>';

async function candidate(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sequences-self-selector-"));
  roots.push(root);
  // Every fresh candidate carries index.html (the host composition); the
  // normalizer discovers compositions relative to it, so fixtures include one.
  const withIndex = { "index.html": HOST_INDEX, ...files };
  for (const [relativePath, content] of Object.entries(withIndex)) {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}

describe("composition self-selector normalization", () => {
  it("rewrites a sub-composition's own attribute self-selectors to its root #id", async () => {
    // Specimen class from run_38eb9d57 (Forma): the director scoped 152 style
    // rules with the composition's own [data-composition-id] attribute, which
    // strict lint blocks as composition_self_attribute_selector.
    const root = await candidate({
      "compositions/02-product.html": [
        '<div id="product-world-root" class="stage dark" data-hf-id="product-world" data-composition-id="product-world" data-start="0" data-duration="22" data-width="1920" data-height="1080" data-fps="30" data-track-index="0">',
        "<style>",
        '  [data-composition-id="product-world"] .card { color: #111; }',
        "  [data-composition-id='product-world'] .row { display: flex; }",
        "  .stage { width: 1920px; height: 1080px; }",
        "  .stage .card { display: block; }",
        "  .stage.dark > .row { min-width: 0; }",
        "  .wrapper .stage { opacity: 1; }",
        "</style>",
        '  <div class="wrapper"><div class="card">Spec</div><div class="row">Ready</div></div>',
        "</div>",
      ].join("\n"),
    });

    await normalizeFreshCompositionSelfSelectors(root);
    const html = await readFile(join(root, "compositions/02-product.html"), "utf8");
    expect(html).not.toContain('[data-composition-id="product-world"]');
    expect(html).not.toContain("[data-composition-id='product-world']");
    expect(html).toContain("#product-world-root .card");
    expect(html).toContain("#product-world-root .row");
    expect(html).toContain('id="product-world-root" class="stage dark"');
    expect(html).toContain("#product-world-root { width: 1920px; height: 1080px; }");
    expect(html).toContain("#product-world-root .card { display: block; }");
    expect(html).toContain("#product-world-root > .row { min-width: 0; }");
    expect(html).toContain(".wrapper .stage { opacity: 1; }");
    await normalizeFreshCompositionSelfSelectors(root);
    expect(await readFile(join(root, "compositions/02-product.html"), "utf8")).toBe(html);
  });

  it("adds the conventional root id when the root has none, when it is globally unused", async () => {
    const root = await candidate({
      "compositions/02-product.html": [
        '<section data-hf-id="product-world" data-composition-id="product-world" data-start="0" data-duration="22" data-width="1920" data-height="1080" data-fps="30" data-track-index="0">',
        '<style>[data-composition-id="product-world"] .k { color: #000; }</style>',
        "</section>",
      ].join("\n"),
    });

    await normalizeFreshCompositionSelfSelectors(root);
    const html = await readFile(join(root, "compositions/02-product.html"), "utf8");
    expect(html).toContain('id="product-world-root"');
    expect(html).toContain("#product-world-root .k");
  });

  it("is idempotent and never rewrites references to other compositions", async () => {
    const files = {
      "index.html": [
        '<div id="host" data-composition-id="fresh-build" data-start="0" data-duration="22" data-width="1920" data-height="1080" data-fps="30">',
        // A cross-composition reference must survive untouched.
        '<style>[data-composition-id="product-world"] { opacity: 1; }</style>',
        "</div>",
      ].join("\n"),
      "compositions/02-product.html": [
        '<div id="product-world-root" data-composition-id="product-world" data-start="0" data-duration="22" data-width="1920" data-height="1080" data-fps="30" data-track-index="0">',
        '<style>[data-composition-id="product-world"] .a { color: #111; }</style>',
        "</div>",
      ].join("\n"),
    };
    const root = await candidate(files);

    await normalizeFreshCompositionSelfSelectors(root);
    const firstPass = await readFile(join(root, "compositions/02-product.html"), "utf8");
    await normalizeFreshCompositionSelfSelectors(root);
    const secondPass = await readFile(join(root, "compositions/02-product.html"), "utf8");
    expect(secondPass).toBe(firstPass);
    expect(secondPass).toContain("#product-world-root .a");

    // index.html referenced product-world (a different composition), not its
    // own id, so its selector is intentionally left as-is.
    const indexHtml = await readFile(join(root, "index.html"), "utf8");
    expect(indexHtml).toContain('[data-composition-id="product-world"]');
  });
});
