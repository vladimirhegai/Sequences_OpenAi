# Audio mix notes

The 24-second master uses the requested `commercial_jazz.mp3` from its first sample. Music fades in over 350ms and out over the last 1.3 seconds. The derived mix is AAC-LC, 48kHz stereo, measured at -15.3 LUFS integrated and -1.3 dBFS true peak after encoding.

## Causal placements

| Source             | Placement(s)                            | Mix role                                        |
| ------------------ | --------------------------------------- | ----------------------------------------------- |
| `typing.wav`       | 0.550–2.250, 3.520–6.780, 14.880–16.500 | User entry, assistant stream, Canvas refinement |
| `mouse_click.wav`  | 2.507, 8.638, 12.724, 16.811            | Send, Sources, Canvas, refine                   |
| `woosh.wav`        | 12.980, 20.530                          | Canvas handoff and product-to-lockup transition |
| `notification.wav` | 17.480                                  | Working document updated                        |

Typing sits 17–18dB below its source, clicks at -4dB, whooshes at -9dB, and the notification at -8dB before the final bus. The jazz bed is reduced 2dB, then the combined bus uses a safety limiter and -16 LUFS loudness normalization.

## Rebuild

The inputs are, in order: music, typing, click, woosh, notification. The mix uses three trimmed typing regions, four delayed click copies, two delayed whoosh copies, and one delayed notification. Recreate it with the placements above, then mux without re-encoding video:

```powershell
ffmpeg -y -i Showcase/chatgpt-native-story/renders/silent.mp4 -i Showcase/chatgpt-native-story/audio/final-mix.m4a -map 0:v:0 -map 1:a:0 -c:v copy -c:a copy -t 24 -movflags +faststart -map_metadata -1 Showcase/chatgpt-native-story/renders/final.mp4
```
