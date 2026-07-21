# The ChatGPT/OpenAI knot and its rose-to-knot unfurl

Use this reference whenever a film needs the legacy ChatGPT/OpenAI six-loop knot. A
proven implementation lives in `demos/chatgpt-ad/compositions/end-lockup.html`; its
25-frame transparent sprite is
`demos/chatgpt-ad/assets/chatgpt-knot-unfurl.png`.

Do not substitute six rotated capsules. That construction produces an asterisk/flower,
not the interlocking knot. The real motion begins as a compact six-petal rose, untwists
and expands with nearly constant band thickness for about 0.8 seconds, then rests on the
canonical mark with no bounce.

## Exact final geometry

Use this path verbatim. It is the canonical 2022-24 ChatGPT/OpenAI knot silhouette in a
320 by 320 viewBox, including the six woven counters and central hexagon:

```html
<svg id="gpt-mark-final" viewBox="0 0 320 320" aria-hidden="true">
  <path
    fill="#ffffff"
    d="m297.06 130.97c7.26-21.79 4.76-45.66-6.85-65.48-17.46-30.4-52.56-46.04-86.84-38.68-15.25-17.18-37.16-26.95-60.13-26.81-35.04-.08-66.13 22.48-76.91 55.82-22.51 4.61-41.94 18.7-53.31 38.67-17.59 30.32-13.58 68.54 9.92 94.54-7.26 21.79-4.76 45.66 6.85 65.48 17.46 30.4 52.56 46.04 86.84 38.68 15.24 17.18 37.16 26.95 60.13 26.8 35.06.09 66.16-22.49 76.94-55.86 22.51-4.61 41.94-18.7 53.31-38.67 17.57-30.32 13.55-68.51-9.94-94.51zm-120.28 168.11c-14.03.02-27.62-4.89-38.39-13.88.49-.26 1.34-.73 1.89-1.07l63.72-36.8c3.26-1.85 5.26-5.32 5.24-9.07v-89.83l26.93 15.55c.29.14.48.42.52.74v74.39c-.04 33.08-26.83 59.9-59.91 59.97zm-128.84-55.03c-7.03-12.14-9.56-26.37-7.15-40.18.47.28 1.3.79 1.89 1.13l63.72 36.8c3.23 1.89 7.23 1.89 10.47 0l77.79-44.92v31.1c.02.32-.13.63-.38.83l-64.41 37.19c-28.69 16.52-65.33 6.7-81.92-21.95zm-16.77-139.09c7-12.16 18.05-21.46 31.21-26.29 0 .55-.03 1.52-.03 2.2v73.61c-.02 3.74 1.98 7.21 5.23 9.06l77.79 44.91-26.93 15.55c-.27.18-.61.21-.91.08l-64.42-37.22c-28.63-16.58-38.45-53.21-21.95-81.89zm221.26 51.49-77.79-44.92 26.93-15.54c.27-.18.61-.21.91-.08l64.42 37.19c28.68 16.57 38.51 53.26 21.94 81.94-7.01 12.14-18.05 21.44-31.2 26.28v-75.81c.03-3.74-1.96-7.2-5.2-9.06zm26.8-40.34c-.47-.29-1.3-.79-1.89-1.13l-63.72-36.8c-3.23-1.89-7.23-1.89-10.47 0l-77.79 44.92v-31.1c-.02-.32.13-.63.38-.83l64.41-37.16c28.69-16.55 65.37-6.7 81.91 22 6.99 12.12 9.52 26.31 7.15 40.1zm-168.51 55.43-26.94-15.55c-.29-.14-.48-.42-.52-.74v-74.39c.02-33.12 26.89-59.96 60.01-59.94 14.01 0 27.57 4.92 38.34 13.88-.49.26-1.33.73-1.89 1.07l-63.72 36.8c-3.26 1.85-5.26 5.31-5.24 9.06l-.04 89.79zm14.63-31.54 34.65-20.01 34.65 20v40.01l-34.65 20-34.65-20z"
  ></path>
</svg>
```

Recolor only with `fill`. Never stretch the SVG, use it below about 64px in a 1080p
frame, or place another symbol inside its central hexagon.

## Exact unfurl

Prefer the supplied sprite over redrawing the moving topology. It contains 25 frames
at 30fps from the authorized reference, cropped to 160 by 160, keyed from black-on-white
to white-on-transparent, scaled to 208px cells, and tiled 5 by 5. Copy the asset into the
candidate and animate one CSS background; do not use an autoplay GIF/WebP because it is
not seek-safe.

```css
#gpt-mark-sprite {
  width: 208px;
  height: 208px;
  background: url("assets/chatgpt-knot-unfurl.png") 0 0 / 1040px 1040px no-repeat;
  opacity: 0;
  pointer-events: none;
}
```

```js
const sprite = document.querySelector("#gpt-mark-sprite");
const spriteState = { frame: 0 };
const paintSpriteFrame = () => {
  const frame = Math.max(0, Math.min(24, Math.round(spriteState.frame)));
  sprite.style.backgroundPosition = `${-(frame % 5) * 208}px ${-Math.floor(frame / 5) * 208}px`;
};
paintSpriteFrame();
tl.fromTo(sprite, { opacity: 0 }, { opacity: 1, duration: 0.08 }, T);
tl.to(spriteState, { frame: 24, duration: 0.8, ease: "none", onUpdate: paintSpriteFrame }, T);
tl.set(sprite, { opacity: 0 }, T + 0.81);
tl.set("#gpt-mark-final", { opacity: 1 }, T + 0.81);
```

The vector replacement must occupy the same center and visible diameter as the last
sprite frame so the handoff is invisible. A quiet pulse may begin after the replacement;
name and tagline can follow at about `T + 0.85` and `T + 1.15`. Keep the long final hold.

## Asset regeneration

If the authorized source must be regenerated, use the same crop and frame window:

```bash
ffmpeg -ss 97.30 -t 0.84 -i chatgpt_work_ad.mp4 \
  -f lavfi -i "color=c=white:s=160x160:r=30:d=0.84" \
  -filter_complex "[0:v]fps=30,crop=160:160:280:560,format=gray,negate[mask];[1:v][mask]alphamerge,scale=208:208:flags=lanczos,tile=5x5:nb_frames=25" \
  -frames:v 1 chatgpt-knot-unfurl.png
```

## Rules

- The sprite is the moving subject; the exact SVG is the resting subject. They never
  coexist visibly beyond their same-frame atomic handoff.
- Timeline time owns the sprite frame. No timers, CSS animation, GIF playback, or
  requestAnimationFrame loop.
- Do not add spring overshoot or rotation. The reference untwists and grows smoothly,
  then stops.
- On a photographic background, use the transparent sprite and SVG. Never fake weave
  gaps with a solid casing color sampled from one patch of the image.
