import { describe, expect, it } from "vitest";
import { imageMediaTypeForPath, parseGenerateArguments } from "../../../../scripts/generate";

describe("website generation CLI", () => {
  it("accepts repeated image inputs while preserving the video prompt", () => {
    expect(
      parseGenerateArguments([
        "--image",
        "references/first.png",
        "--image=references/second.JPEG",
        "--render=standard",
        "Create",
        "the launch film",
      ]),
    ).toEqual({
      prompt: "Create the launch film",
      imageFiles: ["references/first.png", "references/second.JPEG"],
      renderQuality: "standard",
      timeoutMinutes: 30,
    });
  });

  it("enforces the same four-image limit as the website request contract", () => {
    expect(() =>
      parseGenerateArguments([
        "--image=1.png",
        "--image=2.png",
        "--image=3.png",
        "--image=4.png",
        "--image=5.png",
        "Prompt",
      ]),
    ).toThrow("At most four --image inputs are supported");
  });

  it("declares only image formats accepted by the website upload endpoint", () => {
    expect(imageMediaTypeForPath("screen.PNG")).toBe("image/png");
    expect(imageMediaTypeForPath("screen.jpeg")).toBe("image/jpeg");
    expect(imageMediaTypeForPath("screen.webp")).toBe("image/webp");
    expect(() => imageMediaTypeForPath("screen.gif")).toThrow("use PNG, JPEG, or WebP");
  });
});
