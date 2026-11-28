/** Data model of the Auto Video tab. Plain JSON: it is stored in data/video/ and sent to the dashboard as-is. */

export type Niche = "explainer" | "series";
/** short = vertical 9:16, about a minute (Shorts/Reels); long = horizontal 16:9, several minutes. */
export type VideoFormat = "short" | "long";

export type VideoStage =
  | "researching" // Gemini: research brief (explainer) or episode outline (series)
  | "writing" // Claude: the scene-by-scene script
  | "script_review" // CEO reads the script
  | "producing" // voice + images per scene
  | "rendering" // Remotion → final.mp4 + thumbnail.png
  | "final_review" // CEO watches the video
  | "publishing"
  | "published"
  | "failed"
  | "stopped";

export interface ScriptLine {
  /** "narrator" or one of the series' character names. */
  speaker: string;
  text: string;
}

export interface Scene {
  lines: ScriptLine[];
  /** English image prompt (AI image) or search words (stock photo) for this scene's picture. */
  visual: string;
  /** Short text shown big on screen (a key number, a term), optional. */
  onScreenText?: string;
}

export interface Script {
  title: string;
  description: string;
  tags: string[];
  /** Text on the thumbnail: a few words, not the title again. */
  thumbnailText: string;
  scenes: Scene[];
  /** 2–4 sentences of what happened, for the next episode's continuity (series only). */
  summary?: string;
}

export interface Character {
  name: string;
  /** Looks, for every image prompt: age, face, hair, clothes — stable across episodes. */
  look: string;
  personality: string;
  /** TTS voice name, e.g. vi-VN-Wavenet-B. Empty = the default voice. */
  voice?: string;
  /** Reference portrait under the series folder, passed to the image model for consistency. */
  refImage?: string;
}

export interface Series {
  id: string;
  title: string;
  premise: string;
  genre: string;
  /** One visual style for every image of the series, e.g. "2D anime, soft light, muted palette". */
  style: string;
  format: VideoFormat;
  characters: Character[];
  narratorVoice?: string;
  createdAt: string;
}

export interface SceneAsset {
  audio: string; // file name in the job folder
  image: string;
  durationSec: number;
  /** Caption chunks, seconds from the scene start. */
  captions: { start: number; end: number; text: string }[];
}

export interface PlatformPost {
  id: string;
  url: string;
  views?: number;
  statsAt?: string;
  error?: string;
}

export interface VideoJob {
  id: string;
  niche: Niche;
  format: VideoFormat;
  /** Explainer: the topic. Series: what this episode should be about (may be empty: continue the story). */
  topic: string;
  /** Extra instructions from the CEO when creating the job. */
  notes?: string;
  seriesId?: string;
  episode?: number;
  stage: VideoStage;
  research?: string;
  script?: Script;
  /** CEO revision requests, kept for every later rewrite. */
  feedback: string[];
  scenes?: SceneAsset[];
  output?: string;
  thumbnail?: string;
  publish: { youtube?: PlatformPost; facebook?: PlatformPost };
  progress: { at: string; text: string }[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RenderInput {
  format: VideoFormat;
  fps: number;
  title: string;
  thumbnailText: string;
  scenes: { audio: string; image: string; durationSec: number; onScreenText?: string; captions: SceneAsset["captions"] }[];
}
