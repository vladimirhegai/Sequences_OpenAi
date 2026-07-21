window.__setupSequencesAbstractFilm = () => {
  const polishTl = gsap.timeline({
    paused: true,
    defaults: { overwrite: "auto" },
  });
  const polishRoot = document.querySelector("#sequences-abstract-film");
  const polishRootRect = polishRoot.getBoundingClientRect();
  const polishSeed = document.querySelector("#seed");
  const polishPrompt = document.querySelector("#composer-prompt");
  const polishSend = document.querySelector("#send-control");
  const polishNodes = [...document.querySelectorAll(".sequence-node")];
  const polishSelected = document.querySelector(".story-card.selected");
  const polishResult = document.querySelector("#result-player");
  const polishRail = document.querySelector(".timeline-rail");
  const polishMorph = document.querySelector("#morph-card");
  const phraseWordFrame = document.querySelector(".phrase-word-frame");
  const phrasePromptWord = document.querySelector("#phrase-word-prompt");
  const phraseSequenceWord = document.querySelector("#phrase-word-sequence");
  const phraseSequenceWidth =
    phraseSequenceWord.getBoundingClientRect().width + 72;
  phraseWordFrame.style.width = `${Math.ceil(phraseSequenceWidth)}px`;
  const resultRoutePath = document.querySelector("#result-route-path");
  const resultRouteLength = resultRoutePath.getTotalLength();
  resultRoutePath.style.strokeDasharray = `${resultRouteLength}`;
  resultRoutePath.style.strokeDashoffset = `${resultRouteLength}`;
  const resultOrbit = document.querySelector(".result-orbit");
  const resultOrbitRect = resultOrbit.getBoundingClientRect();
  const resultOrbitNodes = [...document.querySelectorAll(".result-orbit-node")];
  const resultOrbitNodeOffsets = resultOrbitNodes.map((node) => {
    const nodeRect = node.getBoundingClientRect();
    return {
      x:
        resultOrbitRect.left +
        resultOrbitRect.width / 2 -
        (nodeRect.left + nodeRect.width / 2),
      y:
        resultOrbitRect.top +
        resultOrbitRect.height / 2 -
        (nodeRect.top + nodeRect.height / 2),
    };
  });
  const localCenter = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left - polishRootRect.left + rect.width / 2 - 5,
      y: rect.top - polishRootRect.top + rect.height / 2 - 26,
    };
  };
  const promptRect = polishPrompt.getBoundingClientRect();
  // The embedded Montserrat face settles after synchronous timeline setup.
  // This measured correction keeps the caret on the rendered glyph edge.
  const typedPromptWidth = Math.ceil(promptRect.width + 80);
  const promptStart = {
    x: promptRect.left - polishRootRect.left - 5,
    y: promptRect.top - polishRootRect.top + promptRect.height / 2 - 26,
  };
  const sendTarget = localCenter(polishSend);
  const centerTarget = { x: 955, y: 474 };
  const lockNodeRect = polishNodes[4].getBoundingClientRect();
  const lockNodeTarget = {
    x: lockNodeRect.right - polishRootRect.left - 36,
    y: lockNodeRect.top - polishRootRect.top + 3,
  };
  const railRect = polishRail.getBoundingClientRect();
  const playheadStart = {
    x: railRect.left - polishRootRect.left - 5,
    y: railRect.top - polishRootRect.top - 18.5,
  };
  const playheadEnd = {
    x: railRect.right - polishRootRect.left - 5,
    y: playheadStart.y,
  };
  const selectedRect = polishSelected.getBoundingClientRect();
  const morphRect = polishMorph.getBoundingClientRect();
  const morphStart = {
    x:
      selectedRect.left +
      selectedRect.width / 2 -
      (morphRect.left + morphRect.width / 2),
    y:
      selectedRect.top +
      selectedRect.height / 2 -
      (morphRect.top + morphRect.height / 2),
    scaleX: selectedRect.width / morphRect.width,
    scaleY: selectedRect.height / morphRect.height,
  };

  const polishDotsHost = document.querySelector("#sequence-dots");
  for (let i = 0; i < 72; i += 1) {
    const dot = document.createElement("i");
    dot.className = "sequence-dot";
    polishDotsHost.appendChild(dot);
  }
  const polishDots = [...document.querySelectorAll(".sequence-dot")];
  const spiralPos = polishDots.map((_, i) => {
    const arm = i % 6;
    const step = Math.floor(i / 6);
    const angle = arm * (Math.PI / 3) + step * 0.115 - 0.35;
    const radius = 36 + step * 21;
    return {
      x: 960 + Math.cos(angle) * radius,
      y: 500 + Math.sin(angle) * radius,
    };
  });
  const cubicPoint = (start, controlOne, controlTwo, end, t) => {
    const inverse = 1 - t;
    return {
      x:
        inverse ** 3 * start.x +
        3 * inverse ** 2 * t * controlOne.x +
        3 * inverse * t ** 2 * controlTwo.x +
        t ** 3 * end.x,
      y:
        inverse ** 3 * start.y +
        3 * inverse ** 2 * t * controlOne.y +
        3 * inverse * t ** 2 * controlTwo.y +
        t ** 3 * end.y,
    };
  };
  const pathBeadPos = polishDots.map((_, i) => {
    const progress = i / (polishDots.length - 1);
    const firstHalf = progress <= 0.5;
    const t = firstHalf ? progress * 2 : (progress - 0.5) * 2;
    const point = firstHalf
      ? cubicPoint(
          { x: 320, y: 530 },
          { x: 610, y: 260 },
          { x: 740, y: 800 },
          { x: 960, y: 530 },
          t,
        )
      : cubicPoint(
          { x: 960, y: 530 },
          { x: 1180, y: 260 },
          { x: 1330, y: 270 },
          { x: 1600, y: 530 },
          t,
        );
    return {
      x: point.x,
      y: point.y + ((i % 3) - 1) * 5,
    };
  });
  const polishSpriteState = { frame: 0 };
  const polishSprite = document.querySelector("#handoff-sprite");
  const paintPolishSprite = () => {
    const frame = Math.max(
      0,
      Math.min(24, Math.round(polishSpriteState.frame)),
    );
    const column = frame % 5;
    const row = Math.floor(frame / 5);
    polishSprite.style.backgroundPosition = `${-column * 208}px ${-row * 208}px`;
  };
  paintPolishSprite();
  const showPolished = (id, time) => {
    polishTl
      .set(".scene", { autoAlpha: 0 }, time)
      .set(id, { autoAlpha: 1 }, time);
  };

  gsap.set("#film-camera", { x: 0, y: 0, scale: 1, rotation: 0 });
  gsap.set(".scene", { autoAlpha: 0 });
  gsap.set(polishSeed, {
    x: promptStart.x,
    y: promptStart.y,
    scaleX: 0.3,
    scaleY: 1,
    borderRadius: 4,
    backgroundColor: "#11110f",
    autoAlpha: 0,
  });
  gsap.set("#seed-cap", { autoAlpha: 0, scaleX: 1, scaleY: 1 });
  gsap.set(polishPrompt, { clipPath: "inset(0 100% 0 0)" });
  gsap.set(".story-card", { y: 46, autoAlpha: 0, scale: 1 });
  gsap.set("#scrub-fill", { scaleX: 0 });
  gsap.set(polishResult, { scale: 1, rotation: 0, autoAlpha: 0 });
  gsap.set(polishMorph, { ...morphStart, autoAlpha: 0 });
  gsap.set(".morph-copy", { autoAlpha: 0 });
  gsap.set(".sequence-node", { y: 28, autoAlpha: 0, scale: 1 });
  gsap.set("#sequence-path", { strokeDashoffset: 1500, autoAlpha: 0 });
  gsap.set("#sequence-dots", {
    rotation: 0,
    transformOrigin: "960px 500px",
  });
  gsap.set(".phrase", { autoAlpha: 0 });
  gsap.set(phrasePromptWord, { y: 0, scale: 1, autoAlpha: 1 });
  gsap.set(phraseSequenceWord, { y: 126, scale: 1, autoAlpha: 0 });
  gsap.set(".result-stage-rule", { scaleX: 0 });
  gsap.set(".result-kicker,.result-title,.result-subtitle,.result-meta span", {
    autoAlpha: 0,
  });
  gsap.set(".result-sequence-step,.result-orbit-core,.result-orbit-node", {
    autoAlpha: 0,
  });
  gsap.set(".result-orbit-geometry", { scale: 0.78, rotation: -20 });
  gsap.set(polishDots, {
    x: centerTarget.x + 5,
    y: centerTarget.y + 26,
    scale: 0.08,
    autoAlpha: 0,
  });
  gsap.set(".peak-system,.peak-core,.peak-card", { autoAlpha: 0 });
  gsap.set(".peak-card", { scale: 0.12, x: 0, y: 0, rotation: 0 });
  gsap.set(".peak-core", { scale: 0.44, rotation: -8 });
  gsap.set(".peak-loop path", { strokeDashoffset: 2690 });
  gsap.set("#handoff-knot", {
    autoAlpha: 0,
    scale: 208 / 242,
    rotation: 0,
    transformOrigin: "50% 50%",
  });
  gsap.set("#lockup-line", { scaleX: 0 });

  showPolished("#ask-world", 0);
  polishTl
    .fromTo(
      ".chat-head",
      { x: -34, autoAlpha: 0 },
      { x: 0, autoAlpha: 1, duration: 0.52, ease: "power3.out" },
      0.08,
    )
    .fromTo(
      ".ask-line",
      { y: 36, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.64, ease: "power3.out" },
      0.28,
    )
    .fromTo(
      ".composer",
      { y: 44, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.62, ease: "power3.out" },
      0.36,
    )
    .set(polishSeed, { autoAlpha: 1 }, 0.5)
    .to(
      polishPrompt,
      { clipPath: "inset(0 0% 0 0)", duration: 1.18, ease: "steps(27)" },
      0.534,
    )
    .to(
      polishSeed,
      {
        x: promptStart.x + typedPromptWidth,
        duration: 1.18,
        ease: "steps(27)",
      },
      0.534,
    )
    .to(polishSeed, { autoAlpha: 0, duration: 0.06 }, 1.76)
    .to(polishSeed, { autoAlpha: 1, duration: 0.06 }, 1.88)
    .to(
      polishSeed,
      {
        x: sendTarget.x,
        y: sendTarget.y,
        scaleX: 3,
        scaleY: 0.58,
        borderRadius: "50%",
        duration: 0.13,
        ease: "power3.inOut",
      },
      1.91,
    )
    .to(
      polishSeed,
      { scaleX: 2.35, scaleY: 0.45, duration: 0.1, ease: "power2.in" },
      2.04,
    )
    .to(
      "#send-control",
      { scale: 0.82, duration: 0.1, ease: "power2.in" },
      2.04,
    )
    .to(
      polishSeed,
      { scaleX: 3, scaleY: 0.58, duration: 0.077, ease: "back.out(2)" },
      2.14,
    )
    .to(
      "#send-control",
      { scale: 1, duration: 0.077, ease: "back.out(2)" },
      2.14,
    )
    .to(".ask-orbit", { rotation: 34, duration: 2.1, ease: "none" }, 0.1);

  showPolished("#handoff-world", 2.217);
  polishTl
    .set("#film-camera", { x: 0, y: 0, scale: 1, rotation: 0 }, 2.217)
    .to(
      polishSeed,
      {
        x: centerTarget.x,
        y: centerTarget.y,
        scaleX: 3,
        scaleY: 0.58,
        duration: 0.4,
        ease: "power4.in",
      },
      2.217,
    )
    .fromTo(
      ".handoff-orbit",
      { scale: 0.28, rotation: -12 },
      { scale: 1, rotation: 0, duration: 0.72, ease: "power3.out" },
      2.27,
    )
    .set(polishSeed, { autoAlpha: 0 }, 2.61)
    .set("#handoff-sprite", { autoAlpha: 1, scale: 1, rotation: 0 }, 2.58)
    .to(
      polishSpriteState,
      {
        frame: 24,
        duration: 0.8,
        ease: "none",
        onUpdate: paintPolishSprite,
      },
      2.58,
    )
    .to(
      "#handoff-sprite",
      {
        autoAlpha: 0,
        scale: 242 / 208,
        duration: 0.28,
        ease: "power2.inOut",
      },
      3.38,
    )
    .to(
      "#handoff-knot",
      { autoAlpha: 1, scale: 1, duration: 0.28, ease: "power2.inOut" },
      3.38,
    )
    .fromTo(
      "#phrase-line",
      { x: -70, autoAlpha: 0 },
      { x: 0, autoAlpha: 1, duration: 0.66, ease: "power3.out" },
      3.67,
    )
    .to(
      "#handoff-knot",
      { scale: 0.72, autoAlpha: 0, duration: 0.42, ease: "power3.in" },
      5.55,
    )
    .to(
      ".handoff-orbit",
      { rotation: 24, scale: 1.08, duration: 2, ease: "sine.inOut" },
      3.8,
    );

  showPolished("#sequence-world", 6.088);
  polishTl
    .set("#film-camera", { x: 0, y: 0, scale: 1, rotation: 0 }, 6.088)
    .to(
      polishSeed,
      { scale: 0.08, autoAlpha: 0, duration: 0.28, ease: "power2.in" },
      6.09,
    )
    .to(
      polishDots,
      {
        x: (i) => spiralPos[i].x,
        y: (i) => spiralPos[i].y,
        scale: 1,
        autoAlpha: 1,
        duration: 0.92,
        stagger: 0.004,
        ease: "power3.out",
      },
      6.1,
    )
    .to("#sequence-dots", { rotation: 24, duration: 1.63, ease: "none" }, 6.45)
    .to(
      phrasePromptWord,
      { y: -126, autoAlpha: 0, duration: 0.24, ease: "power4.in" },
      7.56,
    )
    .set(phraseSequenceWord, { y: 126, scale: 1, autoAlpha: 1 }, 7.74)
    .to(phraseSequenceWord, { y: 0, duration: 0.44, ease: "power4.out" }, 7.74)
    .to(
      polishDots,
      {
        x: (i) => pathBeadPos[i].x,
        y: (i) => pathBeadPos[i].y,
        scale: 0.58,
        duration: 0.58,
        ease: "power3.inOut",
      },
      8.08,
    )
    .to(
      "#sequence-dots",
      { rotation: 0, duration: 0.58, ease: "power3.inOut" },
      8.08,
    )
    .set("#sequence-path", { autoAlpha: 1 }, 8.46)
    .to(
      "#sequence-path",
      { strokeDashoffset: 0, duration: 0.52, ease: "power2.inOut" },
      8.46,
    )
    .to(
      polishDots,
      { scale: 0.2, autoAlpha: 0, duration: 0.34, stagger: 0.002 },
      8.8,
    )
    .to(
      ".sequence-node",
      {
        y: 0,
        autoAlpha: 1,
        duration: 0.46,
        stagger: 0.1,
        ease: "power3.out",
      },
      8.86,
    )
    .to(
      ".sequence-node",
      { y: -8, duration: 0.22, stagger: 0.09, ease: "power2.out" },
      10.0,
    )
    .to(
      ".sequence-node",
      { y: 0, duration: 0.3, stagger: 0.09, ease: "back.out(1.5)" },
      10.22,
    )
    .to("#phrase-line", { autoAlpha: 0, duration: 0.24 }, 10.48)
    .set(
      polishSeed,
      {
        x: lockNodeTarget.x,
        y: lockNodeTarget.y,
        scaleX: 2.2,
        scaleY: 0.42,
        borderRadius: "50%",
        backgroundColor: "#10a37f",
        autoAlpha: 1,
      },
      10.7,
    )
    .to(
      polishSeed,
      {
        x: playheadStart.x,
        y: playheadStart.y,
        duration: 1.12,
        ease: "power3.inOut",
      },
      10.72,
    );

  showPolished("#build-world", 11.895);
  polishTl
    .set("#film-camera", { x: 0, y: 0, scale: 1, rotation: 0 }, 11.895)
    .to(
      polishSeed,
      {
        scaleX: 0.3,
        scaleY: 1.83,
        borderRadius: 3,
        duration: 0.22,
        ease: "power3.out",
      },
      11.895,
    )
    .set("#seed-cap", { autoAlpha: 1, scaleX: 3.333, scaleY: 0.546 }, 11.98)
    .to(
      ".story-card",
      {
        y: 0,
        autoAlpha: 1,
        duration: 0.52,
        stagger: 0.105,
        ease: "power3.out",
      },
      12.02,
    )
    .fromTo(
      ".prompt-rail",
      { x: 48, autoAlpha: 0 },
      { x: 0, autoAlpha: 1, duration: 0.54, ease: "power3.out" },
      12.04,
    )
    .to(
      polishSeed,
      {
        x: playheadEnd.x,
        y: playheadEnd.y,
        duration: 4.3,
        ease: "none",
      },
      12.24,
    )
    .to(".mini-orbit", { rotation: 220, duration: 4.6, ease: "none" }, 12.1)
    .fromTo(
      ".mini-bars i",
      { scaleX: 0.18 },
      { scaleX: 1, duration: 0.44, stagger: 0.15, ease: "power3.out" },
      12.22,
    )
    .to(
      ".mini-bars i",
      {
        scaleX: (i) => [0.62, 0.92, 0.48, 0.8][i],
        duration: 1.7,
        stagger: 0.09,
        ease: "sine.inOut",
      },
      13.18,
    )
    .to(
      ".mini-letter",
      { rotation: 7, scale: 1.05, duration: 2.2, ease: "sine.inOut" },
      12.35,
    )
    .to(
      ".mini-route path",
      { strokeDashoffset: 0, duration: 2.1, ease: "power2.inOut" },
      12.42,
    )
    .to(
      ".mini-player",
      { scale: 1.055, rotation: -1.5, duration: 2.3, ease: "sine.inOut" },
      12.3,
    )
    .to(
      "#film-camera",
      { x: -50, scale: 1.025, duration: 1.75, ease: "sine.inOut" },
      12.3,
    )
    .to(
      "#film-camera",
      { x: 0, y: 0, scale: 1, duration: 1.55, ease: "sine.inOut" },
      14.45,
    )
    .to(
      ".story-card",
      { y: -10, duration: 0.22, stagger: 0.1, ease: "power2.out" },
      15.12,
    )
    .to(
      ".story-card",
      { y: 0, duration: 0.3, stagger: 0.1, ease: "back.out(1.5)" },
      15.34,
    )
    .to(
      ".story-card.selected",
      { scale: 1.035, duration: 0.54, ease: "power2.inOut" },
      16.26,
    )
    .set("#seed-cap", { autoAlpha: 0 }, 16.54)
    .to(
      polishSeed,
      {
        x: localCenter(polishSelected).x,
        y: localCenter(polishSelected).y,
        scaleX: 2.2,
        scaleY: 0.42,
        borderRadius: "50%",
        duration: 0.34,
        ease: "power3.inOut",
      },
      16.54,
    )
    .set(polishMorph, { ...morphStart, autoAlpha: 1 }, 16.78)
    .set(polishSelected, { autoAlpha: 0 }, 16.8)
    .set(polishSeed, { autoAlpha: 0 }, 16.8)
    .to(
      polishMorph,
      {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        borderRadius: 54,
        duration: 1.2,
        ease: "power3.inOut",
      },
      16.8,
    )
    .to(
      ".morph-thumb",
      { scale: 0.72, duration: 1.02, ease: "power2.inOut" },
      16.86,
    )
    .to(
      ".morph-copy",
      { autoAlpha: 1, duration: 0.4, ease: "power2.out" },
      17.38,
    );

  showPolished("#result-world", 17.701);
  polishTl
    .set("#film-camera", { x: 0, y: 0, scale: 1, rotation: 0 }, 17.701)
    .set(polishResult, { autoAlpha: 1, scale: 1, rotation: 0 }, 17.96)
    .set(polishMorph, { autoAlpha: 0 }, 18.01)
    .fromTo(
      ".result-kicker",
      { x: -24, autoAlpha: 0 },
      { x: 0, autoAlpha: 1, duration: 0.46, ease: "power4.out" },
      17.98,
    )
    .fromTo(
      ".result-title",
      { x: -38, autoAlpha: 0 },
      { x: 0, autoAlpha: 1, duration: 0.62, ease: "power3.out" },
      18.04,
    )
    .fromTo(
      ".result-meta span",
      { y: -18, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.38, stagger: 0.06, ease: "power2.out" },
      18.08,
    )
    .to(
      ".result-stage-rule",
      { scaleX: 1, duration: 0.68, ease: "power3.out" },
      18.1,
    )
    .fromTo(
      ".result-subtitle",
      { y: 20, autoAlpha: 0 },
      { y: 0, autoAlpha: 1, duration: 0.5, ease: "power2.out" },
      18.24,
    )
    .fromTo(
      ".result-orbit-geometry",
      { scale: 0.78, rotation: -20 },
      { scale: 1, rotation: 0, duration: 0.86, ease: "power3.out" },
      18.08,
    )
    .to(
      resultRoutePath,
      { strokeDashoffset: 0, duration: 1.18, ease: "power2.out" },
      18.12,
    )
    .fromTo(
      ".result-orbit-core",
      { scale: 0.4, autoAlpha: 0 },
      { scale: 1, autoAlpha: 1, duration: 0.58, ease: "back.out(1.6)" },
      18.22,
    )
    .fromTo(
      resultOrbitNodes,
      {
        x: (i) => resultOrbitNodeOffsets[i].x,
        y: (i) => resultOrbitNodeOffsets[i].y,
        scale: 0.35,
        autoAlpha: 0,
      },
      {
        x: 0,
        y: 0,
        scale: 1,
        autoAlpha: 1,
        duration: 0.66,
        stagger: 0.055,
        ease: "power3.out",
      },
      18.28,
    )
    .fromTo(
      ".result-sequence-step",
      { y: 30, autoAlpha: 0 },
      {
        y: 0,
        autoAlpha: 1,
        duration: 0.36,
        stagger: 0.065,
        ease: "power4.out",
      },
      18.46,
    )
    .to("#scrub-fill", { scaleX: 1, duration: 3.18, ease: "none" }, 18.04)
    .to(
      ".result-orbit-geometry",
      { rotation: 34, duration: 2.48, ease: "none" },
      18.94,
    )
    .to(
      "#film-camera",
      { scale: 1.028, y: -8, duration: 3.08, ease: "sine.inOut" },
      18.08,
    )
    .to(
      "#film-camera",
      { x: 0, y: 0, scale: 1, duration: 0.36, ease: "sine.inOut" },
      21.16,
    )
    .to(
      "#result-world",
      { backgroundColor: "#122b4a", color: "#ffffff", duration: 0.36 },
      21.572,
    )
    .to(".result-grid", { autoAlpha: 0, duration: 0.28 }, 21.572)
    .to(".result-light-only", { autoAlpha: 0, duration: 0.24 }, 21.572)
    .to(
      polishResult,
      {
        backgroundColor: "#122b4a",
        borderColor: "#506783",
        scale: 0.84,
        duration: 0.42,
        ease: "power3.inOut",
      },
      21.572,
    )
    .to(".result-stage", { backgroundColor: "#122b4a", duration: 0.3 }, 21.572)
    .to(".result-title-main", { color: "#ffffff", duration: 0.2 }, 21.72)
    .to(".result-kicker", { color: "#b7b7b0", duration: 0.36 }, 21.572)
    .to(".result-ring-outer", { borderColor: "#ffffff", duration: 0.24 }, 21.7)
    .to(".result-ring-mid", { borderColor: "#506783", duration: 0.24 }, 21.7)
    .to(
      ".result-orbit-core",
      {
        backgroundColor: "#10a37f",
        borderColor: "#10a37f",
        duration: 0.28,
        ease: "power2.inOut",
      },
      21.66,
    )
    .to(".result-orbit-core small", { color: "#11110f", duration: 0.08 }, 21.66)
    .to(".dark-label", { autoAlpha: 1, duration: 0.44 }, 21.78)
    .to(
      polishResult,
      { scale: 0.78, rotation: -0.6, duration: 1.4, ease: "sine.inOut" },
      22.02,
    );

  const peakTargets = [
    [-640, -190, -5],
    [-300, -350, 4],
    [380, -250, 5],
    [-480, 250, 3],
    [430, 260, -4],
  ];
  polishTl
    .set(".peak-system", { autoAlpha: 1 }, 23.508)
    .to(
      polishResult,
      { scale: 0.58, autoAlpha: 0.16, duration: 0.5, ease: "power3.out" },
      23.508,
    )
    .to(
      ".peak-loop path",
      { strokeDashoffset: 0, duration: 1.18, ease: "power2.inOut" },
      23.508,
    )
    .to(
      ".peak-core",
      {
        scale: 1,
        rotation: 0,
        autoAlpha: 1,
        duration: 0.58,
        ease: "back.out(1.45)",
      },
      23.58,
    )
    .to(
      ".peak-card",
      {
        x: (i) => peakTargets[i][0],
        y: (i) => peakTargets[i][1],
        rotation: (i) => peakTargets[i][2],
        scale: 1,
        autoAlpha: 1,
        duration: 0.56,
        stagger: 0.075,
        ease: "power3.out",
      },
      23.66,
    )
    .to(".pc-one", { scale: 1.06, duration: 0.18, ease: "power2.out" }, 24.48)
    .to(".pc-one", { scale: 1, duration: 0.18, ease: "power2.in" }, 24.66)
    .to(".pc-two", { scale: 1.06, duration: 0.18, ease: "power2.out" }, 24.72)
    .to(".pc-two", { scale: 1, duration: 0.18, ease: "power2.in" }, 24.9)
    .to(".pc-three", { scale: 1.06, duration: 0.18, ease: "power2.out" }, 24.96)
    .to(".pc-three", { scale: 1, duration: 0.18, ease: "power2.in" }, 25.14)
    .to(".pc-four", { scale: 1.06, duration: 0.18, ease: "power2.out" }, 25.2)
    .to(".pc-four", { scale: 1, duration: 0.18, ease: "power2.in" }, 25.38)
    .to(".pc-five", { scale: 1.06, duration: 0.18, ease: "power2.out" }, 25.44)
    .to(".pc-five", { scale: 1, duration: 0.18, ease: "power2.in" }, 25.62)
    .to(
      ".peak-core",
      { rotation: 10, duration: 1.45, ease: "sine.inOut" },
      24.42,
    )
    .to(
      ".peak-card",
      {
        x: 0,
        y: 0,
        scale: 0.12,
        rotation: 0,
        autoAlpha: 0,
        duration: 0.62,
        stagger: 0.025,
        ease: "power4.in",
      },
      26.411,
    )
    .to(
      ".peak-core",
      { scale: 0.14, autoAlpha: 0, duration: 0.58, ease: "power4.in" },
      26.48,
    )
    .to(
      ".peak-loop path",
      { strokeDashoffset: -2690, duration: 0.66, ease: "power3.in" },
      26.44,
    )
    .to(
      polishResult,
      {
        autoAlpha: 1,
        scaleX: 0.52,
        scaleY: 0.028,
        rotation: 0,
        borderRadius: 99,
        backgroundColor: "#10a37f",
        borderColor: "#10a37f",
        duration: 0.48,
        ease: "power4.inOut",
      },
      26.54,
    )
    .to(
      ".result-stage,.result-control",
      { autoAlpha: 0, duration: 0.24 },
      26.54,
    )
    .to(".peak-loop", { autoAlpha: 0, duration: 0.3 }, 26.72)
    .to(".dark-label", { autoAlpha: 0, duration: 0.22 }, 26.72)
    .to(
      "#result-world",
      { backgroundColor: "#f7f7f3", color: "#11110f", duration: 0.46 },
      26.78,
    )
    .to(
      polishResult,
      {
        x: 0,
        y: -11.5,
        scaleX: 720 / 1420,
        scaleY: 5 / 830,
        borderWidth: 0,
        boxShadow: "none",
        duration: 0.34,
        ease: "power3.inOut",
      },
      27.02,
    );

  showPolished("#lockup-world", 27.379);
  polishTl
    .set("#film-camera", { x: 0, y: 0, scale: 1, rotation: 0 }, 27.379)
    .set(polishSeed, { autoAlpha: 0 }, 27.379)
    .set("#lockup-line", { scaleX: 1, autoAlpha: 1 }, 27.379)
    .to(
      "#lockup-line",
      { scaleX: 0.09, duration: 0.26, ease: "power4.in" },
      27.64,
    )
    .set("#lockup-line", { autoAlpha: 0 }, 27.9)
    .fromTo(
      "#lockup",
      { autoAlpha: 0, scale: 0.92 },
      { autoAlpha: 1, scale: 1, duration: 0.62, ease: "back.out(1.5)" },
      27.88,
    )
    .fromTo(
      "#tagline",
      { autoAlpha: 0, y: 22 },
      { autoAlpha: 1, y: 0, duration: 0.48, ease: "power3.out" },
      28.42,
    )
    .fromTo(
      "#provenance",
      { autoAlpha: 0, y: 18 },
      { autoAlpha: 1, y: 0, duration: 0.45, ease: "power3.out" },
      28.62,
    )
    .fromTo(
      ".lockup-orbit",
      { scale: 0.84, rotation: -8 },
      { scale: 1, rotation: 0, duration: 1.14, ease: "power3.out" },
      28.02,
    )
    .to(
      "#film-camera",
      { scale: 1.014, duration: 1.018, ease: "sine.inOut" },
      29.315,
    );
  window.__timelines["sequences-abstract-film"] = polishTl;
};
