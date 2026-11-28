import React from "react";
import { AbsoluteFill, Composition, Html5Audio, Img, Sequence, Still, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { RenderInput } from "../types.js";

/**
 * The two compositions the renderer uses: the video itself and its
 * thumbnail. Every file (audio, images) lives in the job folder, which the
 * bundler serves as the public dir, so `staticFile(name)` reaches it.
 *
 * The look follows the playbook's design rules: quiet chrome, one bright
 * thing (the picture), captions on a neutral backing, no glow or gradient
 * text, motion only where it carries meaning (a slow push-in on each frame).
 */

const FONT = '-apple-system, "Helvetica Neue", Arial, sans-serif';
const FADE_SEC = 0.35;

// Remotion types composition props as a plain record.
type Props = RenderInput & Record<string, unknown>;

const DEFAULT_PROPS: Props = { format: "long", fps: 30, title: "", thumbnailText: "", scenes: [] };

const size = (format: RenderInput["format"]) => (format === "short" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 });

function SceneView({ scene, index }: { scene: RenderInput["scenes"][number]; index: number }) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();
  const t = frame / fps;
  const progress = frame / Math.max(1, durationInFrames);
  // Alternate push-in and pull-out so consecutive frames don't feel identical.
  const scale = index % 2 === 0 ? 1 + 0.08 * progress : 1.08 - 0.08 * progress;
  const opacity = interpolate(t, [0, FADE_SEC], [0, 1], { extrapolateRight: "clamp" });
  const caption = scene.captions.find((c) => t >= c.start && t < c.end);
  const vertical = width < 1200;
  const unit = width / 100;
  return (
    <AbsoluteFill style={{ backgroundColor: "#111214", opacity }}>
      <AbsoluteFill style={{ transform: `scale(${scale})` }}>
        <Img src={staticFile(scene.image)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
      <Html5Audio src={staticFile(scene.audio)} />
      {scene.onScreenText && t < 3 ? (
        <div
          style={{
            position: "absolute",
            top: vertical ? unit * 14 : unit * 4,
            left: unit * 5,
            padding: `${unit * 1.2}px ${unit * 2}px`,
            borderRadius: unit * 1,
            background: "rgba(17,18,20,0.78)",
            color: "#f4f4f5",
            fontFamily: FONT,
            fontWeight: 500,
            fontSize: vertical ? unit * 6 : unit * 3,
            opacity: interpolate(t, [0, 0.3, 2.6, 3], [0, 1, 1, 0]),
          }}
        >
          {scene.onScreenText}
        </div>
      ) : null}
      {caption ? (
        <div style={{ position: "absolute", left: unit * 6, right: unit * 6, bottom: vertical ? unit * 30 : unit * 5, display: "flex", justifyContent: "center" }}>
          <span
            style={{
              background: "rgba(17,18,20,0.72)",
              color: "#ffffff",
              fontFamily: FONT,
              fontWeight: 500,
              fontSize: vertical ? unit * 5.6 : unit * 2.6,
              lineHeight: 1.3,
              padding: `${unit * 0.6}px ${unit * 1.4}px`,
              borderRadius: unit * 0.6,
              textAlign: "center",
            }}
          >
            {caption.text}
          </span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

export function VideoComp(props: Props) {
  const { fps } = useVideoConfig();
  let from = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#111214" }}>
      {props.scenes.map((scene, i) => {
        const frames = Math.max(1, Math.round(scene.durationSec * fps));
        const seq = (
          <Sequence key={i} from={from} durationInFrames={frames}>
            <SceneView scene={scene} index={i} />
          </Sequence>
        );
        from += frames;
        return seq;
      })}
    </AbsoluteFill>
  );
}

export function ThumbnailComp(props: Props) {
  const { width } = useVideoConfig();
  const unit = width / 100;
  const first = props.scenes[0];
  const vertical = props.format === "short";
  return (
    <AbsoluteFill style={{ backgroundColor: "#111214" }}>
      {first ? <Img src={staticFile(first.image)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
      <AbsoluteFill style={{ background: "linear-gradient(to top, rgba(17,18,20,0.85) 0%, rgba(17,18,20,0) 55%)" }} />
      <div
        style={{
          position: "absolute",
          left: unit * 5,
          right: unit * 5,
          bottom: unit * (vertical ? 12 : 5),
          color: "#ffffff",
          fontFamily: FONT,
          fontWeight: 600,
          fontSize: vertical ? unit * 11 : unit * 7.5,
          lineHeight: 1.05,
        }}
      >
        {props.thumbnailText}
      </div>
    </AbsoluteFill>
  );
}

export function Root() {
  return (
    <>
      <Composition
        id="Video"
        component={VideoComp}
        defaultProps={DEFAULT_PROPS}
        fps={30}
        width={1920}
        height={1080}
        durationInFrames={30}
        calculateMetadata={({ props }) => ({
          ...size(props.format),
          fps: props.fps,
          durationInFrames: Math.max(1, props.scenes.reduce((n, s) => n + Math.max(1, Math.round(s.durationSec * props.fps)), 0)),
        })}
      />
      <Still id="Thumbnail" component={ThumbnailComp} defaultProps={DEFAULT_PROPS} width={1280} height={720} calculateMetadata={({ props }) => (props.format === "short" ? { width: 1080, height: 1920 } : { width: 1280, height: 720 })} />
    </>
  );
}
