import type { Agent, AgentResponse, SendOptions, TaskContext, Usage } from "../types.js";
import { formatContext } from "./context.js";
import { readImageParts } from "./imageParts.js";
import { HttpStatusError, withRetry } from "./retry.js";
import { SseDecoder, geminiChunkText, geminiUsageOf } from "./streamParsers.js";

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

/**
 * Calls the Gemini API directly over REST. With an onChunk callback it uses
 * streamGenerateContent (SSE) so the dashboard can show the reply as it's
 * written; without one it uses plain generateContent.
 */
export function createGeminiAgent(opts: { apiKey: string; model?: string }): Agent {
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    role: "gemini",
    async send(prompt: string, context: TaskContext, sendOpts?: SendOptions): Promise<AgentResponse> {
      const parts: unknown[] = [{ text: `${prompt}\n\n${formatContext(context)}` }];
      if (prompt.startsWith("REVIEW:")) {
        parts.push(...(await readImageParts("Reference style image (target look):", context.referenceImagePath)));
        parts.push(...(await readImageParts("Actual screenshot of the running implementation:", context.implementationScreenshotPath)));
      }
      const body = JSON.stringify({ contents: [{ role: "user", parts }] });
      const headers = { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey };
      const onChunk = sendOpts?.onChunk;

      let attempt = 0;
      const { text, usage } = await withRetry(async () => {
        if (attempt++ > 0) onChunk?.("\n…(retrying)…\n");
        const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
        const url = onChunk ? `${base}:streamGenerateContent?alt=sse` : `${base}:generateContent`;
        const res = await fetch(url, { method: "POST", headers, body, signal: sendOpts?.signal });
        if (!res.ok) {
          const errText = await res.text();
          throw new HttpStatusError(res.status, `Gemini API error ${res.status}: ${errText}`, parseGoogleRetryDelayMs(errText));
        }
        if (!onChunk) {
          const data = (await res.json()) as any;
          return { text: (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join(""), usage: geminiUsageOf(data) };
        }
        const decoder = new SseDecoder();
        const utf8 = new TextDecoder();
        let full = "";
        let lastUsage: Usage | undefined;
        const consume = (payload: string) => {
          const data = JSON.parse(payload);
          lastUsage = geminiUsageOf(data) ?? lastUsage; // the final chunk carries the totals
          const piece = geminiChunkText(payload);
          if (piece) {
            full += piece;
            onChunk(piece);
          }
        };
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          decoder.push(utf8.decode(chunk, { stream: true })).forEach(consume);
        }
        decoder.flush().forEach(consume);
        return { text: full, usage: lastUsage };
      });

      const verdict = prompt.startsWith("REVIEW:")
        ? (/\breject\b/i.test(text) ? "reject" : "approve")
        : undefined;
      return { role: "gemini", content: text, verdict, usage };
    },
  };
}
