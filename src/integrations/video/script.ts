import type { Character, Scene, Script, Series, VideoFormat, VideoJob } from "./types.js";

/**
 * Prompts and parsing for the writing stages. Gemini researches (explainer)
 * or outlines the episode (series); Claude writes the final script as JSON.
 * Every prompt pushes toward what YouTube's and Meta's monetization rules
 * reward: one clear original angle per video, no mass-produced template text.
 */

const LENGTH: Record<VideoFormat, string> = {
  short: "SHORT vertical video: 130–170 spoken words in total, 5–9 scenes (about 60 seconds)",
  long: "LONG horizontal video: 900–1200 spoken words in total, 20–35 scenes (about 6–8 minutes)",
};

const SAFETY = [
  "Original work only: no copied text, no existing films' plots or characters, no real people's likeness or names as characters, no brand logos.",
  "No graphic violence, gore, sexual content, or shock tactics meant to upset viewers.",
  "No medical, financial or legal advice presented as fact for the viewer to act on.",
].join("\n- ");

export function bibleText(s: Series): string {
  return [
    `Title: ${s.title}`,
    `Genre: ${s.genre}`,
    `Premise: ${s.premise}`,
    `Visual style: ${s.style}`,
    `Characters:\n${s.characters.map((c) => `- ${c.name}: ${c.look}. Personality: ${c.personality}`).join("\n")}`,
  ].join("\n");
}

export function researchPrompt(job: VideoJob): string {
  return `RESEARCH: You are the research desk of a Vietnamese-language channel (YouTube + Facebook) that explains knowledge.
Topic: ${job.topic}
Format: ${LENGTH[job.format]}
${job.notes ? `Notes from the channel owner: ${job.notes}\n` : ""}
Write a research brief in Vietnamese, plain text, no preamble:
1. The angle: the one question this video answers and why a viewer would care (a concrete everyday hook, not clickbait).
2. 6–12 key facts. For each: how certain it is and what kind of source supports it. Mark anything disputed or uncertain. Never invent numbers, dates or quotes.
3. Common misconceptions worth correcting.
4. One simple analogy or example that makes the core idea click.
5. What NOT to say: claims that would be misleading or unsafe.`;
}

