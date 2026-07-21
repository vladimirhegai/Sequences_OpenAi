import { useCallback, useEffect, useRef, useState } from "react";
import type { HyperframesPlayer } from "@hyperframes/player";
import { HyperframesViewer } from "./HyperframesViewer";

export interface TimelineClip {
  id: string;
  label: string;
  start: number;
  duration: number;
  color: string;
}

const CLIP_COLORS = ["#8da5ff", "#6f86ea", "#b9c5ff", "#9bd8c0"];

export function SequencesStudio({ source, label }: { source: string; label: string }) {
  const playerRef = useRef<HyperframesPlayer | null>(null);
  const sceneSignatureRef = useRef("");
  const [playerReady, setPlayerReady] = useState<HyperframesPlayer | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [clips, setClips] = useState<TimelineClip[]>([]);

  const handlePlayer = useCallback((player: HyperframesPlayer | null) => {
    playerRef.current = player;
    setPlayerReady(player);
    if (!player) {
      sceneSignatureRef.current = "";
      setPlaying(false);
      setTime(0);
      setDuration(0);
      setClips([]);
      return;
    }
    const nextDuration = player.duration > 0 ? player.duration : 0;
    setDuration(nextDuration);
    const nextClips = clipsForPlayer(player.scenes, nextDuration);
    sceneSignatureRef.current = sceneSignature(nextClips);
    setClips(nextClips);
  }, []);

  const handleTimeChange = useCallback((nextTime: number) => {
    setTime(nextTime);
    const player = playerRef.current;
    if (player) {
      if (player.duration > 0) setDuration(player.duration);
      setPlaying(!player.paused);
    }
  }, []);

  useEffect(() => {
    if (!playerReady) return;
    const syncScenes = (event?: Event) => {
      const eventScenes = (
        event as CustomEvent<{ scenes?: HyperframesPlayer["scenes"] }> | undefined
      )?.detail?.scenes;
      const nextDuration = playerReady.duration > 0 ? playerReady.duration : duration;
      const nextClips = clipsForPlayer(eventScenes ?? playerReady.scenes, nextDuration);
      const signature = sceneSignature(nextClips);
      if (signature !== sceneSignatureRef.current) {
        sceneSignatureRef.current = signature;
        setClips(nextClips);
      }
    };
    playerReady.addEventListener("scenes", syncScenes);
    syncScenes();
    const timer = window.setInterval(() => {
      setTime(playerReady.currentTime);
      setPlaying(!playerReady.paused);
      const nextDuration = playerReady.duration > 0 ? playerReady.duration : 0;
      if (nextDuration > 0) setDuration(nextDuration);
    }, 120);
    return () => {
      playerReady.removeEventListener("scenes", syncScenes);
      window.clearInterval(timer);
    };
  }, [duration, playerReady]);

  const seek = useCallback(
    (nextTime: number) => {
      const bounded = Math.max(0, Math.min(duration, nextTime));
      playerRef.current?.seek(bounded);
      setTime(bounded);
    },
    [duration],
  );

  const togglePlayback = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.paused) {
      player.play();
      setPlaying(true);
    } else {
      player.pause();
      setPlaying(false);
    }
  }, []);

  return (
    <section className="sequences-studio">
      <div className="studio-toolbar">
        <button
          className="transport-button"
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          disabled={!playerReady}
          onClick={togglePlayback}
        >
          {playing ? "Ⅱ" : "▶"}
        </button>
        <span className="studio-time">
          {formatTime(time)} <span>/</span> {formatTime(duration)}
        </span>
        <span className="studio-toolbar__hint">Drag the playhead or click the timeline</span>
      </div>

      <HyperframesViewer
        label={label}
        source={source}
        onPlayer={handlePlayer}
        onTimeChange={handleTimeChange}
      />

      <StudioTimeline
        ready={Boolean(playerReady)}
        duration={duration}
        time={time}
        clips={clips}
        onSeek={seek}
      />
    </section>
  );
}

