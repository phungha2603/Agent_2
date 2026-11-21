import type { TaskContext } from "../types.js";

/** Renders everything an agent should see about the task into one prompt block. */
export function formatContext(context: TaskContext): string {
  const parts = [`Task: ${context.title}`];
  if (context.ideaBrief) parts.push(`--- Idea brief ---\n${context.ideaBrief}`);
  if (context.architectureSpec) parts.push(`--- Architecture spec ---\n${context.architectureSpec}`);
  if (context.implementationDiff) parts.push(`--- Implementation (engineer's reply) ---\n${context.implementationDiff}`);
  if (context.verificationLog) parts.push(`--- Verification log ---\n${context.verificationLog}`);
  if (context.reviewFeedback?.length) {
    parts.push(`--- Feedback from the previous round (address this) ---\n${context.reviewFeedback.join("\n")}`);
  }
  return parts.join("\n\n");
}
