import type { HandoffArtifact, TaskContext } from "../types.js";

function formatHandoff(h: HandoffArtifact): string {
  const lines = [`[${h.slotId ?? "?"}] ${h.title}`];
  if (h.files.length) lines.push(`Files: ${h.files.join(", ")}`);
  if (h.acceptanceCriteria.length) lines.push(`Delivered against:\n${h.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`);
  if (h.specExcerpt) lines.push(`Design excerpt:\n${h.specExcerpt}`);
  return lines.join("\n");
}

/** Renders everything an agent should see about the task into one prompt block. */
export function formatContext(context: TaskContext): string {
  const parts = [`Task: ${context.title}`];
  if (context.directives?.length) {
    parts.push(`--- CEO directives (follow these; they override any earlier instruction) ---\n${context.directives.map((d) => `- ${d}`).join("\n")}`);
  }
  if (context.sharedBrief) parts.push(`--- Shared plan context ---\n${context.sharedBrief}`);
  if (context.attachments?.length) {
    parts.push(
      `--- Input material forwarded by the CEO ---\n${context.attachments.map((a) => `[${a.title} — from ${a.from}]\n${a.content}`).join("\n\n")}`,
    );
  }
  if (context.ideaBrief) parts.push(`--- Idea brief ---\n${context.ideaBrief}`);
  if (context.acceptanceCriteria?.length) {
    parts.push(`--- Acceptance criteria (every one must be met) ---\n${context.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`);
  }
  if (context.upstream?.length) {
    parts.push(
      `--- Upstream handoffs (finished by teammates — build on these, don't redo them) ---\n${context.upstream.map(formatHandoff).join("\n\n")}`,
    );
  }
  if (context.architectureSpec) parts.push(`--- Architecture spec ---\n${context.architectureSpec}`);
  if (context.implementationDiff) parts.push(`--- Implementation (engineer's reply) ---\n${context.implementationDiff}`);
  if (context.verificationLog) parts.push(`--- Verification log ---\n${context.verificationLog}`);
  if (context.reviewFeedback?.length) {
    parts.push(`--- Feedback from the previous round (address this) ---\n${context.reviewFeedback.join("\n")}`);
  }
  return parts.join("\n\n");
}
