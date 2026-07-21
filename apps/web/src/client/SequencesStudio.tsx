import { useState } from "react";
import { HyperframesViewer } from "./HyperframesViewer";

export type SequencesStudioProps =
  | { mode: "composition"; source: string; label: string }
  | { mode: "video"; label: string; mediaSource: string; poster?: string };

export function SequencesStudio(props: SequencesStudioProps) {
  if (props.mode === "video") {
    return (
      <NativeVideoStudio
        mediaSource={props.mediaSource}
        poster={props.poster ?? null}
        label={props.label}
      />
    );
  }

  return (
    <section className="sequences-studio">
      <HyperframesViewer label={props.label} source={props.source} controls allowFullscreen />
    </section>
  );
}

function NativeVideoStudio({
  mediaSource,
  poster,
  label,
}: {
  mediaSource: string;
  poster: string | null;
  label: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <section className="sequences-studio sequences-studio--native">
      <section className="viewer" aria-label={label}>
        <div className="viewer__frame viewer__frame--video">
          <video
            key={mediaSource}
            src={mediaSource}
            {...(poster ? { poster } : {})}
            controls
            controlsList="nodownload"
            preload="metadata"
            playsInline
            aria-label={label}
            onError={() => setFailed(true)}
          />
          {failed ? (
            <div className="viewer__notice viewer__notice--error" role="alert">
              <strong>Showcase unavailable</strong>
              <span>The verified showcase video could not be loaded.</span>
            </div>
          ) : null}
        </div>
      </section>
    </section>
  );
}