export function outlinePrompt(job: VideoJob, series: Series, previous: { episode: number; summary: string }[]): string {
  return `OUTLINE: You are the writers' room of an original Vietnamese AI-animated series.
--- Series bible ---
${bibleText(series)}
--- Previous episodes ---
${previous.length ? previous.map((p) => `Episode ${p.episode}: ${p.summary}`).join("\n") : "(none — this is episode 1)"}
--- This episode ---
Episode ${job.episode}. ${job.topic ? `The owner's idea for it: ${job.topic}` : "Continue the story naturally from the previous episode."}
Format: ${LENGTH[job.format]}
${job.notes ? `Notes from the owner: ${job.notes}\n` : ""}
Write the outline in Vietnamese, plain text, no preamble: a one-line logline; 4–8 beats (who is in each, what changes); the emotional turn; the hook that makes viewers want the next episode.
Keep every character consistent with the bible and with what already happened.
- ${SAFETY}`;
}

export function scriptPrompt(opts: {
  job: VideoJob;
  series?: Series;
  brief: string;
  imageSource: "ai" | "stock";
  previousScript?: Script;
}): string {
  const { job, series, brief, imageSource } = opts;
  const speakers = series ? `"narrator" or exactly one of: ${series.characters.map((c) => JSON.stringify(c.name)).join(", ")}` : `always "narrator"`;
  const visual =
    imageSource === "stock"
      ? `2–4 English search words for a stock photo that fits the scene (e.g. "city traffic night"). Stock photos cannot show specific people or diagrams, so pick concrete scenery or objects.`
      : series
        ? `an English image prompt for this scene's single frame: setting, which characters (by name), their pose and expression, camera angle, lighting. Do not describe the characters' looks or the art style — those are added automatically.`
        : `an English image prompt for one illustrative frame: subject, composition, lighting. No text inside the image.`;
  const revision = opts.previousScript
    ? `\n--- Your previous draft (rewrite it; keep what works) ---\n${JSON.stringify(opts.previousScript)}\n--- Owner's revision requests (every one must be done) ---\n${job.feedback.map((f) => `- ${f}`).join("\n")}\n`
    : job.feedback.length
      ? `\n--- Owner's requests (every one must be done) ---\n${job.feedback.map((f) => `- ${f}`).join("\n")}\n`
      : "";
  return `VIDEO SCRIPT: Write the final script of one ${series ? `episode (episode ${job.episode}) of an original series` : "explainer video"} for a Vietnamese channel on YouTube and Facebook.
${series ? `--- Series bible ---\n${bibleText(series)}\n` : ""}--- ${series ? "Episode outline" : "Research brief"} ---
${brief}
${job.notes ? `--- Notes from the owner ---\n${job.notes}\n` : ""}${revision}
Rules:
- Length: ${LENGTH[job.format]}.
- Every spoken line, title, description, tags, thumbnailText, onScreenText and summary in natural spoken Vietnamese. Only "visual" is in English.
- The first scene opens on the concrete question or conflict within 3 seconds — no greeting, no "xin chào các bạn".
- speaker: ${speakers}.${series ? "" : " Every claim must come from the research brief; say plainly when something is uncertain."}
- Each scene: 1–4 lines and one picture. visual: ${visual}
- onScreenText (optional): at most 6 words — a key number or term, not a repeat of the line.
- title: at most 70 characters, honest — it must not promise what the video does not deliver.
- description: 2–4 sentences, then 3–5 hashtags on the last line.
- tags: 5–12 short tags. thumbnailText: at most 5 words, different from the title.
${series ? '- summary: 2–4 sentences of what happened in this episode, for continuity.\n' : ""}- ${SAFETY}

Answer with exactly one \`\`\`json block and nothing else:
{"title": "...", "description": "...", "tags": ["..."], "thumbnailText": "...",${series ? ' "summary": "...",' : ""} "scenes": [{"lines": [{"speaker": "narrator", "text": "..."}], "visual": "...", "onScreenText": "..."}]}`;
}

export function biblePrompt(input: { premise: string; genre: string; style?: string; voices: string[] }): string {
  return `SERIES BIBLE: Create the bible of an original Vietnamese AI-animated series.
Premise from the owner: ${input.premise}
Genre: ${input.genre}
${input.style ? `Visual style wanted: ${input.style}\n` : ""}Available voices (name — gender): ${input.voices.join("; ")}

Rules:
- 2–5 main characters with Vietnamese names. "look" in English, precise and stable enough to draw the same person in every episode: age, face, hair, build, signature clothes and colours.
- personality in Vietnamese, one sentence. voice: one name from the list that fits the character's gender and age; give different characters different voices where possible.
- style in English: one art style for every frame (e.g. "2D anime, soft cel shading, warm muted palette"). Pick a style a still-image model draws consistently.
- title in Vietnamese, at most 40 characters.
- ${SAFETY}

Answer with exactly one \`\`\`json block:
{"title": "...", "style": "...", "narratorVoice": "...", "characters": [{"name": "...", "look": "...", "personality": "...", "voice": "..."}]}`;
}

