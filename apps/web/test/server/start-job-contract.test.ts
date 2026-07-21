import { describe, expect, it } from "vitest";
import { StartJobRequestV1Schema, type PublicStartJobRequestV1 } from "../../src/shared";
import { directorSessionIsActive } from "../../src/server/app";

describe("Phase 1 public generation contract", () => {
  const freshBuild = {
    version: "sequences.start-job.v1",
    kind: "build",
    prompt: "Create a fresh SaaS launch video.",
    baseCommit: "a".repeat(40),
    directorMode: "reset",
  } satisfies PublicStartJobRequestV1;

  it("accepts only a fresh build with a reset Luna session", () => {
    expect(StartJobRequestV1Schema.parse(freshBuild)).toEqual(freshBuild);
    expect(
      StartJobRequestV1Schema.safeParse({ ...freshBuild, directorMode: "continue" }).success,
    ).toBe(false);
    expect(StartJobRequestV1Schema.safeParse({ ...freshBuild, kind: "plan" }).success).toBe(false);
    expect(StartJobRequestV1Schema.safeParse({ ...freshBuild, kind: "revision" }).success).toBe(
      false,
    );
    expect(
      StartJobRequestV1Schema.safeParse({
        ...freshBuild,
        revision: { beatIds: ["hero"] },
      }).success,
    ).toBe(false);
  });

  it("defaults an omitted director mode to reset", () => {
    const { directorMode: _directorMode, ...withoutMode } = freshBuild;
    expect(StartJobRequestV1Schema.parse(withoutMode).directorMode).toBe("reset");
  });

  it("reports a director session active only while a run can still change state", () => {
    expect(directorSessionIsActive([{ state: "authoring" }])).toBe(true);
    expect(directorSessionIsActive([{ state: "applying" }])).toBe(true);
    expect(directorSessionIsActive([{ state: "applied" }, { state: "failed" }])).toBe(false);
  });
});
