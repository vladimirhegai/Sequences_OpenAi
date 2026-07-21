(function installSequencesTypewriter(global) {
  "use strict";

  const namespace = (global.SequencesMotionPrimitives = global.SequencesMotionPrimitives || {});

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function finiteNumber(value, name) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
    return value;
  }

  function graphemes(text) {
    const value = String(text);
    if (global.Intl && typeof global.Intl.Segmenter === "function") {
      const segmenter = new global.Intl.Segmenter("en", { granularity: "grapheme" });
      return Array.from(segmenter.segment(value), ({ segment }) => segment);
    }
    return Array.from(value);
  }

  function normalizedConfig(options) {
    const startSec = finiteNumber(options.startSec ?? 0, "startSec");
    const endSec = finiteNumber(options.endSec, "endSec");
    if (startSec < 0 || endSec <= startSec) {
      throw new Error("Typewriter timing must satisfy 0 <= startSec < endSec");
    }
    const caretRemoveSec =
      options.caretRemoveSec === undefined || options.caretRemoveSec === null
        ? null
        : finiteNumber(options.caretRemoveSec, "caretRemoveSec");
    if (caretRemoveSec !== null && caretRemoveSec < endSec) {
      throw new Error("caretRemoveSec must be at or after endSec");
    }
    const blinkPeriodSec = finiteNumber(options.blinkPeriodSec ?? 0.8, "blinkPeriodSec");
    if (blinkPeriodSec <= 0) throw new Error("blinkPeriodSec must be positive");
    return {
      text: String(options.text),
      startSec,
      endSec,
      caretRemoveSec,
      blinkPeriodSec,
    };
  }

  function stateFromGlyphs(config, glyphList, atSec) {
    const at = finiteNumber(atSec, "atSec");
    const progress = clamp01((at - config.startSec) / (config.endSec - config.startSec));
    // Reveal each glyph at the start of its allotted interval. Besides feeling
    // responsive, this keeps the completed text visible in the final renderable
    // frame when a cue ends exactly at a beat or composition boundary.
    const visibleGlyphs = Math.max(
      0,
      Math.min(glyphList.length, progress === 0 ? 0 : Math.ceil(progress * glyphList.length)),
    );
    const complete = visibleGlyphs === glyphList.length;
    let caretVisible = config.caretRemoveSec === null || at < config.caretRemoveSec;
    if (caretVisible && complete && at > config.endSec) {
      const halfPeriod = config.blinkPeriodSec / 2;
      caretVisible = Math.floor((at - config.endSec) / halfPeriod) % 2 === 0;
    }
    return {
      atSec: at,
      visibleGlyphs,
      visibleText: glyphList.slice(0, visibleGlyphs).join(""),
      complete,
      caretVisible,
      phase:
        at < config.startSec
          ? "waiting"
          : at < config.endSec
            ? "typing"
            : config.caretRemoveSec !== null && at >= config.caretRemoveSec
              ? "caret-removed"
              : "complete",
    };
  }

  function typewriterState(options, atSec) {
    const config = normalizedConfig(options);
    return stateFromGlyphs(config, graphemes(config.text), atSec);
  }

  function createTypewriter(options) {
    const config = normalizedConfig(options);
    const root = options.root;
    const timeline = options.timeline;
    if (!root || typeof root.querySelector !== "function") {
      throw new Error("Typewriter root must be a composition-local element");
    }
    if (!timeline || typeof timeline.to !== "function") {
      throw new Error("Typewriter requires the composition's paused GSAP timeline");
    }
    const textElement = root.querySelector(options.textSelector ?? "[data-typewriter-text]");
    const caretElement = root.querySelector(options.caretSelector ?? "[data-typewriter-caret]");
    if (!textElement || !caretElement) {
      throw new Error("Typewriter root needs data-typewriter-text and data-typewriter-caret");
    }
    if (
      textElement.parentElement !== caretElement.parentElement ||
      textElement.nextElementSibling !== caretElement
    ) {
      throw new Error("Place the caret immediately after the text in the same inline layout row");
    }

    const glyphList = graphemes(config.text);
    const driveUntilSec = finiteNumber(
      options.driveUntilSec ?? config.caretRemoveSec ?? config.endSec,
      "driveUntilSec",
    );
    if (driveUntilSec < config.endSec) {
      throw new Error("driveUntilSec must reach the completed typing state");
    }

    const render = (atSec) => {
      const state = stateFromGlyphs(config, glyphList, atSec);
      textElement.textContent = state.visibleText;
      caretElement.style.opacity = state.caretVisible ? "1" : "0";
      root.dataset.typingPhase = state.phase;
      root.dataset.visibleGlyphs = String(state.visibleGlyphs);
      return state;
    };

    render(0);
    const driver = { atSec: 0 };
    timeline.to(
      driver,
      {
        atSec: driveUntilSec,
        duration: driveUntilSec,
        ease: "none",
        onUpdate: () => render(driver.atSec),
      },
      0,
    );

    return {
      render,
      stateAt: (atSec) => stateFromGlyphs(config, glyphList, atSec),
      audioCue: { kind: "typing", startSec: config.startSec, endSec: config.endSec },
      timing: {
        startSec: config.startSec,
        midpointSec: (config.startSec + config.endSec) / 2,
        endSec: config.endSec,
        caretRemoveSec: config.caretRemoveSec,
      },
    };
  }

  namespace.typewriterState = typewriterState;
  namespace.createTypewriter = createTypewriter;
})(window);