/** The JSON object in a model's reply: a ```json fence if present, otherwise the outermost braces. */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!raw.trim()) throw new Error("the reply has no JSON");
  return JSON.parse(raw);
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Validates and normalises a script; throws with a message the model can act on. */
export function parseScript(text: string, speakers?: string[]): Script {
  const o = extractJson(text) as any;
  const title = s(o?.title);
  if (!title) throw new Error('"title" is missing');
  if (!Array.isArray(o?.scenes) || !o.scenes.length) throw new Error('"scenes" must be a non-empty array');
  const allowed = speakers ? new Set(["narrator", ...speakers]) : undefined;
  const scenes: Scene[] = o.scenes.map((sc: any, i: number) => {
    const lines = (Array.isArray(sc?.lines) ? sc.lines : [])
      .map((l: any) => ({ speaker: s(l?.speaker) || "narrator", text: s(l?.text) }))
      .filter((l: { text: string }) => l.text);
    if (!lines.length) throw new Error(`scene ${i + 1} has no spoken lines`);
    for (const l of lines) {
      if (allowed && !allowed.has(l.speaker)) throw new Error(`scene ${i + 1}: unknown speaker "${l.speaker}" — use "narrator" or a character name from the bible`);
    }
    const visual = s(sc?.visual);
    if (!visual) throw new Error(`scene ${i + 1} has no "visual"`);
    return { lines, visual, onScreenText: s(sc?.onScreenText) || undefined };
  });
  return {
    title: title.slice(0, 100), // YouTube's limit
    description: s(o.description).slice(0, 4900),
    tags: (Array.isArray(o.tags) ? o.tags : []).map(s).filter(Boolean).slice(0, 15),
    thumbnailText: s(o.thumbnailText) || title.slice(0, 30),
    summary: s(o.summary) || undefined,
    scenes,
  };
}

export function parseBible(text: string): Pick<Series, "title" | "style" | "narratorVoice" | "characters"> {
  const o = extractJson(text) as any;
  const characters: Character[] = (Array.isArray(o?.characters) ? o.characters : [])
    .map((c: any) => ({ name: s(c?.name), look: s(c?.look), personality: s(c?.personality), voice: s(c?.voice) || undefined }))
    .filter((c: Character) => c.name && c.look);
  if (!characters.length) throw new Error("the bible has no characters with a name and a look");
  return { title: s(o.title), style: s(o.style), narratorVoice: s(o.narratorVoice) || undefined, characters };
}

export function spokenWords(script: Script): number {
  return script.scenes.reduce((n, sc) => n + sc.lines.reduce((m, l) => m + l.text.split(/\s+/).filter(Boolean).length, 0), 0);
}

/** Deterministic stand-ins for the mock providers, so the whole flow runs without any key. */
export const mockWriter = {
  research: (job: VideoJob) => `(mock) Góc nhìn: vì sao "${job.topic}" quan trọng.\n- Dữ kiện 1\n- Dữ kiện 2`,
  outline: (job: VideoJob) => `(mock) Tập ${job.episode}: nhân vật chính gặp một bí ẩn mới.`,
  script: (job: VideoJob, series?: Series): Script => {
    const who = series?.characters[0]?.name ?? "narrator";
    return {
      title: series ? `${series.title} — Tập ${job.episode}` : `Giải thích nhanh: ${job.topic}`.slice(0, 70),
      description: `Video thử nghiệm (mock) về ${job.topic || "câu chuyện"}.\n#thunghiem`,
      tags: ["thử nghiệm", "mock"],
      thumbnailText: "Bản thử",
      summary: series ? "Nhân vật chính tìm thấy manh mối đầu tiên." : undefined,
      scenes: [
        { lines: [{ speaker: "narrator", text: `Bạn có biết điều gì đứng sau ${job.topic || "câu chuyện này"} không?` }], visual: "a curious person looking at the night sky", onScreenText: "Câu hỏi" },
        { lines: [{ speaker: who, text: "Đây là cảnh thứ hai, dùng để kiểm tra giọng đọc và phụ đề." }], visual: "a quiet library with warm light" },
        { lines: [{ speaker: "narrator", text: "Và đây là cảnh cuối cùng của bản thử." }], visual: "sunrise over a city" },
      ],
    };
  },
  bible: (premise: string): Pick<Series, "title" | "style" | "narratorVoice" | "characters"> => ({
    title: "Phim thử nghiệm",
    style: "2D anime, soft cel shading, warm muted palette",
    characters: [
      { name: "Minh", look: "17-year-old boy, short black hair, round glasses, navy hoodie", personality: `Tò mò, liên quan tới: ${premise.slice(0, 60)}` },
      { name: "Lan", look: "17-year-old girl, long black ponytail, white shirt, red scarf", personality: "Bình tĩnh, giỏi suy luận" },
    ],
  }),
};
