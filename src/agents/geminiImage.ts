import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpStatusError, withRetry } from "./retry.js";

export interface GeminiImageGenerator {
  /** Generates an image from a prompt and writes it to outPath (PNG). Returns outPath. */
  generate(prompt: string, outPath: string): Promise<string>;
}

const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";

/**
 * Calls Gemini's native image generation (same generateContent endpoint,
 * asking for an IMAGE response modality). The exact model name moves
 * around as Google ships new ones — override with GEMINI_IMAGE_MODEL if
 * the default isn't available on your account; check which models support
 * image output at https://aistudio.google.com.
 */
export function createGeminiImageGenerator(opts: { apiKey: string; model?: string }): GeminiImageGenerator {
  const model = opts.model ?? DEFAULT_IMAGE_MODEL;
  return {
    async generate(prompt: string, outPath: string): Promise<string> {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const data = await withRetry(async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": opts.apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["IMAGE"] },
          }),
        });
        if (!res.ok) {
          throw new HttpStatusError(res.status, `Gemini image API error ${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as any;
      });

      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((p) => p?.inlineData?.data);
      if (!imagePart) {
        const text = parts.map((p) => p?.text).filter(Boolean).join(" ");
        throw new Error(`Gemini did not return an image.${text ? ` It said: ${text}` : ""}`);
      }
      const buffer = Buffer.from(imagePart.inlineData.data, "base64");
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, buffer);
      return outPath;
    },
  };
}
