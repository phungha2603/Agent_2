import type { Agent, TaskContext } from "../types.js";

/** Below this, compressing isn't worth an extra Gemini round-trip. */
const COMPRESS_THRESHOLD_CHARS = 4000;

// The verification log is the reviewer's only proof the code ran, so it is
// trimmed by code (keeping the evidence lines verbatim), never summarized:
// Gemini's summaries dropped test names and counts, and the review then
// rejected work that had actually passed.
const COMPRESSIBLE_FIELDS = ["implementationDiff", "reviewFeedback"] as const;
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
  if (typeof context.verificationLog === "string" && context.verificationLog.length > COMPRESS_THRESHOLD_CHARS) {
    context = { ...context, verificationLog: condenseVerificationLog(context.verificationLog, context.implementationFiles ?? []) };
  }
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

const KEY_LINE = [
  /^\$ /, // the command itself
  /^== .* ==$/, // the orchestrator's own check headers
  /^FAILED\b/,
  /^(OK|FAILED|PASSED)\b/,
  /^Ran \d+ tests?\b/,
  /\b\d+ (passed|failed|errors?|skipped|tests?)\b/i,
  /^(FAIL|ERROR):/,
];
// The runner's own "FAILED:" line or a test runner's failure header — not any
// "error" text, which passing tests print on purpose when testing error paths.
const FAILURE = /^FAILED\b|^(FAIL|ERROR): /m;
const SMALL_SECTION_CHARS = 1500;
const FAILURE_TAIL_LINES = 80;

/**
 * Shortens a verification log without rewording it: per command, small or
 * failing output is kept (a failure's tail in full), and long passing output
 * keeps only its evidence lines — commands, counts, OK/FAILED, check headers
 * and every line naming a file written this attempt.
 */
export function condenseVerificationLog(log: string, writtenFiles: string[]): string {
  const names = writtenFiles
    .map((f) => f.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "")
    .filter((n) => n.length >= 3);
  const isKey = (line: string) => KEY_LINE.some((re) => re.test(line)) || names.some((n) => line.includes(n));

  const sections: string[][] = [[]];
  for (const line of log.split("\n")) {
    if (line.startsWith("$ ") && sections[sections.length - 1].length) sections.push([]);
    sections[sections.length - 1].push(line);
  }
  return sections
    .map((lines) => {
      const text = lines.join("\n");
      if (text.length <= SMALL_SECTION_CHARS) return text;
      const failed = FAILURE.test(text);
      const tailStart = failed ? Math.max(0, lines.length - FAILURE_TAIL_LINES) : lines.length;
      const kept: string[] = [];
      let omitted = 0;
      const flush = () => {
        if (omitted) kept.push(`… (${omitted} line(s) omitted)`);
        omitted = 0;
      };
      lines.forEach((line, i) => {
        if (i >= tailStart || isKey(line)) {
          flush();
          kept.push(line);
        } else omitted++;
      });
      flush();
      return kept.join("\n");
    })
    .join("\n");
}
