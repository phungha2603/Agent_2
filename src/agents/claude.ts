import type { Agent, AgentResponse, TaskContext } from "../types.js";
import { formatContext } from "./context.js";

const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Calls the Claude API. Used for the architecture role (writes specs, not
 * code) and the final sign-off review.
 */
export function createClaudeAgent(opts: { apiKey: string; model?: string }): Agent {
  const model = opts.model ?? DEFAULT_MODEL;
  return {
    role: "claude",
    async send(prompt: string, context: TaskContext): Promise<AgentResponse> {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          messages: [{ role: "user", content: `${prompt}\n\n${formatContext(context)}` }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as any;
      const text: string = data?.content?.map((b: any) => b.text ?? "").join("") ?? "";
      const verdict = prompt.startsWith("REVIEW:")
        ? (/\breject\b/i.test(text) ? "reject" : "approve")
        : undefined;
      return { role: "claude", content: text, verdict };
    },
  };
}
