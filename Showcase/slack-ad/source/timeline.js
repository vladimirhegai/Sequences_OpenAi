(function () {
  "use strict";
  const C = window.AD_CONFIG;
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));

  q("#too-tools").textContent = C.copy.overload[0];
  q("#too-handoffs").textContent = C.copy.overload[1];
  q("#no-momentum").innerHTML = 'No <span class="slack-gradient">momentum.</span>';

  // Typewriters reveal by animating width so the caret physically rides the
  // text edge. Measure each natural width once, then park the span at 0.
  function prepType(sel, text) {
    const el = q(sel);
    el.textContent = text;
    el.style.width = "auto";
    const w = Math.ceil(el.getBoundingClientRect().width);
    el.style.width = "0px";
    return w;
  }
  const messyW = prepType("#messy .typed", C.copy.messy);
  q("#messy .typewrap").style.width = `${messyW + 14}px`;
  const chanW = prepType("#channel-type", C.copy.channel);
  const m1W = prepType("#message-one .t", C.copy.question);
  const m2W = prepType("#message-two .t", C.copy.answer);

  // Geometry measured at identity transforms, before any tween runs.
  const suckTargets = qa(".tool-card,.notification").map((el) => {
    const r = el.getBoundingClientRect();
    return { el, dx: 960 - (r.left + r.width / 2), dy: 540 - (r.top + r.height / 2) };
  });
  const msg1r = q("#message-one p").getBoundingClientRect();
  const msg2r = q("#message-two p").getBoundingClientRect();
  const ZOOM = 2.3;
  // Camera math: screen = C + (Q - C) * s + (x, y); solve (x, y) so the focal
  // point Q lands at P. The camera element is positioned by left/top, so its
  // gsap x/y start at 0 and these are absolute.
  const camAt = (qx, qy, px, py, s) => ({ x: (px - 960) - (qx - 960) * s, y: (py - 540) - (qy - 540) * s });
  const mild = camAt(msg1r.left + 260, msg1r.top + 40, 960, 500, 1.12);
  const zoomIn = camAt(msg2r.left + 60, msg2r.top + 14, 830, 540, ZOOM);
  const pan = Math.min(m2W, 420) * ZOOM * 0.68;
  const nextR = q("#next-button").getBoundingClientRect();
  // The mark lands inside the phrase: "All in (mark) Slack." — the slot is a
  // reserved inline gap measured at rest.
  const slotR = q("#all-slack .mark-slot").getBoundingClientRect();
  const orbitR = q(".orbit-mark").getBoundingClientRect();
  const dock = {
    x: (slotR.left + slotR.width / 2) - (orbitR.left + orbitR.width / 2),
    y: (slotR.top + slotR.height / 2) - (orbitR.top + orbitR.height / 2),
  };

  const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
  // Initial state lives OUTSIDE the timeline. Zero-duration sets parked at
  // position 0 do not re-render reliably once the offline capture seeks back
  // to exactly 0 after visiting late times (representative pass runs before
  // the full pass), which left the entire opening scene hidden — a white
  // first act in the encode. CSS already hides every scene; these one-time
  // sets stage the opener and the timeline only ever changes state mid-film.
  gsap.set("#overload", { autoAlpha: 1 });
  gsap.set(".tool-card,.notification", { opacity: 0 });
  gsap.set("#too-tools,#too-handoffs,#no-momentum", { opacity: 0 });

  // 0.0–3.25 — workspaces pile up one by one; information outruns resolution.
  const toolStarts = [0.10, 0.42, 0.74, 1.06, 1.38, 1.70];
  qa(".tool-card").forEach((el, i) => {
    tl.fromTo(el, { opacity: 0, scale: .55, y: 120 },
      { opacity: 1, scale: 1, y: 0, duration: .72, ease: "back.out(1.55)" }, toolStarts[i]);
  });
  [".n1", ".n2", ".n3"].forEach((s, i) =>
    tl.fromTo(s, { opacity: 0, x: i % 2 ? -70 : 70, scale: .82 },
      { opacity: 1, x: 0, scale: 1, duration: .5, ease: "back.out(1.4)" }, 1.52 + i * .42));
  tl.fromTo(".tool-cloud", { scale: 1 }, { scale: 1.04, duration: 3.0, ease: "sine.inOut" }, 0.15);
  tl.fromTo("#too-tools", { opacity: 0, y: 40, filter: "blur(14px)" },
      { opacity: 1, y: 0, filter: "blur(0px)", duration: .55 }, 1.02)
    .to("#too-tools", { opacity: 0, y: -32, filter: "blur(10px)", duration: .34, ease: "power2.in" }, 1.96)
    .fromTo("#too-handoffs", { opacity: 0, y: 40, filter: "blur(14px)" },
      { opacity: 1, y: 0, filter: "blur(0px)", duration: .52 }, 2.10)
    .to("#too-handoffs", { opacity: 0, y: -32, filter: "blur(10px)", duration: .34, ease: "power2.in" }, 3.00);

  // 3.25–5.45 — the climax line lands while the pile stalls out.
  tl.fromTo("#no-momentum", { opacity: 0, scale: .8, filter: "blur(16px)" },
      { opacity: 1, scale: 1, filter: "blur(0px)", duration: .44, ease: "back.out(1.3)" }, 3.16)
    .to(".tool-cloud", { scale: 1.12, filter: "blur(5px)", opacity: .32, duration: .85, ease: "power3.inOut" }, 3.24)
    .to("#no-momentum", { scale: 1.04, duration: .3, ease: "power2.out" }, 3.86)
    .to("#no-momentum", { scale: 1, duration: .5, ease: "power2.inOut" }, 4.18);
  qa(".tool-card").forEach((el, i) => {
    tl.to(el, { keyframes: [{ x: -7 }, { x: 6 }, { x: -4 }, { x: 0 }], duration: .44, ease: "power1.inOut" }, 4.38 + i * .02);
  });

  // 5.45–7.35 — every scrap of the mess collapses into one point and becomes
  // the Slack mark: shockwave, then the eight official pieces bloom outward.
  suckTargets.forEach(({ el, dx, dy }, i) => {
    tl.to(el, { x: dx, y: dy, scale: .06, rotation: i % 2 ? 170 : -170, opacity: .65, duration: .6, ease: "power4.in" }, 5.02 + i * .028);
  });
  tl.to("#no-momentum", { opacity: 0, scale: 1.2, filter: "blur(10px)", duration: .34, ease: "power2.in" }, 5.14)
    .set("#unify", { autoAlpha: 1 }, 5.38)
    .fromTo("#shockwave", { scale: .1, opacity: .95 }, { scale: 5.4, opacity: 0, duration: .85, ease: "power2.out" }, 5.56)
    .fromTo("#shockwave2", { scale: .1, opacity: .8 }, { scale: 3.6, opacity: 0, duration: .7, ease: "power2.out" }, 5.68)
    .set("#overload", { autoAlpha: 0 }, 5.80)
    .fromTo("#hero-mark", { scale: .5, rotation: -18 }, { scale: 1, rotation: 0, duration: 1.05, ease: "back.out(1.35)" }, 5.56);
  qa("#hero-mark path").forEach((p, i) => {
    const b = p.getBBox();
    const dx = 61.4 - (b.x + b.width / 2);
    const dy = 61.4 - (b.y + b.height / 2);
    tl.fromTo(p, { x: dx * .94, y: dy * .94, scale: .1, opacity: 0, transformOrigin: "50% 50%" },
      { x: 0, y: 0, scale: 1, opacity: 1, duration: .68, ease: "back.out(1.7)" }, 5.58 + i * .055);
  });
  tl.to("#hero-mark", { scale: 1.025, duration: .22, ease: "power2.out" }, 6.72)
    .to("#hero-mark", { scale: 1, duration: .4, ease: "power2.inOut" }, 6.94);

  // 7.35–9.70 — the statement types with a live caret; the pointer commits.
  tl.to("#hero-mark", { y: -175, scale: .74, duration: .65, ease: "power3.inOut" }, 7.18)
    .set("#messy", { opacity: 1 }, 7.45)
    .fromTo("#messy .caret", { opacity: 0 }, { opacity: 1, duration: .08 }, 7.45)
    .to("#messy .typed", { width: messyW, duration: 1.15, ease: `steps(${C.copy.messy.length})` }, 7.55)
    .set("#messy .caret", { opacity: 0 }, 8.86)
    .set("#messy .caret", { opacity: 1 }, 9.06)
    .set("#messy .caret", { opacity: 0 }, 9.30)
    .fromTo("#cursor", { opacity: 0, left: 1520, top: 900 }, { opacity: 1, left: 972, top: 366, duration: .7, ease: "power3.inOut" }, 8.72)
    .to("#cursor", { scale: .82, duration: .1, ease: "power2.in", transformOrigin: "4px 4px" }, 9.44)
    .to("#cursor", { scale: 1, duration: .2, ease: "back.out(2)" }, 9.54)
    .to("#hero-mark", { scale: .69, duration: .1, ease: "power2.in" }, 9.44)
    .to("#hero-mark", { scale: .76, duration: .24, ease: "back.out(2.2)" }, 9.54);

  // 9.70–12.0 — the desktop fades up; the exact Slack create-channel flow.
  q("#channel-type").textContent = C.copy.channel;
  tl.set("#channel-scene", { autoAlpha: 1 }, 9.62)
    .fromTo("#channel-scene .wallpaper", { scale: 1.08 }, { scale: 1, duration: 2.4, ease: "sine.out" }, 9.62)
    .to("#unify", { autoAlpha: 0, duration: .3 }, 9.72)
    .fromTo("#channel-modal", { opacity: 0, y: 52, scale: .92 }, { opacity: 1, y: 0, scale: 1, duration: .55, ease: "back.out(1.25)" }, 9.80)
    .to("#channel-type", { width: chanW, duration: .58, ease: "steps(6)" }, 10.38)
    .to("#char-count", { innerText: 74, duration: .58, snap: { innerText: 1 }, ease: "none" }, 10.38)
    .to("#next-button", { backgroundColor: "#007a5a", duration: .22 }, 10.92)
    .fromTo("#cursor2", { opacity: 0, left: 1560, top: 960 }, { opacity: 1, left: nextR.left + 52, top: nextR.top + 14, duration: .55, ease: "power3.inOut" }, 10.86)
    .to("#cursor2", { scale: .82, duration: .1, ease: "power2.in", transformOrigin: "4px 4px" }, 11.34)
    .to("#cursor2", { scale: 1, duration: .2, ease: "back.out(2)" }, 11.44)
    .to("#next-button", { scale: .91, duration: .1, ease: "power2.in" }, 11.34)
    .to("#next-button", { scale: 1, duration: .2, ease: "back.out(2)" }, 11.44)
    .to("#channel-modal", { y: -28, opacity: 0, scale: .965, duration: .4, ease: "power2.in" }, 11.60)
    .to("#cursor2", { opacity: 0, duration: .2 }, 11.60);

  // 12.0–17.25 — the window opens on the same desktop; a mild push, then the
  // superzoom: dive into the reply as it types and pan right with the words.
  // Read holds: the question sits alone before the reply lands, the typed
  // reply holds at full zoom, and the reaction gets its own settled beat.
  tl.set("#workspace-scene", { autoAlpha: 1 }, 11.84)
    .fromTo("#workspace-scene .wallpaper", { scale: 1 }, { scale: 1.05, duration: 5.4, ease: "sine.inOut" }, 11.84)
    .set("#channel-scene", { autoAlpha: 0 }, 12.06)
    .fromTo("#slack-window", { opacity: 0, y: 74, scale: .9 }, { opacity: 1, y: 0, scale: 1, duration: .8, ease: "power4.out" }, 11.9)
    .fromTo("#message-one", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .42 }, 12.52)
    .fromTo("#message-one .tcaret", { opacity: 0 }, { opacity: 1, duration: .06 }, 12.56)
    .to("#message-one .t", { width: m1W, duration: .78, ease: `steps(${C.copy.question.length})` }, 12.64)
    .set("#message-one .tcaret", { opacity: 0 }, 13.52)
    .to("#workspace-camera", { x: mild.x, y: mild.y, scale: 1.12, duration: .7, ease: "power2.inOut" }, 13.32)
    .fromTo("#message-two", { opacity: 0, y: 25 }, { opacity: 1, y: 0, duration: .4 }, 14.08)
    .to("#workspace-camera", { x: zoomIn.x, y: zoomIn.y, scale: ZOOM, duration: .62, ease: "power3.inOut" }, 14.28)
    // Anticipation: the caret blinks in the empty reply while the camera dives.
    .fromTo("#message-two .tcaret", { opacity: 0 }, { opacity: 1, duration: .06 }, 14.18)
    .set("#message-two .tcaret", { opacity: 0 }, 14.48)
    .set("#message-two .tcaret", { opacity: 1 }, 14.70)
    .to("#message-two .t", { width: m2W, duration: .95, ease: `steps(${C.copy.answer.length})` }, 14.92)
    .to("#workspace-camera", { x: `-=${pan}`, duration: .95, ease: "power1.inOut" }, 14.92)
    .set("#message-two .tcaret", { opacity: 0 }, 15.93)
    // Zoomed read hold 15.87–16.30, pull back, then the reaction pops on a
    // settled frame and holds so the beat actually reads.
    .to("#workspace-camera", { x: 0, y: 0, scale: 1, duration: .68, ease: "power3.inOut" }, 16.30)
    .fromTo("#message-two .reaction", { opacity: 0, scale: .45 }, { opacity: 1, scale: 1, duration: .34, ease: "back.out(1.9)" }, 17.05);

  // 17.75–20.40 — parallel proof, no connective clutter, gentle parallax.
  tl.set("#proof", { autoAlpha: 1 }, 17.72).to("#workspace-scene", { autoAlpha: 0, duration: .28 }, 17.78)
    .fromTo(".decision", { opacity: 0, x: -130, y: 70, rotation: -3, scale: 1.08 },
      { opacity: 1, x: 0, y: 0, rotation: 0, scale: 1, duration: .7 }, 17.74)
    .fromTo(".conversation", { opacity: 0, x: 135, y: 100, rotation: 3, scale: 1.08 },
      { opacity: 1, x: 0, y: 0, rotation: 0, scale: 1, duration: .7 }, 18.08)
    .fromTo(".mini-msg", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: .45 }, 18.42)
    .fromTo(".channel-stack>*", { opacity: 0, x: 34 }, { opacity: 1, x: 0, duration: .35, stagger: .11 }, 18.82)
    .to(".decision", { y: -12, duration: 1.2, ease: "sine.inOut" }, 19.2)
    .to(".conversation", { y: 10, duration: 1.2, ease: "sine.inOut" }, 19.2)
    .to(".proof-card", { scale: .985, duration: .45, ease: "power2.inOut" }, 19.9);

  // 20.40–24.15 — the promise evolves in place; the mark docks beside it.
  tl.fromTo("#promise", { autoAlpha: 0 }, { autoAlpha: 1, duration: .36, ease: "power2.inOut" }, 20.16)
    .to("#proof", { autoAlpha: 0, duration: .38, ease: "power2.inOut" }, 20.18)
    .fromTo("#all-place", { opacity: 0, y: 44, scale: .97, filter: "blur(12px)" },
      { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", duration: .55 }, 20.24)
    .fromTo(".orbit-mark", { opacity: 0, scale: .15, rotation: -80 }, { opacity: 1, scale: .42, rotation: 0, duration: .7, ease: "back.out(1.5)" }, 21.0)
    .to("#all-place", { opacity: 0, y: -36, filter: "blur(10px)", duration: .36, ease: "power2.in" }, 21.82)
    .fromTo("#all-slack", { opacity: 0, y: 40, scale: .94 }, { opacity: 1, y: 0, scale: 1, duration: .55, ease: "back.out(1.25)" }, 22.02)
    .to(".orbit-mark", { x: dock.x, y: dock.y, scale: .66, duration: .62, ease: "power3.inOut" }, 22.08)
    .to("#all-slack", { scale: 1.025, duration: .27, ease: "power2.out" }, 22.6)
    .to("#all-slack", { scale: 1, duration: .48 }, 22.87)
    // Redundant focal pin across the final promise hold. It is pixel-aligned
    // with the authored claim and prevents a seek/capture opacity hole.
    .set("#all-slack-guard", { opacity: 1 }, 23.2)
    .set("#all-slack-guard", { opacity: 0 }, 23.98);

  // 24.15–28.0 — the real lockup lands; the hold breathes almost invisibly.
  tl.fromTo("#end", { autoAlpha: 0 }, { autoAlpha: 1, duration: .34, ease: "power2.inOut" }, 23.98)
    .to("#promise", { autoAlpha: 0, duration: .34, ease: "power2.inOut" }, 23.98);
  qa(".lockup-mark path").forEach((p, i) => {
    tl.fromTo(p, { scale: .35, opacity: 0, y: i < 4 ? -10 : 10, transformOrigin: "50% 50%" },
      { scale: 1, opacity: 1, y: 0, duration: .5, ease: "back.out(1.6)" }, 24.0 + i * .04);
  });
  tl.fromTo(".wordmark", { opacity: 0, x: 64, filter: "blur(16px)" },
      { opacity: 1, x: 0, filter: "blur(0px)", duration: .65 }, 24.36);
  // Sign-off: the tagline words cascade up, then one quiet dark highlight
  // sweeps left-to-right through the settled phrase.
  qa("#tagline span").forEach((w, i) => {
    tl.fromTo(w, { opacity: 0, y: 24, filter: "blur(10px)" },
      { opacity: 1, y: 0, filter: "blur(0px)", duration: .5 }, 24.88 + i * .14);
    tl.fromTo(w, { backgroundPosition: "100% 0%" },
      { backgroundPosition: "0% 0%", duration: 1.3, ease: "power1.inOut" }, 25.85 + i * .1);
  });
  tl.fromTo(".lockup", { scale: 1 }, { scale: 1.014, duration: 2.4, ease: "sine.inOut" }, 25.5)
    .to({}, { duration: .1 }, 27.9);

  window.__timeline = tl;
  window.__seek = (seconds) => {
    // Never land on exactly 0: a zero playhead is the one spot where GSAP's
    // backward-seek rendering of boundary tweens is order-ambiguous.
    const time = Math.max(0.001, Math.min(C.durationSec, seconds));
    tl.seek(time, false);
    // GSAP's zero-duration set can be crossed differently after arbitrary
    // forward seeks. Pin this overlap from absolute time so offline capture,
    // reverse seeking, and a fresh browser all produce the same visible seam.
    gsap.set("#all-slack-guard", { opacity: time >= 23.2 && time < 23.98 ? 1 : 0 });
    return tl.time();
  };
  tl.seek(0);
})();
