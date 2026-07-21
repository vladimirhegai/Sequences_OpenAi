import { describe, expect, it } from "vitest";
import { allowedPaths, assertChangedPaths } from "../../src/server/policy";

describe("creative authoring scope", () => {
  it("lets a new build update only the canonical planning and design artifacts", () => {
    const scope = allowedPaths("build");

    expect(scope).toEqual(
      expect.arrayContaining([
        "STORYBOARD.md",
        "SCRIPT.md",
        "frame.md",
        "story/component-plan.json",
        "story/design-capsule.json",
        "sequence.json",
        "index.html",
        "compositions/**",
      ]),
    );
    expect(() =>
      assertChangedPaths(
        ["STORYBOARD.md", "frame.md", "sequence.json", "index.html", "compositions/01-hook.html"],
        scope,
      ),
    ).not.toThrow();
  });

  it("does not advertise legacy design aliases that cannot satisfy fresh-build promotion", () => {
    const scope = allowedPaths("build");
    const legacyPaths = [
      "design.md",
      "DESIGN.md",
      "story/frame.md",
      "story/design.md",
      "story/DESIGN.md",
    ];

    for (const path of legacyPaths) {
      expect(scope).not.toContain(path);
      expect(() => allowedPaths("build", [path])).toThrow(
        `${path} is outside the allowed build job scope`,
      );
      expect(() => assertChangedPaths([path], scope)).toThrow(
        `Codex changed a file outside the approved scope: ${path}`,
      );
    }
  });

  it("keeps root frame.md as the only frame contract for plans and targeted revisions", () => {
    expect(allowedPaths("plan")).toContain("frame.md");
    expect(allowedPaths("revision", ["frame.md"])).toEqual(["frame.md"]);

    for (const kind of ["plan", "revision"] as const) {
      expect(() => allowedPaths(kind, ["story/frame.md"])).toThrow(
        `story/frame.md is outside the allowed ${kind} job scope`,
      );
    }
  });

  it("keeps host and dependency files protected inside the broader creative scope", () => {
    const scope = allowedPaths("build");

    expect(() => assertChangedPaths(["AGENTS.md"], scope)).toThrow(
      "Codex changed a protected file: AGENTS.md",
    );
    expect(() => assertChangedPaths(["package.json"], scope)).toThrow(
      "Codex changed a protected file: package.json",
    );
    expect(() => assertChangedPaths(["server.ts"], scope)).toThrow(
      "Codex changed a file outside the approved scope: server.ts",
    );
  });

  it("does not widen an explicitly targeted revision", () => {
    const scope = allowedPaths("revision", ["compositions/02-compose.html", "sequence.json"]);

    expect(() =>
      assertChangedPaths(["compositions/02-compose.html", "sequence.json"], scope),
    ).not.toThrow();
    expect(() => assertChangedPaths(["STORYBOARD.md"], scope)).toThrow(
      "Codex changed a file outside the approved scope: STORYBOARD.md",
    );
  });
});
