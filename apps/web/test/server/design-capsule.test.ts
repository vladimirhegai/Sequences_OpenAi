import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDesignCapsule,
  assertDesignCapsuleDirection,
  normalizeDesignCapsuleMotionVerbs,
  repairUnusedDesignTokenBindings,
} from "../../src/server/design-capsule";
import {
  DESIGN_CAPSULE_CATALOG,
  DESIGN_CATALOG_IDS,
  DesignCapsuleV1Schema,
  type DesignCapsuleV1,
  type DesignCatalogId,
} from "../../src/shared";
import { authorFreshBuildFixture } from "./fresh-build-fixture";

const roots: string[] = [];
const shellRoot = join(process.cwd(), "fixtures", "saas-shell");
const compositionRelativePath = "compositions/02-compose.html";
const bundledWeights = {
  Montserrat: [500, 600, 700, 800, 900],
  "IBM Plex Mono": [500, 600, 700],
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("design capsule catalog", () => {
  it("trims excess ordered motion verbs before schema validation", async () => {
    const root = await authoredProject();
    const path = join(root, "story", "design-capsule.json");
    const capsule = JSON.parse(await readFile(path, "utf8")) as { motionVerbs: string[] };
    capsule.motionVerbs = [
      "focus-push",
      "state-swap",
      "cursor-cause",
      "panel-slide",
      "data-resolve",
    ];
    await writeFile(path, `${JSON.stringify(capsule, null, 2)}\n`, "utf8");

    await expect(normalizeDesignCapsuleMotionVerbs(root)).resolves.toBe(1);
    await expect(assertDesignCapsule(root)).resolves.toMatchObject({
      motionVerbs: ["focus-push", "state-swap", "cursor-cause", "panel-slide"],
    });
  });

  it.each(DESIGN_CATALOG_IDS)("keeps %s schema-valid and limited to bundled font weights", (id) => {
    const capsule = catalogCapsule(id);

    expect(DesignCapsuleV1Schema.safeParse(capsule).success).toBe(true);
    for (const role of Object.values(capsule.typography)) {
      expect(role.weights.length).toBeGreaterThan(0);
      for (const weight of role.weights) {
        expect(bundledWeights[role.family]).toContain(weight);
      }
    }
  });

  it.each([
    ["Montserrat", 501],
    ["IBM Plex Mono", 800],
  ] as const)("rejects unbundled %s weight %i", (family, weight) => {
    const valid = structuredClone(catalogCapsule("signal-light"));
    const capsule = {
      ...valid,
      typography: { ...valid.typography, mono: { family, weights: [weight] } },
    };

    expect(DesignCapsuleV1Schema.safeParse(capsule).success).toBe(false);
  });
});

describe("authored design capsule", () => {
  it("accepts the capsule authored by the canonical fresh-build fixture", async () => {
    const root = await authoredProject();

    await expect(assertDesignCapsule(root)).resolves.toMatchObject({
      version: "sequences.design-capsule.v1",
      origin: { kind: "catalog" },
      implementationFiles: [compositionRelativePath],
    });
  });

  it("accepts a declared family used through valid CSS font shorthand", async () => {
    const root = await authoredProject();
    await mutateComposition(root, (source) => {
      const familyDeclarations = /font-family\s*:\s*["']?IBM Plex Mono["']?[^;]*;/gi;
      expect(source).toMatch(familyDeclarations);
      return source.replace(familyDeclarations, 'font: 600 14px/1.2 "IBM Plex Mono", monospace;');
    });

    await expect(assertDesignCapsule(root)).resolves.toBeDefined();
  });

  it("rejects drift from a selected catalog foundation", async () => {
    const root = await authoredProject();
    await mutateCapsule(root, (capsule) => {
      capsule.geometry.radiusPx += 1;
    });

    await expect(assertDesignCapsule(root)).rejects.toThrow(
      "must preserve catalog signal-light geometry",
    );
  });

  it("rejects a bespoke palette with insufficient contrast", async () => {
    const root = await authoredProject();
    await mutateCapsule(root, (capsule) => {
      capsule.origin = { kind: "bespoke", rationale: "Exercise the objective contrast gate." };
      capsule.palette.text = capsule.palette.background;
    });

    await expect(assertDesignCapsule(root)).rejects.toThrow(
      /text\/background contrast .* is below/,
    );
  });

  it("requires supplied screenshots to lock the reference-derived design direction", async () => {
    const root = await authoredProject();
    const expectedImages = [{ path: "assets/derived/reference.png" }];

    await expect(assertDesignCapsuleDirection(root, expectedImages)).rejects.toThrow(
      "must use reference-derived origin with reference-locked fidelity",
    );

    await mutateCapsule(root, (capsule) => {
      capsule.origin = {
        kind: "reference-derived",
        fidelity: "reference-locked",
        imagePaths: [expectedImages[0]!.path],
        rationale: "The supplied screenshot is the product UI source of truth.",
      };
    });
    await expect(assertDesignCapsuleDirection(root, expectedImages)).resolves.toMatchObject({
      origin: {
        kind: "reference-derived",
        fidelity: "reference-locked",
        imagePaths: [expectedImages[0]!.path],
      },
    });
  });

  it("does not accept an HTML comment as the declared design root", async () => {
    const root = await authoredProject();
    const capsule = await readCapsule(root);
    const attribute = `data-hf-id="${capsule.rootHfId}"`;
    await mutateComposition(root, (source) => {
      expect(source).toContain(attribute);
      return `${source.replace(attribute, 'data-hf-id="different-design-root"')}\n<!-- ${attribute} -->\n`;
    });

    await expect(assertDesignCapsule(root)).rejects.toThrow(
      new RegExp(`root ${escapeRegExp(capsule.rootHfId)} must bind to exactly one data-hf-id`),
    );
  });

  it("reports every missing palette declaration in one repair packet", async () => {
    const root = await authoredProject();
    const capsule = await readCapsule(root);
    const missing = ["surface", "border"] as const;
    await mutateComposition(root, (source) => {
      let updated = source;
      for (const role of missing) {
        const variable = capsule.tokenBindings[role];
        const color = capsule.palette[role];
        const declaration = new RegExp(
          `${escapeRegExp(variable)}\\s*:\\s*${escapeRegExp(color)}(?=\\s*[;}])`,
          "i",
        );
        expect(updated).toMatch(declaration);
        updated = updated.replace(declaration, `${variable}: #010203`);
      }
      return updated;
    });

    await expect(assertDesignCapsule(root)).rejects.toThrow(
      new RegExp(
        `2 palette binding mismatches:[\\s\\S]*surface token ${escapeRegExp(
          capsule.tokenBindings.surface,
        )} is not declared[\\s\\S]*border token ${escapeRegExp(
          capsule.tokenBindings.border,
        )} is not declared`,
      ),
    );
  });

  it("does not accept a CSS comment as a token declaration", async () => {
    const root = await authoredProject();
    const capsule = await readCapsule(root);
    const variable = capsule.tokenBindings.accent;
    const color = capsule.palette.accent;
    const declaration = new RegExp(
      `${escapeRegExp(variable)}\\s*:\\s*${escapeRegExp(color)}(?=\\s*[;}])`,
      "i",
    );
    await mutateComposition(root, (source) => {
      expect(source).toMatch(declaration);
      const withoutDeclaration = source.replace(declaration, `${variable}: #010203`);
      return `${withoutDeclaration}\n<style>/* ${variable}: ${color}; */</style>\n`;
    });

    await expect(assertDesignCapsule(root)).rejects.toThrow(
      `accent token ${variable} is not declared as ${color}`,
    );
  });

  it("accepts a complete declared palette when an optional visual role is unused", async () => {
    const root = await authoredProject();
    const capsule = await readCapsule(root);
    const variable = capsule.tokenBindings.surface;
    const usage = new RegExp(`var\\(\\s*${escapeRegExp(variable)}\\s*\\)`, "gi");
    await mutateComposition(root, (source) => {
      expect(source).toMatch(usage);
      usage.lastIndex = 0;
      return source.replace(usage, "#FEFEFE");
    });

    await expect(assertDesignCapsule(root)).resolves.toMatchObject({
      tokenBindings: { surface: variable },
    });
  });

  it("repairs an unused token only when the exact palette literal already has a real CSS use", async () => {
    const root = await authoredProject();
    const capsule = await readCapsule(root);
    const variable = capsule.tokenBindings.surface;
    const usage = new RegExp(`var\\(\\s*${escapeRegExp(variable)}\\s*\\)`, "gi");
    await mutateComposition(root, (source) => {
      expect(source).toMatch(usage);
      usage.lastIndex = 0;
      return source.replace(usage, capsule.palette.surface);
    });

    const result = await repairUnusedDesignTokenBindings(root);
    expect(result).toMatchObject({
      repaired: [
        {
          sourceFile: compositionRelativePath,
          role: "surface",
          variable,
          color: capsule.palette.surface,
        },
      ],
      changedFiles: [compositionRelativePath],
    });
    const source = await readFile(join(root, ...compositionRelativePath.split("/")), "utf8");
    expect(source).toContain(`${variable}: ${capsule.palette.surface};`);
    expect(source).toMatch(new RegExp(`var\\(\\s*${escapeRegExp(variable)}\\s*\\)`, "i"));
    await expect(assertDesignCapsule(root)).resolves.toBeTruthy();
  });

  it("does not guess a visual role when an unused token has no exact palette literal use", async () => {
    const root = await authoredProject();
    const capsule = await readCapsule(root);
    const variable = capsule.tokenBindings.surface;
    const usage = new RegExp(`var\\(\\s*${escapeRegExp(variable)}\\s*\\)`, "gi");
    await mutateComposition(root, (source) => {
      expect(source).toMatch(usage);
      usage.lastIndex = 0;
      return source.replace(usage, "#FEFEFE");
    });
    const before = await readFile(join(root, ...compositionRelativePath.split("/")), "utf8");

    const result = await repairUnusedDesignTokenBindings(root);

    expect(result).toMatchObject({ repaired: [], changedFiles: [] });
    await expect(readFile(join(root, ...compositionRelativePath.split("/")), "utf8")).resolves.toBe(
      before,
    );
    await expect(assertDesignCapsule(root)).resolves.toBeTruthy();
  });

  it("rejects a missing frame.md design brief", async () => {
    const root = await authoredProject();
    await rm(join(root, "frame.md"));

    await expect(assertDesignCapsule(root)).rejects.toThrow(/frame\.md/);
  });

  it("rejects frame.md when it no longer matches the machine-readable capsule", async () => {
    const root = await authoredProject();
    const capsule = await readCapsule(root);
    const path = join(root, "frame.md");
    const frame = await readFile(path, "utf8");
    expect(frame).toContain(capsule.palette.accent);
    await writeFile(path, frame.replace(capsule.palette.accent, "#010203"), "utf8");

    await expect(assertDesignCapsule(root)).rejects.toThrow(/frame\.md/);
  });
});

async function authoredProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sequences-design-capsule-"));
  roots.push(root);
  await cp(shellRoot, root, { recursive: true });
  await authorFreshBuildFixture(root);
  return root;
}

async function readCapsule(root: string): Promise<DesignCapsuleV1> {
  return DesignCapsuleV1Schema.parse(
    JSON.parse(await readFile(join(root, "story", "design-capsule.json"), "utf8")) as unknown,
  );
}

async function mutateCapsule(
  root: string,
  mutate: (capsule: DesignCapsuleV1) => void,
): Promise<void> {
  const path = join(root, "story", "design-capsule.json");
  const capsule = await readCapsule(root);
  mutate(capsule);
  await writeFile(path, `${JSON.stringify(capsule, null, 2)}\n`, "utf8");
}

async function mutateComposition(root: string, mutate: (source: string) => string): Promise<void> {
  const path = join(root, ...compositionRelativePath.split("/"));
  await writeFile(path, mutate(await readFile(path, "utf8")), "utf8");
}

function catalogCapsule(catalogId: DesignCatalogId): DesignCapsuleV1 {
  const catalog = DESIGN_CAPSULE_CATALOG[catalogId];
  return DesignCapsuleV1Schema.parse({
    version: "sequences.design-capsule.v1",
    id: `${catalogId}-test`,
    name: catalog.label,
    thesis: catalog.thesis,
    origin: { kind: "catalog", catalogId },
    basis: catalog.basis,
    palette: catalog.palette,
    typography: catalog.typography,
    geometry: catalog.geometry,
    density: catalog.density,
    compositionDialect: catalog.compositionDialect,
    motionVerbs: ["focus-push", "state-swap"],
    rules: {
      do: ["Keep the product legible.", "Use one decisive signal."],
      avoid: ["Avoid decorative clutter.", "Avoid disconnected surfaces."],
    },
    rootHfId: "hf-design-root",
    tokenBindings: {
      background: "--design-background",
      surface: "--design-surface",
      text: "--design-text",
      muted: "--design-muted",
      accent: "--design-accent",
      accentText: "--design-accent-text",
      border: "--design-border",
    },
    implementationFiles: [compositionRelativePath],
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
