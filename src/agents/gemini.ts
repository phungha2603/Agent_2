import type { Agent, AgentResponse, TaskContext } from "../types.js";

const DEFAULT_MODEL = "gemini-2.5-pro";

/** Calls the Gemini API directly over REST (generateContent). */
export function createGeminiAgent(opts: { apiKey: string; model?: string }): Agent {
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    role: "gemini",
    async send(prompt: string, context: TaskContext): Promise<AgentResponse> {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": opts.apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${prompt}\n\nTask: ${context.title}` }] }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as any;
      const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
      const verdict = prompt.startsWith("REVIEW:")
        ? (/\breject\b/i.test(text) ? "reject" : "approve")
        : undefined;
      return { role: "gemini", content: text, verdict };
    },
  };
}
