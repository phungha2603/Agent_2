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

/** A review's verification log: evidence lines first, then the length cap — capping first cut off the passing tests of the file under review. */
function reviewLog(ctx: TaskContext): string | undefined {
  if (!ctx.verificationLog) return ctx.verificationLog;
  return tail(condenseVerificationLog(ctx.verificationLog, ctx.implementationFiles ?? []), PRUNE_LIMITS.verificationLogTail);
}

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
  const base: TaskContext = {
    title: ctx.title,
    directives: ctx.directives?.length ? ctx.directives : undefined,
    ceoRequests: ctx.ceoRequests?.length ? ctx.ceoRequests : undefined,
  };
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
        projectFiles: ctx.projectFiles,
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
        projectFiles: ctx.projectFiles,
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
        verificationLog: reviewLog(ctx),
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
        verificationLog: reviewLog(ctx),
        reviewFeedback: ctx.reviewFeedback,
      };

    default:
      return { ...ctx };
  }
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
