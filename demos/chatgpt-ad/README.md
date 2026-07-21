# This is ChatGPT · hand-authored launch film

A hand-authored 27.6-second, 1920x1080\@30fps HyperFrames film advertising ChatGPT,
composed in the grammar of `Video References/bold_openai_ad.mp4` (studied
frame-by-frame before authoring). It passes the pinned strict gate with zero errors and
zero warnings:

```
bun scripts/hyperframes.ts check demos/chatgpt-ad --json --strict --snapshots --at-transitions --frame-check
```

Rendered artifacts:

```
bun scripts/hyperframes.ts render demos/chatgpt-ad --quality high --workers 1 --output artifacts/chatgpt-ad.mp4
# + manual ffmpeg audio mux -> artifacts/chatgpt-ad-with-audio.mp4 (AAC 48kHz stereo, ffprobe-verified)
```

Like `demos/openai-launch/` (grammar reference) and the golden Slack demo (craft
reference), this is a **direction reference**: feed it to authoring agents as evidence
of what the bold-launch grammar looks like when it is executed with intent.

## Structure

| File                             | Role                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `index.html`                     | Host: editor hook, kinetic type, interstitial + three sub-composition mounts       |
| `compositions/composer.html`     | Scene 3: voice composer + 2x close-up press                                        |
| `compositions/work-world.html`   | Scene 5: ChatGPT planning a week over a painterly backdrop (energy peak)           |
| `compositions/end-lockup.html`   | Scene 6: dusk lockup with the reference-matched rose-to-knot unfurl                |
| `assets/chatgpt-knot-unfurl.png` | Seek-safe 5x5 sprite of the 25 authorized reference frames                         |
| `assets/backdrops/`              | wallpaper13 + wallpaper18 from `vendor/wallpapers` (MIT-cleared, license included) |

## Beat map (technique per beat)

