import { useEffect, useRef, useState } from "react";
import type { HyperframesPlayer } from "@hyperframes/player";

export interface HyperframesViewerProps {
  label: string;
  source: string | null;
  badge?: string;
  controls?: boolean;
  allowFullscreen?: boolean;
  onPlayer?: (player: HyperframesPlayer | null) => void;
  onTimeChange?: (time: number) => void;
}

type ViewerState = "loading" | "ready" | "error";

/**
 * Hosts the real HyperFrames player. The surrounding Sequences shell owns the
 * prompt and library chrome; HyperFrames still owns composition playback.
 */
export function HyperframesViewer({
  label,
  source,
  badge,
  controls = true,
  allowFullscreen = false,
  onPlayer,
  onTimeChange,
}: HyperframesViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ViewerState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !source) {
      setState("error");
      setError("No composition source was provided by the local server.");
      return;
    }

    setState("loading");
    setError(null);

    const player = document.createElement("hyperframes-player") as HyperframesPlayer;
    const iframe = player.iframeElement;
    iframe.title = label;

    if (controls) player.setAttribute("controls", "");
    player.setAttribute("width", "1920");
    player.setAttribute("height", "1080");
    player.setAttribute("shader-loading", "player");
    player.setAttribute("aria-label", label);
    player.setAttribute("src", source);

    const onReady = () => {
      setState("ready");
      onPlayer?.(player);
    };
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setError(
        detail?.message?.replace(/hyperframes/gi, "video engine") ??
          "The video preview could not be loaded.",
      );
      setState("error");
    };
    const onTimeUpdate = (event: Event) => {
      const currentTime = (event as CustomEvent<{ currentTime?: number }>).detail?.currentTime;
      if (typeof currentTime === "number" && Number.isFinite(currentTime))
        onTimeChange?.(currentTime);
    };

    player.addEventListener("ready", onReady);
    player.addEventListener("error", onError);
    player.addEventListener("timeupdate", onTimeUpdate);
    host.replaceChildren(player);

    return () => {
      onPlayer?.(null);
      player.removeEventListener("ready", onReady);
      player.removeEventListener("error", onError);
      player.removeEventListener("timeupdate", onTimeUpdate);
      player.remove();
    };
  }, [controls, label, onPlayer, onTimeChange, source]);

  return (
    <section className="viewer" aria-label={label}>
      <div className="viewer__heading">
        <span>{label}</span>
        {badge ? <span className="status-tag">{badge}</span> : null}
        <span className="viewer__state">{state}</span>
      </div>
      <div className="viewer__frame">
        <div ref={hostRef} className="viewer__host" />
        {allowFullscreen ? (
          <button
            className="viewer__fullscreen"
            type="button"
            aria-label="Enter full screen"
            title="Full screen"
            onClick={() => {
              const player = hostRef.current?.querySelector("hyperframes-player");
              void player?.requestFullscreen().catch(() => undefined);
            }}
          >
            <span aria-hidden="true">&#x26F6;</span>
          </button>
        ) : null}
        {state === "loading" ? (
          <div className="viewer__notice" role="status">
            Loading preview…
          </div>
        ) : null}
        {state === "error" ? (
          <div className="viewer__notice viewer__notice--error" role="alert">
            <strong>Preview unavailable</strong>
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
