import { useEffect, useRef, useState } from "react";
import type { HyperframesPlayer } from "@hyperframes/player";

export interface HyperframesViewerProps {
  label: string;
  source: string | null;
  badge?: string;
}

type ViewerState = "loading" | "ready" | "error";

/**
 * Hosts the official Hyperframes web component without weakening the authored
 * composition boundary. The server-issued source URL is deliberately
 * capability-scoped so relative composition assets remain in the same tree.
 */
export function HyperframesViewer({ label, source, badge }: HyperframesViewerProps) {
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

    // Hyperframes defaults to allow-same-origin for Studio integrations. Review
    // playback is intentionally less privileged: the runtime communicates with
    // the real player through its postMessage bridge.
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.title = label;

    player.setAttribute("controls", "");
    player.setAttribute("width", "1920");
    player.setAttribute("height", "1080");
    player.setAttribute("shader-loading", "player");
    player.setAttribute("aria-label", label);
    player.setAttribute("src", source);

    const onReady = () => setState("ready");
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setError(detail?.message ?? "The Hyperframes composition could not be loaded.");
      setState("error");
    };

    player.addEventListener("ready", onReady);
    player.addEventListener("error", onError);
    host.replaceChildren(player);

    return () => {
      player.removeEventListener("ready", onReady);
      player.removeEventListener("error", onError);
      player.remove();
    };
  }, [label, source]);

  return (
    <section className="viewer" aria-label={label}>
      <div className="viewer__heading">
        <span>{label}</span>
        {badge ? <span className="status-tag status-tag--neutral">{badge}</span> : null}
      </div>
      <div className="viewer__frame">
        <div ref={hostRef} className="viewer__host" />
        {state === "loading" ? (
          <div className="viewer__notice" role="status">
            Loading the Hyperframes runtime…
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