| Beat                     | Time      | What to study                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor hook              | 0–4.4     | Dark window on white (bold's exact opening frame); caret-riding two-line `steps(n)` typewriter with baked mono advance (0.6em); anticipation blink before typing; syntax-colored payload `ask("anything")`; mild solved camera push (1.13) on a padded `#editor-world` reserve during the read hold                                                                                                                                                        |
| Kinetic type             | 4.4–8.2   | Blur-in word swaps, strictly one readable thought at a time ("anything." → "plans, ideas," → "real work?"); accent color on one word per beat; scale drift through the last hold; hard-kill sets after every exit                                                                                                                                                                                                                                          |
| Voice composer           | 8.2–12.6  | Heading + pill hierarchy; finite yoyo waveform; placeholder yielding to a caret typewriter with an advance tuned against the rendered frame (17.3px @ 30px Montserrat 600); **atomic match cut to a 2x close-up state of the same pill** for the operated press (cuts between zoom levels — the reference's close-up grammar — never a live camera pushing readable UI past the frame edge); the press ripple shares the pill's coordinate space with the send orb so their centers cannot drift; exit as one readable unit |
| Consequence interstitial | 12.6–14.0 | "and it gets to work." — the cause restated as one beat before the effect                                                                                                                                                                                                                                                                                                                                                                                  |
| Work world               | 14.0–21.4 | Photographic-backdrop product theater: the typed sentence lands verbatim as the user bubble (payload carried across the cut); panels assemble causally with clip-path wipes; fixed non-random week data; double shockwave + camAt-solved 1.08 push (focal: planner center → 1080,560) as the energy peak; consequence at rest — status pill match-cuts Planning… → "Week planned ✓" and the three Due blocks pulse once                                    |
| Dusk lockup              | 21.4–27.6 | wallpaper13 + contrast veil; the exact 25-frame rose-to-knot unfurl from `chatgpt_work_ad.mp4` at 1:36–1:38, followed by an atomic handoff to the canonical 2022–24 ChatGPT SVG path; name + discrete “Ask anything.” → “Do anything.” promise; ~4s breathing hold (`scale: 1.014`) on a **padded lockup group** so the breath never crosses the clipping edge                                                                                                                 |

## Strict-gate lessons this film adds (beyond `demos/openai-launch/README.md`)

- **`fromTo` parks its from-state under seek.** A visible from-state (shockwave ring,
  press ripple, pulse circle) shows up parked on screen at earlier sampled times. Use a
  mid-timeline `tl.set(...)` followed by `tl.to(...)` for one-shot decorative bursts;
  reserve `fromTo` for entrances whose from-state is invisible.
- **Carets and decorative rings take `pointer-events: none`.** Occlusion proofs use
  `elementsFromPoint()`; an opaque block caret riding the reveal edge otherwise reads as
  text occlusion. Cursors are text-free decoration, so removing them from the hit-test
  stack is the sanctioned fix (never on text containers).
- **Two readable states never crossfade — even two pills.** The status swap
  (Planning… → Week planned) must be a single-timestamp `set` swap plus a local pop; a
  pair of complementary clip-path wipes still samples as `content_overlap` mid-swap.
- **Close-ups are cuts, not zooms.** The reference's giant-composer moment is authored
  here as a second, natural-size state of the same object swapped atomically. A live 2x
  camera zoom would drag the pill across the root's clipping bounds (`container_overflow`).
- **A breathing full-frame lockup needs its own reserve.** `scale: 1.014` on a
  1920x1080 group overflows the root by ~13px; author the group 40/24px smaller and
  re-offset its children.

## Audio (manual mux, like the golden demo)

Bed: `vendor/audio/music/confident_commercial.mp3` (0.68 gain, 0.6s fade-in, 2.2s
fade-out). SFX placed only where the film visibly causes them:

| SFX                             | At     | Visible cause                |
| ------------------------------- | ------ | ---------------------------- |
| `typing.wav` (2.1s slice, 0.45) | 1.0s   | Editor typewriter            |
| `typing.wav` (1.6s slice, 0.38) | 9.3s   | Composer request typewriter  |
| `mouse_click.wav` (0.9)         | 11.78s | Close-up send press          |
| `woosh.wav` (0.85)              | 17.94s | Double shockwave peak        |
| `notification.wav` (0.8)        | 19.5s  | "Week planned ✓" status swap |

```
ffmpeg -i artifacts/chatgpt-ad.mp4 -i vendor/audio/music/confident_commercial.mp3 \
  -i vendor/audio/sfx/typing.wav -i vendor/audio/sfx/mouse_click.wav \
  -i vendor/audio/sfx/woosh.wav -i vendor/audio/sfx/notification.wav \
  -filter_complex "[1:a]aformat=channel_layouts=stereo,volume=0.68,afade=t=in:st=0:d=0.6,afade=t=out:st=25.4:d=2.2[bed];[2:a]aformat=channel_layouts=stereo,asplit=2[typ1in][typ2in];[typ1in]atrim=0:2.1,asetpts=PTS-STARTPTS,volume=0.45,adelay=1000|1000[typ1];[typ2in]atrim=0:1.6,asetpts=PTS-STARTPTS,volume=0.38,adelay=9300|9300[typ2];[3:a]aformat=channel_layouts=stereo,volume=0.9,adelay=11780|11780[clk];[4:a]aformat=channel_layouts=stereo,volume=0.85,adelay=17940|17940[wsh];[5:a]aformat=channel_layouts=stereo,volume=0.8,adelay=19500|19500[ntf];[bed][typ1][typ2][clk][wsh][ntf]amix=inputs=6:normalize=0[aout]" \
  -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -ar 48000 -t 27.6 \
  artifacts/chatgpt-ad-with-audio.mp4
```

## Assets

Fonts (Montserrat, IBM Plex Mono) and vendor runtimes are copied from
`fixtures/release-a/assets`. Backdrops are MIT-cleared wallpapers from
`vendor/wallpapers` (wallpaper18 for the day work-world, wallpaper13 for the dusk
lockup — the same day → dusk backdrop arc the reference uses). The knot animation is
the authorized reference sequence at 30fps, keyed to a transparent white sprite and
driven by HyperFrames timeline time; the resting state is the exact canonical SVG path
documented in `.agents/skills/sequences-saas-launch/references/codex-mark.md`.
