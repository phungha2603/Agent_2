import type { Stage, TaskContext } from "../types.js";

export const PRUNE_LIMITS = {
  /** Build/test output is only useful at the end, where the failure is. */
  verificationLogTail: 4000,
  implementationDiffHead: 60000,
  /** The previous attempt, shown to the engineer only on a fix round. */
  previousImplementationHead: 30000,
  attachments: 3,
  attachmentChars: 12000,
};

function head(text: string | undefined, max: number): string | undefined {
  if (!text) return text;
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function tail(text: string | undefined, max: number): string | undefined {
  if (!text) return text;
  return text.length <= max ? text : `…[${text.length - max} earlier chars omitted]\n${text.slice(-max)}`;
}

/**
 * Only what the agent at this stage actually acts on. Before this, every
 * call got the task's whole accumulated context — the ideation agent saw old
 * implementation diffs, the engineer saw the full verification log of every
 * previous run, and so on. Each field kept here is one the stage's prompt
 * refers to; everything else is dropped or truncated.
 */
export function pruneContext(stage: Stage, ctx: TaskContext): TaskContext {
  // CEO directives go to every stage; forwarded material only to the stages that produce the work.
  const base: TaskContext = { title: ctx.title, directives: ctx.directives?.length ? ctx.directives : undefined };
  const producing = stage === "ideation" || stage === "architecture" || stage === "architecture_review" || stage === "implementation";
  if (producing && ctx.attachments?.length) {
    base.attachments = ctx.attachments.slice(-PRUNE_LIMITS.attachments).map((a) => ({ ...a, content: head(a.content, PRUNE_LIMITS.attachmentChars)! }));
  }
  const fixRound = Boolean(ctx.reviewFeedback?.length);

  switch (stage) {
    case "ideation":
      return {
        ...base,
        sharedBrief: ctx.sharedBrief,
        acceptanceCriteria: ctx.acceptanceCriteria,
        upstream: ctx.upstream,
        ideaBrief: fixRound ? ctx.ideaBrief : undefined,
        reviewFeedback: ctx.reviewFeedback,
      };

    case "architecture":
      return {
        ...base,
        sharedBrief: ctx.sharedBrief,
        ideaBrief: ctx.ideaBrief,
        acceptanceCriteria: ctx.acceptanceCriteria,
        upstream: ctx.upstream,
        // On a revision, Claude diffs against this exact text, so it is
        // NOT truncated the way other large fields are here — a diff
        // against a truncated spec wouldn't apply past the cut.
        architectureSpec: fixRound ? ctx.architectureSpec : undefined,
        reviewFeedback: ctx.reviewFeedback,
      };

    case "architecture_review":
      return {
        ...base,
        sharedBrief: ctx.sharedBrief,
        ideaBrief: ctx.ideaBrief,
        acceptanceCriteria: ctx.acceptanceCriteria,
        upstream: ctx.upstream,
        architectureSpec: ctx.architectureSpec,
      };

    case "implementation":
      return {
        ...base,
        acceptanceCriteria: ctx.acceptanceCriteria,
        upstream: ctx.upstream,
        architectureSpec: ctx.architectureSpec,
        implementationDiff: fixRound ? head(ctx.implementationDiff, PRUNE_LIMITS.previousImplementationHead) : undefined,
        reviewFeedback: ctx.reviewFeedback,
      };

    case "review_gemini":
      return {
        ...base,
        sharedBrief: ctx.sharedBrief,
        ideaBrief: ctx.ideaBrief,
        acceptanceCriteria: ctx.acceptanceCriteria,
        architectureSpec: ctx.architectureSpec,
        implementationFiles: ctx.implementationFiles,
        implementationDiff: head(ctx.implementationDiff, PRUNE_LIMITS.implementationDiffHead),
        verificationLog: tail(ctx.verificationLog, PRUNE_LIMITS.verificationLogTail),
        referenceImagePath: ctx.referenceImagePath,
        implementationScreenshotPath: ctx.implementationScreenshotPath,
      };

    case "review_claude":
      return {
        ...base,
        acceptanceCriteria: ctx.acceptanceCriteria,
        architectureSpec: ctx.architectureSpec,
        implementationFiles: ctx.implementationFiles,
        implementationDiff: head(ctx.implementationDiff, PRUNE_LIMITS.implementationDiffHead),
        verificationLog: tail(ctx.verificationLog, PRUNE_LIMITS.verificationLogTail),
        reviewFeedback: ctx.reviewFeedback,
      };

    default:
      return { ...ctx };
  }
}
