import type { Agent, AgentResponse, SendOptions, TaskContext, Usage } from "../types.js";
import { formatContext } from "./context.js";
import { HttpStatusError, withRetry } from "./retry.js";
import { SseDecoder, anthropicChunkText, anthropicInputTokens, anthropicStreamUsage } from "./streamParsers.js";
import { verdictFor } from "./verdict.js";

const DEFAULT_MODEL = "claude-sonnet-5";
// Architecture guides are meant to be step-by-step and exhaustive; 2048
// tokens used to cut them off mid-guide.
const MAX_TOKENS = 8192;

/**
 * Calls the Claude API. Used for the architecture role (writes specs, not
 * code), the plan, and the final sign-off review. Streams when the caller
 * passes onChunk.
 */
export function createClaudeAgent(opts: { apiKey: string; model?: string }): Agent {
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    role: "claude",
    async send(prompt: string, context: TaskContext, sendOpts?: SendOptions): Promise<AgentResponse> {
      const onChunk = sendOpts?.onChunk;
      let attempt = 0;
      const { text, usage } = await withRetry(async () => {
        if (attempt++ > 0) onChunk?.("\n…(retrying)…\n");
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: sendOpts?.signal,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: sendOpts?.model ?? model,
            max_tokens: MAX_TOKENS,
            stream: Boolean(onChunk),
            messages: [{ role: "user", content: `${prompt}\n\n${formatContext(context)}` }],
          }),
        });
        if (!res.ok) {
          throw new HttpStatusError(res.status, `Claude API error ${res.status}: ${await res.text()}`);
        }
        if (!onChunk) {
          const data = (await res.json()) as any;
          const u: Usage | undefined = data?.usage
            ? { inputTokens: anthropicInputTokens(data.usage), outputTokens: Number(data.usage.output_tokens ?? 0) }
            : undefined;
          return { text: (data?.content ?? []).map((b: any) => b.text ?? "").join(""), usage: u };
        }
        const decoder = new SseDecoder();
        const utf8 = new TextDecoder();
        let full = "";
        const u: Usage = { inputTokens: 0, outputTokens: 0 };
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          for (const payload of decoder.push(utf8.decode(chunk, { stream: true }))) {
            const counts = anthropicStreamUsage(payload);
            if (counts.inputTokens !== undefined) u.inputTokens = counts.inputTokens;
            if (counts.outputTokens !== undefined) u.outputTokens = counts.outputTokens;
            const piece = anthropicChunkText(payload);
            if (piece) {
              full += piece;
              onChunk(piece);
            }
          }
        }
        return { text: full, usage: u };
      });
      const verdict = verdictFor(prompt, text);
      return { role: "claude", content: text, verdict, usage };
    },
  };
}
