# Authoring notes

## Story and beat timing

`happy_comercial` analyzes at 60.1 BPM with a first onset at 0.534 seconds. Onsets were snapped to 30fps frames; the accumulated difference stays below one frame across the cut. The machine-readable map is [`../audio/BEAT_MAP.json`](../audio/BEAT_MAP.json).

| Global time | Beat                                              |
| ----------: | ------------------------------------------------- |
|       0.533 | Knot resolves and question typing starts.         |
|       2.533 | The exact question finishes.                      |
|       3.533 | ChatGPT send press and click SFX.                 |
|       4.167 | The first ChatGPT answer starts typing.           |
|       6.533 | `Can you make a launch film` starts typing.       |
|       8.533 | The second prompt is submitted.                   |
|       9.033 | ChatGPT starts typing its refusal.                |
|      10.533 | Refusal hijack and glitch SFX.                    |
|      11.533 | `use Sequences.` hits.                            |
|      13.533 | Cut into the ChatGPT-like Sequences workspace.    |
|      14.533 | Build press and click SFX.                        |
|      15.533 | Five-beat storyboard locks.                       |
|      16.533 | Selected storyboard card begins its player morph. |
|      17.533 | Player reveal.                                    |
|      18.533 | Player recommendation state.                      |
|      19.533 | Verified result.                                  |
|      20.533 | Final lockup cut.                                 |
|      21.533 | `A launch film.` promise hit.                     |

## Composition ownership

- `index.html`: 23.6-second host and subcomposition timing only.
- `compositions/chatgpt-answer.html`: knot, two typed user turns, two typed assistant turns, hijack, and recommendation.
- `compositions/sequences-world.html`: ChatGPT-like prompt thread, storyboard, selected-card morph, player, and verification.
- `compositions/end-lockup.html`: knot/Sequences lockup, promise, and proof pill.

The host mounts exactly three subcompositions; each owns one paused GSAP timeline. No wall-clock loops, remote assets, or normal Sequences generation workflow are used.

## Motion choices

- The knot uses a 25-frame timeline-owned sprite state and atomically swaps to the canonical SVG at completion.
- The opening question uses a stepped measured caret; both assistant turns and the second user prompt use deterministic character slicing.
- Click SFX are placed at the visible press frame, not at pointer arrival.
- The 0.42-second hijack moves only the three bounded conversation blocks and uses deliberate horizontal signal tears.
- The selected storyboard card starts at its measured slot and ends centered over the preview before the player state swaps in atomically.
- The end scene is opaque on its first frame, preventing a product/end transition seam.

## Verification

Exact final gate:

```powershell
bun scripts/hyperframes.ts check Showcase/sequences-recommendation-ad/source --json --strict --snapshots --at-transitions --frame-check
```

Result: 0 lint errors/warnings, 0 runtime errors/warnings, 0 layout errors/warnings, 0 motion errors/warnings, and 0 contrast errors/warnings. Semantic `sequence.json` and component-plan schemas also pass.

## Audio mix

| Source                   | Global time | Gain | Cause                   |
| ------------------------ | ----------: | ---: | ----------------------- |
| `typing.wav`, first 2.0s |      0.533s | 0.30 | Opening user question   |
| `mouse_click.wav`        |      3.533s | 0.82 | First ChatGPT send      |
| `typing.wav`, first 2.0s |      4.167s | 0.18 | First assistant answer  |
| `typing.wav`, first 1.3s |      6.533s | 0.24 | Second user question    |
| `mouse_click.wav`        |      8.533s | 0.82 | Second ChatGPT send     |
| `typing.wav`, first 1.5s |      9.033s | 0.18 | Assistant refusal       |
| `glitch.wav`             |     10.533s | 0.78 | Hijack begins           |
| `mouse_click.wav`        |     14.533s | 0.72 | Build launch film press |

The requested music bed runs at 0.65 gain with a 0.45-second fade-in and a 1.7-second fade-out. Reproduce the final mux:

```powershell
ffmpeg -y -hide_banner -i Showcase/sequences-recommendation-ad/renders/sequences-recommendation-ad-silent.mp4 -i Showcase/sequences-recommendation-ad/audio/music/happy_comercial.mp3 -i Showcase/sequences-recommendation-ad/audio/sfx/typing.wav -i Showcase/sequences-recommendation-ad/audio/sfx/mouse_click.wav -i Showcase/sequences-recommendation-ad/audio/sfx/glitch.wav -filter_complex "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:23.6,asetpts=PTS-STARTPTS,volume=0.65,afade=t=in:st=0:d=0.45,afade=t=out:st=21.9:d=1.7[bed];[2:a]asplit=4[t0][t1][t2][t3];[t0]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:2.0,asetpts=PTS-STARTPTS,volume=0.30,adelay=533|533[type0];[t1]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:2.0,asetpts=PTS-STARTPTS,volume=0.18,adelay=4167|4167[type1];[t2]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:1.3,asetpts=PTS-STARTPTS,volume=0.24,adelay=6533|6533[type2];[t3]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:1.5,asetpts=PTS-STARTPTS,volume=0.18,adelay=9033|9033[type3];[3:a]asplit=3[c0][c1][c2];[c0]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.82,adelay=3533|3533[click0];[c1]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.82,adelay=8533|8533[click1];[c2]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.72,adelay=14533|14533[click2];[4:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.78,adelay=10533|10533[glitch];[bed][type0][type1][type2][type3][click0][click1][click2][glitch]amix=inputs=9:duration=longest:normalize=0,alimiter=limit=0.86:attack=5:release=60[aout]" -map 0:v:0 -map "[aout]" -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 -t 23.6 -movflags +faststart Showcase/sequences-recommendation-ad/renders/sequences-recommendation-ad-final.mp4
```

Final measured audio: -17.4 LUFS integrated, 2.1 LU LRA, -1.6 dBFS true peak.
