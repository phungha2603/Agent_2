import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderInput } from "./types.js";

export interface Renderer {
  /** Renders `final.mp4` and `thumbnail.png` into jobDir, whose files the composition reads by name. */
  render(jobDir: string, input: RenderInput, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<{ video: string; thumbnail: string }>;
}

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "remotion", "index.ts");

/**
 * Remotion: bundles the composition with the job folder as its public dir,
 * then renders H.264 + AAC and a still for the thumbnail. Remotion fetches
 * its own headless Chrome on first use (~100 MB) and ships its own ffmpeg.
 * Licence: free for individuals and companies of up to 3 people.
 */
export function createRemotionRenderer(): Renderer {
  return {
    async render(jobDir, input, onProgress, signal) {
      // Imported lazily: these pull in webpack and esbuild, which the rest of the dashboard never needs.
      const { bundle } = await import("@remotion/bundler");
      const { renderMedia, renderStill, selectComposition, makeCancelSignal } = await import("@remotion/renderer");
      const serveUrl = await bundle({
        entryPoint: ENTRY,
        publicDir: jobDir,
        // The sources use NodeNext-style ".js" import paths for .ts/.tsx files.
        webpackOverride: (config) => ({
          ...config,
          resolve: { ...config.resolve, extensionAlias: { ".js": [".tsx", ".ts", ".js"] } },
        }),
      });
      const inputProps = input as unknown as Record<string, unknown>;
      const cancel = makeCancelSignal();
      signal?.addEventListener("abort", () => cancel.cancel(), { once: true });

      const composition = await selectComposition({ serveUrl, id: "Video", inputProps });
      const video = path.join(jobDir, "final.mp4");
      await renderMedia({
        composition,
        serveUrl,
        codec: "h264",
        audioCodec: "aac",
        outputLocation: video,
        inputProps,
        cancelSignal: cancel.cancelSignal,
        onProgress: ({ progress }) => onProgress(Math.round(progress * 100)),
      });

      const still = await selectComposition({ serveUrl, id: "Thumbnail", inputProps });
      const thumbnail = path.join(jobDir, "thumbnail.png");
      await renderStill({ composition: still, serveUrl, output: thumbnail, inputProps, imageFormat: "png" });
      return { video, thumbnail };
    },
  };
}