export function StudioTimeline({
  ready,
  duration,
  time,
  clips,
  onSeek,
}: {
  ready: boolean;
  duration: number;
  time: number;
  clips: readonly TimelineClip[];
  onSeek: (time: number) => void;
}) {
  const marks = timelineMarks(duration);
  const playhead = `${duration > 0 ? (time / duration) * 100 : 0}%`;

  return (
    <div className="timeline" aria-label="Video timeline">
      <div className="timeline__header">
        <strong>Timeline</strong>
        <span>
          {!ready
            ? "Waiting for preview"
            : clips.length > 0
              ? `${clips.length} ${clips.length === 1 ? "scene" : "scenes"}`
              : "No scene markers"}
        </span>
      </div>
      {duration > 0 ? (
        <div className="timeline__body">
          <div className="timeline__labels" aria-hidden="true">
            <span>Video</span>
          </div>
          <div className="timeline__track">
            <div className="timeline__ruler" aria-hidden="true">
              {marks.map((mark) => (
                <span key={mark.value} style={{ left: mark.left }}>
                  {formatTime(mark.value)}
                </span>
              ))}
            </div>
            {clips.map((clip) => (
              <div
                key={clip.id}
                className="timeline-clip"
                style={{
                  left: `${(clip.start / duration) * 100}%`,
                  width: `${(clip.duration / duration) * 100}%`,
                  background: clip.color,
                }}
                title={`${clip.label} · ${formatTime(clip.start)}–${formatTime(clip.start + clip.duration)}`}
              >
                {clip.label}
              </div>
            ))}
            {clips.length === 0 ? (
              <span className="timeline__track-empty">No scene markers in this video</span>
            ) : null}
            <div className="timeline__playhead" style={{ left: playhead }} aria-hidden="true" />
            <input
              className="timeline__scrubber"
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={Math.min(time, duration)}
              aria-label="Timeline position"
              aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`}
              onChange={(event) => onSeek(Number(event.currentTarget.value))}
            />
          </div>
        </div>
      ) : (
        <div className="timeline__empty" role="status">
          The timeline will appear when the video preview reports its duration.
        </div>
      )}
    </div>
  );
}

function timelineMarks(duration: number): Array<{ value: number; left: string }> {
  if (duration <= 0) return [];
  const count = Math.min(6, Math.max(2, Math.ceil(duration) + 1));
  return Array.from({ length: count }, (_, index) => {
    const value = (duration * index) / (count - 1);
    return { value, left: `${(value / duration) * 100}%` };
  });
}

function normalizeScenes(
  scenes: readonly { id: string; start: number; duration: number }[],
): TimelineClip[] {
  return scenes.map((scene, index) => ({
    id: scene.id,
    label: humanize(scene.id, index),
    start: scene.start,
    duration: scene.duration,
    color: CLIP_COLORS[index % CLIP_COLORS.length]!,
  }));
}

function clipsForPlayer(
  scenes: readonly { id: string; start: number; duration: number }[],
  duration: number,
): TimelineClip[] {
  if (scenes.length > 0) return normalizeScenes(scenes);
  if (duration <= 0) return [];
  return [{ id: "composition", label: "Video", start: 0, duration, color: CLIP_COLORS[0]! }];
}

function sceneSignature(clips: readonly TimelineClip[]): string {
  return clips.map((clip) => `${clip.id}:${clip.start}:${clip.duration}`).join("|");
}

function humanize(value: string, index: number): string {
  const cleaned = value.replace(/[-_]+/g, " ").trim();
  return cleaned
    ? cleaned.replace(/\b\w/g, (letter) => letter.toUpperCase())
    : `Scene ${String(index + 1).padStart(2, "0")}`;
}

function formatTime(value: number): string {
  const safe = Math.max(0, Math.floor(value));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
