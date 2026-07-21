(function installSequencesPointerAction(global) {
  "use strict";

  const namespace = (global.SequencesMotionPrimitives = global.SequencesMotionPrimitives || {});

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  function finiteNumber(value, name) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
    return value;
  }

  function easeInOutCubic(value) {
    const t = clamp01(value);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function easeOutCubic(value) {
    return 1 - Math.pow(1 - clamp01(value), 3);
  }

  function easeOutBack(value) {
    const t = clamp01(value);
    const c1 = 1.45;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function lerp(from, to, progress) {
    return from + (to - from) * progress;
  }

  function normalizedTiming(options) {
    const startSec = finiteNumber(options.startSec ?? 0, "startSec");
    const approachSec = finiteNumber(options.approachSec ?? 0.62, "approachSec");
    const settleSec = finiteNumber(options.settleSec ?? 0.12, "settleSec");
    const pressSec = finiteNumber(options.pressSec ?? 0.1, "pressSec");
    const releaseSec = finiteNumber(options.releaseSec ?? 0.22, "releaseSec");
    const rippleSec = finiteNumber(options.rippleSec ?? 0.55, "rippleSec");
    const consequenceSec = finiteNumber(options.consequenceSec ?? 0.18, "consequenceSec");
    const pointerFadeSec = finiteNumber(options.pointerFadeSec ?? 0.24, "pointerFadeSec");
    if (
      startSec < 0 ||
      approachSec <= 0 ||
      settleSec < 0 ||
      pressSec <= 0 ||
      releaseSec <= 0 ||
      rippleSec <= 0 ||
      consequenceSec <= 0 ||
      pointerFadeSec < 0
    ) {
      throw new Error(
        "Pointer timing values must be finite and positive (settleSec and pointerFadeSec may be zero)",
      );
    }
    const approachEndSec = startSec + approachSec;
    const pressStartSec = approachEndSec + settleSec;
    const contactSec = pressStartSec + pressSec;
    const releaseStartSec = contactSec;
    const releaseEndSec = releaseStartSec + releaseSec;
    const pointerFadeEndSec = releaseEndSec + pointerFadeSec;
    return {
      startSec,
      approachSec,
      approachEndSec,
      settleSec,
      pressStartSec,
      contactSec,
      pressSec,
      releaseStartSec,
      releaseSec,
      releaseEndSec,
      pointerFadeSec,
      pointerFadeEndSec,
      rippleSec,
      rippleEndSec: contactSec + rippleSec,
      consequenceSec,
      consequenceEndSec: contactSec + consequenceSec,
      endSec: Math.max(pointerFadeEndSec, contactSec + rippleSec, contactSec + consequenceSec),
    };
  }

  function pointerActionState(options, atSec) {
    const timing = normalizedTiming(options);
    const at = finiteNumber(atSec, "atSec");
    const startX = finiteNumber(options.startX, "startX");
    const startY = finiteNumber(options.startY, "startY");
    const targetX = finiteNumber(options.targetX, "targetX");
    const targetY = finiteNumber(options.targetY, "targetY");
    const pointerPressScale = finiteNumber(options.pointerPressScale ?? 0.84, "pointerPressScale");
    const targetPressScale = finiteNumber(options.targetPressScale ?? 0.965, "targetPressScale");
    const approachProgress = easeInOutCubic((at - timing.startSec) / timing.approachSec);
    const cursorX = lerp(startX, targetX, approachProgress);
    const cursorY = lerp(startY, targetY, approachProgress);

    let pointerScale = 1;
    let targetScale = 1;
    if (at >= timing.pressStartSec && at < timing.contactSec) {
      const progress = clamp01((at - timing.pressStartSec) / timing.pressSec);
      pointerScale = lerp(1, pointerPressScale, progress);
      targetScale = lerp(1, targetPressScale, progress);
    } else if (at >= timing.releaseStartSec && at < timing.releaseEndSec) {
      const progress = easeOutBack((at - timing.releaseStartSec) / timing.releaseSec);
      pointerScale = lerp(pointerPressScale, 1, progress);
      targetScale = lerp(targetPressScale, 1, progress);
    }

    const rippleProgress = clamp01((at - timing.contactSec) / timing.rippleSec);
    const rippleAttack = 0.2;
    const rippleOpacity =
      at < timing.contactSec || at >= timing.rippleEndSec
        ? 0
        : rippleProgress <= rippleAttack
          ? 0.42 * (rippleProgress / rippleAttack)
          : 0.42 * (1 - (rippleProgress - rippleAttack) / (1 - rippleAttack));
    const consequenceProgress =
      at < timing.contactSec ? 0 : easeOutCubic((at - timing.contactSec) / timing.consequenceSec);
    const pointerOpacity =
      at < timing.startSec
        ? 0
        : at <= timing.releaseEndSec
          ? 1
          : timing.pointerFadeSec === 0 || at >= timing.pointerFadeEndSec
            ? 0
            : 1 - clamp01((at - timing.releaseEndSec) / timing.pointerFadeSec);

    return {
      atSec: at,
      cursorX,
      cursorY,
      pointerScale,
      pointerOpacity,
      targetScale,
      rippleScale: lerp(0.35, 2.8, rippleProgress),
      rippleOpacity,
      consequenceProgress,
      consequenceVisible: at >= timing.contactSec,
      phase:
        at < timing.startSec
          ? "waiting"
          : at < timing.approachEndSec
            ? "approach"
            : at < timing.pressStartSec
              ? "settle"
              : at <= timing.contactSec
                ? "press"
                : at < timing.releaseEndSec
                  ? "release"
                  : at < timing.endSec
                    ? "consequence"
                    : "done",
      timing,
    };
  }

  function targetRelativeGeometry(root, target, options) {
    const rootRect = root.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (
      rootRect.width <= 0 ||
      rootRect.height <= 0 ||
      targetRect.width <= 0 ||
      targetRect.height <= 0
    ) {
      throw new Error("Measure pointer geometry only after the root and target have final layout");
    }
    const anchorX = finiteNumber(options.anchorX ?? 0.5, "anchorX");
    const anchorY = finiteNumber(options.anchorY ?? 0.5, "anchorY");
    if (anchorX < 0 || anchorX > 1 || anchorY < 0 || anchorY > 1) {
      throw new Error("Pointer target anchors must be normalized values from 0 to 1");
    }
    const hotspotX = finiteNumber(options.hotspotX ?? 3, "hotspotX");
    const hotspotY = finiteNumber(options.hotspotY ?? 2, "hotspotY");
    const targetPoint = {
      x: targetRect.left - rootRect.left + targetRect.width * anchorX,
      y: targetRect.top - rootRect.top + targetRect.height * anchorY,
    };
    const approachOffset = options.approachOffset ?? { x: 190, y: 135 };
    const offsetX = finiteNumber(approachOffset.x, "approachOffset.x");
    const offsetY = finiteNumber(approachOffset.y, "approachOffset.y");
    const targetCursor = { x: targetPoint.x - hotspotX, y: targetPoint.y - hotspotY };
    return {
      targetPoint,
      hotspot: { x: hotspotX, y: hotspotY },
      targetCursor,
      startCursor: { x: targetCursor.x + offsetX, y: targetCursor.y + offsetY },
    };
  }

  function positioningSpace(element, fallback) {
    const offsetParent = element.offsetParent;
    if (offsetParent && typeof offsetParent.getBoundingClientRect === "function") {
      return offsetParent;
    }

    // SVG elements do not expose offsetParent in Chromium. Walk to the nearest
    // containing-block ancestor so an SVG cursor can still use local geometry.
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== fallback) {
      const style =
        typeof global.getComputedStyle === "function"
          ? global.getComputedStyle(ancestor)
          : ancestor.style;
      if (
        style &&
        (style.position !== "static" ||
          (style.transform && style.transform !== "none") ||
          (style.perspective && style.perspective !== "none") ||
          (style.filter && style.filter !== "none"))
      ) {
        return ancestor;
      }
      ancestor = ancestor.parentElement;
    }
    return fallback;
  }

  function createPointerAction(options) {
    const root = options.root;
    const timeline = options.timeline;
    if (!root || typeof root.querySelector !== "function") {
      throw new Error("Pointer root must be a composition-local element");
    }
    if (!timeline || typeof timeline.to !== "function") {
      throw new Error("Pointer action requires the composition's paused GSAP timeline");
    }
    const scoped = (selector, fallback) => root.querySelector(selector ?? fallback);
    const pointer = scoped(options.pointerSelector, "[data-pointer-action-cursor]");
    const target = scoped(options.targetSelector, "[data-pointer-action-target]");
    const feedback = scoped(options.feedbackSelector, "[data-pointer-action-feedback]") || target;
    const ripple = scoped(options.rippleSelector, "[data-pointer-action-ripple]");
    const beforeState = scoped(options.beforeStateSelector, "[data-pointer-action-before]");
    const afterState = scoped(options.afterStateSelector, "[data-pointer-action-after]");
    const consequence = scoped(options.consequenceSelector, "[data-pointer-action-consequence]");
    if (!pointer || !target || !feedback || !ripple) {
      throw new Error("Pointer root needs cursor, target, feedback, and ripple elements");
    }

    // Absolutely positioned elements without explicit insets retain their
    // static-position origin. Pin the helper-owned layers before measuring so
    // translate coordinates are relative to their actual containing blocks.
    pointer.style.left = "0px";
    pointer.style.top = "0px";
    ripple.style.left = "0px";
    ripple.style.top = "0px";
    const geometry = targetRelativeGeometry(positioningSpace(pointer, root), target, options);
    const rippleGeometry = targetRelativeGeometry(positioningSpace(ripple, root), target, options);
    const timing = normalizedTiming(options);
    const rippleRect = ripple.getBoundingClientRect();
    pointer.style.transformOrigin = `${geometry.hotspot.x}px ${geometry.hotspot.y}px`;
    pointer.dataset.hotspotX = String(geometry.hotspot.x);
    pointer.dataset.hotspotY = String(geometry.hotspot.y);

    const stateOptions = {
      ...options,
      startX: geometry.startCursor.x,
      startY: geometry.startCursor.y,
      targetX: geometry.targetCursor.x,
      targetY: geometry.targetCursor.y,
    };
    const render = (atSec) => {
      const state = pointerActionState(stateOptions, atSec);
      pointer.style.transform = `translate3d(${state.cursorX}px, ${state.cursorY}px, 0) scale(${state.pointerScale})`;
      pointer.style.opacity = String(state.pointerOpacity);
      feedback.style.transform = `scale(${state.targetScale})`;
      ripple.style.transform = `translate3d(${rippleGeometry.targetPoint.x - rippleRect.width / 2}px, ${rippleGeometry.targetPoint.y - rippleRect.height / 2}px, 0) scale(${state.rippleScale})`;
      ripple.style.opacity = String(state.rippleOpacity);
      if (beforeState) beforeState.style.opacity = state.consequenceVisible ? "0" : "1";
      if (afterState) afterState.style.opacity = state.consequenceVisible ? "1" : "0";
      if (consequence) {
        consequence.style.opacity = String(state.consequenceProgress);
        consequence.style.transform = `translate3d(0, ${(1 - state.consequenceProgress) * 10}px, 0)`;
      }
      root.dataset.pointerPhase = state.phase;
      root.dataset.pointerConsequence = state.consequenceVisible ? "visible" : "hidden";
      return state;
    };

    render(0);
    const driver = { atSec: 0 };
    timeline.to(
      driver,
      {
        atSec: timing.endSec,
        duration: timing.endSec,
        ease: "none",
        onUpdate: () => render(driver.atSec),
      },
      0,
    );

    return {
      render,
      stateAt: (atSec) => pointerActionState(stateOptions, atSec),
      audioCue: { kind: "mouse-click", atSec: timing.contactSec },
      geometry,
      rippleGeometry,
      timing,
    };
  }

  namespace.pointerActionState = pointerActionState;
  namespace.targetRelativePointerGeometry = targetRelativeGeometry;
  namespace.createPointerAction = createPointerAction;
})(window);
