import type { Agent, TaskContext } from "../types.js";

/** Below this, compressing isn't worth an extra Gemini round-trip. */
const COMPRESS_THRESHOLD_CHARS = 4000;

const COMPRESSIBLE_FIELDS = ["verificationLog", "implementationDiff", "reviewFeedback"] as const;
type CompressibleField = (typeof COMPRESSIBLE_FIELDS)[number];

/**
 * Before a call to Claude, has Gemini compress the bulky, free-form fields
 * (verification logs, implementation diffs, review feedback) into a short
 * brief Claude can act on directly — cutting Claude's input tokens at the
 * cost of one extra Gemini call. `architectureSpec` is always passed
 * through untouched: on an architecture revision Claude diffs against its
 * exact text (see archRevision.ts), so summarizing it would break that.
 * Fails open in every way that matters: nothing big enough to be worth
 * compressing, or Gemini erroring/replying in an unexpected shape, just
 * means Claude gets the original, uncompressed context instead of being
 * blocked on this.
 */
export async function compressForClaude(gemini: Agent, context: TaskContext, signal?: AbortSignal): Promise<TaskContext> {
  const candidates: { field: CompressibleField; text: string }[] = [];
  for (const field of COMPRESSIBLE_FIELDS) {
    const raw = context[field];
    const text = Array.isArray(raw) ? raw.join("\n\n") : raw;
    if (typeof text === "string" && text.length > COMPRESS_THRESHOLD_CHARS) candidates.push({ field, text });
  }
  if (candidates.length === 0) return context;

  const prompt =
    "Summarize each of the sections below into a short, concrete brief for another engineer (Claude) to act on directly. " +
    "Keep every specific fact: file names, function names, exact error messages, which acceptance criteria are affected, and the actual root cause of any failure. " +
    "Cut repetition, stack-trace noise, and anything not relevant to deciding what to do next. " +
    "Reply with exactly one section per input, in the same order, each starting on its own line with its exact header unchanged (e.g. \"=== verificationLog ===\").\n\n" +
    candidates.map((c) => `=== ${c.field} ===\n${c.text}`).join("\n\n");

  let reply: string;
  try {
    reply = (await gemini.send(prompt, { title: context.title }, { signal })).content;
  } catch {
    return context;
  }

  const compressed: TaskContext = { ...context };
  for (const { field } of candidates) {
    const re = new RegExp(`===\\s*${field}\\s*===\\s*([\\s\\S]*?)(?=\\n===|$)`);
    const summary = re.exec(reply)?.[1]?.trim();
    if (!summary) continue; // Gemini's reply didn't include this section — keep the original rather than lose it
    if (field === "reviewFeedback") compressed.reviewFeedback = [summary];
    else compressed[field] = summary;
  }
  return compressed;
}
