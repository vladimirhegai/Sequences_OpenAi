import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const primitivesRoot = join(process.cwd(), "fixtures", "saas-shell", "compositions", "_primitives");

async function loadPrimitive(name: string): Promise<any> {
  const source = await readFile(join(primitivesRoot, name), "utf8");
  const browserWindow: Record<string, unknown> = { Intl };
  vm.runInNewContext(source, { window: browserWindow }, { filename: name });
  return browserWindow.SequencesMotionPrimitives;
}

function element(rect = { left: 0, top: 0, width: 1, height: 1 }) {
  return {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    textContent: "",
    parentElement: null as unknown,
    nextElementSibling: null as unknown,
    getBoundingClientRect: () => rect,
  };
}

describe("candidate-local motion primitives", () => {
  it("types graphemes from empty to complete and keeps the caret after proportional text", async () => {
    const api = await loadPrimitive("typewriter.js");
    const config = {
      text: "Wide interfaces ship ✨",
      startSec: 0.5,
      endSec: 2.5,
      caretRemoveSec: 3.2,
    };
    const start = api.typewriterState(config, 0.5);
    const midpoint = api.typewriterState(config, 1.5);
    const finalRenderableFrame = api.typewriterState(config, 2.499);
    const complete = api.typewriterState(config, 2.5);
    const removed = api.typewriterState(config, 3.2);

    expect(start).toMatchObject({ visibleGlyphs: 0, visibleText: "", caretVisible: true });
    expect(midpoint.visibleGlyphs).toBeGreaterThan(start.visibleGlyphs);
    expect(midpoint.visibleGlyphs).toBeLessThan(complete.visibleGlyphs);
    expect(finalRenderableFrame).toMatchObject({
      visibleText: config.text,
      complete: true,
    });
    expect(complete).toMatchObject({
      visibleText: config.text,
      complete: true,
      caretVisible: true,
    });
    expect(removed).toMatchObject({ phase: "caret-removed", caretVisible: false });

    const text = element();
    const caret = element();
    const row = {};
    text.parentElement = row;
    caret.parentElement = row;
    text.nextElementSibling = caret;
    const calls: Array<{ target: Record<string, number>; vars: Record<string, unknown> }> = [];
    const timeline = {
      to(target: Record<string, number>, vars: Record<string, unknown>) {
        calls.push({ target, vars });
        return this;
      },
    };
    const root = {
      dataset: {} as Record<string, string>,
      querySelector(selector: string) {
        return selector === "[data-typewriter-text]" ? text : caret;
      },
    };
    const typing = api.createTypewriter({ ...config, root, timeline, driveUntilSec: 3.2 });
    typing.render(1.5);
    expect(text.textContent).toBe(midpoint.visibleText);
    expect(caret.style.opacity).toBe("1");
    expect(typing.audioCue).toEqual({ kind: "typing", startSec: 0.5, endSec: 2.5 });
    expect(calls).toHaveLength(1);

    const example = await readFile(join(primitivesRoot, "typewriter.example.html"), "utf8");
    expect(example).toContain("display: inline-flex");
    expect(example).toContain("font-family: Montserrat, sans-serif");
    expect(example).toContain(
      "<span data-typewriter-text></span><span data-typewriter-caret></span>",
    );
    expect(example).not.toMatch(/https?:\/\//);
  });

  it("lands an arrow hotspot on a measured target before press, release, and consequence", async () => {
    const api = await loadPrimitive("pointer-action.js");
    const rootRect = { left: 100, top: 50, width: 1200, height: 800 };
    const targetRect = { left: 590, top: 390, width: 320, height: 96 };
    const pointer = element();
    const target = element(targetRect);
    const ripple = element({ left: 0, top: 0, width: 44, height: 44 });
    const before = element();
    const after = element();
    const consequence = element();
    const bySelector = new Map<string, ReturnType<typeof element>>([
      ["[data-pointer-action-cursor]", pointer],
      ["[data-pointer-action-target]", target],
      ["[data-pointer-action-feedback]", target],
      ["[data-pointer-action-ripple]", ripple],
      ["[data-pointer-action-before]", before],
      ["[data-pointer-action-after]", after],
      ["[data-pointer-action-consequence]", consequence],
    ]);
    const root = {
      dataset: {} as Record<string, string>,
      getBoundingClientRect: () => rootRect,
      querySelector: (selector: string) => bySelector.get(selector) ?? null,
    };
    const calls: Array<{ target: Record<string, number>; vars: Record<string, unknown> }> = [];
    const timeline = {
      to(driver: Record<string, number>, vars: Record<string, unknown>) {
        calls.push({ target: driver, vars });
        return this;
      },
    };
    const action = api.createPointerAction({
      root,
      timeline,
      startSec: 0.4,
      approachOffset: { x: 220, y: 140 },
      hotspotX: 3,
      hotspotY: 2,
      approachSec: 0.6,
      settleSec: 0.12,
      pressSec: 0.1,
      releaseSec: 0.22,
    });

    const approach = action.stateAt(action.timing.approachEndSec - 0.1);
    const contact = action.render(action.timing.contactSec);
    const released = action.render(action.timing.releaseEndSec);
    expect(approach.phase).toBe("approach");
    expect(contact.phase).toBe("press");
    expect(contact.cursorX + action.geometry.hotspot.x).toBeCloseTo(
      action.geometry.targetPoint.x,
      8,
    );
    expect(contact.cursorY + action.geometry.hotspot.y).toBeCloseTo(
      action.geometry.targetPoint.y,
      8,
    );
    expect(action.timing.contactSec).toBe(action.timing.pressStartSec + action.timing.pressSec);
    expect(action.timing.releaseStartSec).toBe(action.timing.contactSec);
    expect(released.phase).toBe("consequence");
    expect(before.style.opacity).toBe("0");
    expect(after.style.opacity).toBe("1");
    expect(root.dataset.pointerConsequence).toBe("visible");
    expect(action.audioCue).toEqual({ kind: "mouse-click", atSec: action.timing.contactSec });
    expect(calls).toHaveLength(1);

    const example = await readFile(join(primitivesRoot, "pointer-action.example.html"), "utf8");
    expect(example).toContain('d="M3 2 L3 31');
    expect(example).toContain("hotspotX: 3");
    expect(example).toContain("data-pointer-action-after>Generating...</span>");
    expect(example).not.toContain("clip-path: polygon");
    expect(example).not.toMatch(/https?:\/\//);
  });
});
