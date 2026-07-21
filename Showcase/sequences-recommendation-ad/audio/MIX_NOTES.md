# Audio sources and derivations

- `music/happy_comercial.mp3`: exact requested local master copied from `vendor/audio/music/happy_comercial.mp3`.
- Catalog ID: `happy-commercial`.
- SHA-256: `4e6182ef59452bf0ab01646af3d86480f10e9d71173cadac6623636374860bed`.
- Catalog analysis: 60.1 BPM, 0.9985-second beat, 3.9938-second bar, first beat at 0.534 seconds.
- `BEAT_MAP.json`: catalog onsets snapped to the nearest 30fps frame with every visual and causal SFX event recorded.
- `sfx/typing.wav`: local showcase typing source, trimmed independently for the opening question (0.533), first answer (4.167), follow-up question (6.533), and refusal (9.033).
- `sfx/mouse_click.wav`: local showcase click source, used at 3.533, 8.533, and 14.533 seconds.
- `sfx/glitch.wav`: locally synthesized 0.42-second 48kHz stereo noise/chirp cue, used at 10.533 seconds.
- `final-mix.m4a`: exact AAC stream extracted from the delivered final MP4.

Recreate `glitch.wav`:

```powershell
ffmpeg -y -f lavfi -i "anoisesrc=color=white:duration=0.42:sample_rate=48000" -f lavfi -i "sine=frequency=1380:duration=0.42:sample_rate=48000" -filter_complex "[0:a]highpass=f=850,lowpass=f=6200,volume=0.16,tremolo=f=28:d=0.86[n];[1:a]volume=0.045,tremolo=f=22:d=0.9[s];[n][s]amix=inputs=2:normalize=0,afade=t=in:st=0:d=0.015,afade=t=out:st=0.28:d=0.14,pan=stereo|c0=c0|c1=0.82*c0[out]" -map "[out]" -ar 48000 -ac 2 -c:a pcm_s16le Showcase/sequences-recommendation-ad/audio/sfx/glitch.wav
```

Delivered mix measurement: -17.4 LUFS integrated, 2.1 LU LRA, -1.6 dBFS true peak.
