import type { Agent, AgentResponse, TaskContext } from "../types.js";
import { formatContext } from "./context.js";
import { readImageParts } from "./imageParts.js";
import { HttpStatusError, withRetry } from "./retry.js";

const DEFAULT_MODEL = "gemini-2.5-pro";

/** Pulls RetryInfo.retryDelay (e.g. "45s") out of a Gemini 429 error body, if present. */
export function parseGoogleRetryDelayMs(errorBodyText: string): number | undefined {
  try {
    const body = JSON.parse(errorBodyText);
    const details: any[] = body?.error?.details ?? [];
    const retryInfo = details.find((d) => typeof d?.["@type"] === "string" && d["@type"].includes("RetryInfo"));
    const match = /^([\d.]+)s$/.exec(retryInfo?.retryDelay ?? "");
    if (!match) return undefined;
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** Calls the Gemini API directly over REST (generateContent). */
export function createGeminiAgent(opts: { apiKey: string; model?: string }): Agent {
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    role: "gemini",
    async send(prompt: string, context: TaskContext): Promise<AgentResponse> {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const parts: unknown[] = [{ text: `${prompt}\n\n${formatContext(context)}` }];
      if (prompt.startsWith("REVIEW:")) {
        parts.push(...(await readImageParts("Reference style image (target look):", context.referenceImagePath)));
        parts.push(...(await readImageParts("Actual screenshot of the running implementation:", context.implementationScreenshotPath)));
      }
      const data = await withRetry(async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": opts.apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new HttpStatusError(res.status, `Gemini API error ${res.status}: ${text}`, parseGoogleRetryDelayMs(text));
        }
        return (await res.json()) as any;
      });
      const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
      const verdict = prompt.startsWith("REVIEW:")
        ? (/\breject\b/i.test(text) ? "reject" : "approve")
        : undefined;
      return { role: "gemini", content: text, verdict };
    },
  };
}
