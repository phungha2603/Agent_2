import type { Agent, AgentResponse, SendOptions, TaskContext } from "../types.js";

export type Verdict = "approve" | "reject";

/** Appended to every review prompt: the verdict is read from this line only, never guessed from prose. */
export const VERDICT_INSTRUCTION =
  "End your reply with exactly one final line on its own, and nothing after it: `VERDICT: APPROVE` or `VERDICT: REJECT`.";

const VERDICT_LINE_RE = /^verdict\s*[:：-]\s*(approve|approved|reject|rejected)\s*\.?$/i;

/**
 * Reads the verdict from the reply's closing `VERDICT:` line. Scanning prose
 * for the word "reject" got both directions wrong — "REJECTED" read as an
 * approval, "I would not reject this" as a rejection — so anything without
 * that line is undefined, not a guess.
 */
export function parseVerdict(text: string): Verdict | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/[*_`#>]/g, "").trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    const m = lines[i].match(VERDICT_LINE_RE);
    if (m) return m[1].toLowerCase().startsWith("approve") ? "approve" : "reject";
  }
  return undefined;
}

/** What each agent sets as `verdict`: only review prompts carry one. */
export function verdictFor(prompt: string, text: string): Verdict | undefined {
  return prompt.startsWith("REVIEW:") ? parseVerdict(text) : undefined;
}

/**
 * Sends a review and guarantees a verdict. A reply without the VERDICT line
 * gets one short follow-up (the review text only, not the whole context);
 * if that still has none, it counts as a rejection — an unreadable review
 * must never let work through.
 */
export async function sendReview(agent: Agent, prompt: string, context: TaskContext, opts?: SendOptions): Promise<AgentResponse & { verdict: Verdict }> {
  const res = await agent.send(prompt, context, opts);
  if (res.verdict) return { ...res, verdict: res.verdict };
  const followUp = await agent.send(
    "REVIEW: You wrote the review below but did not end it with the required verdict line. Based only on this review, reply with exactly one line: `VERDICT: APPROVE` or `VERDICT: REJECT`.\n\n" +
      res.content,
    { title: context.title },
    opts,
  );
  if (followUp.verdict) return { ...res, verdict: followUp.verdict, usage: res.usage };
  return {
    ...res,
    verdict: "reject",
    content: `${res.content}\n\n(The reviewer gave no readable VERDICT line, even when asked again — counted as a rejection.)`,
  };
}
