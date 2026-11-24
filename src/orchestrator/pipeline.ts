import type {
  Agent,
  AgentResponse,
  HistoryEntry,
  ProjectConfig,
  RoleName,
  SendOptions,
  Stage,
  TaskContext,
  TaskRecord,
  TraceEntry,
} from "../types.js";
import type { VerifyConfig } from "../verify/runner.js";
import { runVerification } from "../verify/runner.js";
import { newTaskId } from "../store/taskStore.js";
import { parseFileBlocks, writeFiles } from "../apply/applyFiles.js";
import { pruneContext } from "./contextPruning.js";

export function createTask(title: string, projectConfig?: ProjectConfig): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: newTaskId(title),
    createdAt: now,
    updatedAt: now,
    stage: "ideation",
    context: { title },
    history: [],
    implementationAttempts: 0,
    reviewRejections: 0,
    architectureRounds: 0,
    autoRecoveries: 0,
    projectConfig,
  };
}

export interface PlannedTaskInput {
  title: string;
  slotId: string;
  ideaBrief: string;
  acceptanceCriteria: string[];
  sharedBrief: string;
  planRef: { planId: string; epicId: string; subtaskId?: string };
}

/**
 * A task created from a plan the CEO already approved. That approval stands
 * in for checkpoint_idea, so it starts at architecture with the plan's
 * description as its brief — not at ideation, which would have Gemini
 * re-invent a brief the human already signed off on.
 */
export function createPlannedTask(input: PlannedTaskInput, projectConfig?: ProjectConfig): TaskRecord {
  const task = createTask(input.title, projectConfig);
  task.stage = "architecture";
  task.slotId = input.slotId;
  task.planRef = input.planRef;
  task.context.ideaBrief = input.ideaBrief;
  task.context.acceptanceCriteria = input.acceptanceCriteria;
  task.context.sharedBrief = input.sharedBrief;
  log(task, "architecture", "ceo", `Created from approved plan ${input.planRef.planId} — starts at architecture (the plan approval covers the idea checkpoint).`);
  return task;
}

export interface Agents {
  gemini: Agent;
  claude: Agent;
  muse: Agent;
}

/**
 * Optional visual review loop: Gemini generates a reference style image at
 * ideation time, and a real screenshot of the just-built output is taken
 * after verification passes, so review_gemini can compare the two instead
 * of only reading text. Both steps degrade gracefully (logged, not fatal)
 * if generation or the screenshot fails — a missing image means the review
 * just falls back to text only, it doesn't block the pipeline. The
 * screenshot serves `buildDir` as static files on a fresh port rather than
 * running the project's own dev server, so there's nothing that can be
 * left over from a previous attempt to serve stale content.
 */
export interface VisualConfig {
  referenceImagePrompt: string;
  referenceImagePath: string;
  screenshotPath: string;
  buildDir: string;
  screenshotWaitMs?: number;
  generateImage: (prompt: string, outPath: string) => Promise<string>;
  captureScreenshot: (opts: { cwd: string; buildDir: string; outPath: string; waitMs?: number }) => Promise<string>;
}

export interface PipelineConfig {
  verify: VerifyConfig;
  maxImplementationAttempts: number;
  maxReviewRejections: number;
  /** Safety ceiling on Claude/Gemini architecture discussion rounds (default 20 — meant to never be hit in practice). */
  maxArchitectureRounds?: number;
  /**
   * When implementation/review budgets run out, send the task back to
   * architecture (with all the accumulated feedback) this many times before
   * giving up as "rejected". Default 0.
   */
  maxAutoRecoveries?: number;
  visual?: VisualConfig;
}

export interface AdvanceHooks {
  onChunk?: (text: string) => void;
  signal?: AbortSignal;
}

export function trace(task: TaskRecord, by: string, kind: TraceEntry["kind"], text: string): void {
  (task.trace ??= []).push({ at: new Date().toISOString(), by, kind, text });
}

const PROMPTS = {
  ideation:
    "You are the ideation lead. Propose a concrete idea/feature brief for this task: goals, target users, rough scope. Keep it short. " +
    "If shared plan context or acceptance criteria are included below, the brief must stay inside them. " +
    "If feedback from a previous round is included below, this is a revision of the brief itself — rewrite it to actually reflect the new direction the feedback describes, replacing anything in the old brief that now contradicts it, not just appending a note.",
  architecture:
    "You are the architecture lead and mentor to the engineer (Muse), who writes all the code — you do NOT write code yourself. " +
    "Write a precise, step-by-step implementation guide, not just a high-level spec: exact file list with what each one is responsible for, exact function/method signatures, the order to build things in, plain pseudocode for any non-trivial logic, and common mistakes to avoid. " +
    "Write it the way you'd personally walk a capable but unfamiliar engineer through building this, so there's as little left to guess as possible. " +
    "If acceptance criteria are listed, show how each one will be met and which test proves it. If upstream handoffs are listed, build on those files and interfaces instead of recreating them. " +
    "If feedback from a previous round is included below, this is a revision: write a full updated guide that actually changes to address that feedback — don't repeat the previous design unchanged.",
  architectureReview:
    "REVIEW: You are discussing this architecture spec with Claude before any code gets written — Muse hasn't started yet. " +
    "Read it against the idea brief and the acceptance criteria (every criterion must have a clear way to be met and tested). If it's solid, approve it. If something is missing, ambiguous, risky, or could be designed better, reject and say exactly what to add or change — name the specific section, file, or interface and what you'd write instead, since Claude will revise the spec and you'll read the new version next round. " +
    "There is no limit on how many rounds this can take — only approve once you'd actually be comfortable seeing this built exactly as written.",
  implementation:
    "You are the engineer. Implement the following architecture spec in code, making sure every acceptance criterion listed is met (with a test where possible).\n" +
    "For every file you create or change, write a line starting with exactly:\n" +
    "FILE: relative/path/to/file.ext\n" +
    "followed by the FULL contents of that file (not a diff), then the next FILE: line for the next file. " +
    "Do not skip writing a file's contents, and do not just describe what a file would contain.",
  reviewGemini:
    "REVIEW: Review this implementation against the idea brief, the acceptance criteria (each listed criterion must be demonstrably met — name any that isn't), and the verification log. " +
    "If a reference style image and a screenshot of the running implementation are attached, compare them directly — " +
    "say concretely where the screenshot matches or deviates from the reference's look (composition, color, mood, missing/extra elements), not just whether the code builds. " +
    "Approve or reject, with reasons.",
  reviewClaude:
    "REVIEW: Final sign-off review, as the mentor who wrote the architecture guide. Check the implementation matches that guide, meets every listed acceptance criterion, and passed verification. " +
    "If feedback from the independent reviewer is included above, you decide for yourself whether it's actually correct before ruling — don't just rubber-stamp it: you may agree with it, or overrule it and approve anyway (say briefly why). " +
    "If you reject — whether because you agree with that feedback or found your own issue — don't just say what's wrong: give precise, step-by-step instructions for exactly how to fix it (which file, which function, what the corrected logic should look like), as if correcting a student's work directly, so the engineer can act on it without guessing. " +
    "You are always the one who makes this call, not the independent reviewer. Approve or reject, with reasons.",
  reviewGeminiFallback:
    "REVIEW: Gemini, the usual independent reviewer for this round, is temporarily unavailable, so you are standing in to give that independent review before this reaches your own final sign-off later. " +
    "Review this implementation against the idea brief, the acceptance criteria and the verification log as a separate check from your eventual sign-off — focus on whether it actually does what was asked, not just whether it compiles. " +
    "Approve or reject, with reasons.",
};

/** Longest slice of earlier feedback carried into an automatic-recovery note. */
const RECOVERY_FEEDBACK_CHARS = 6000;

/** The verify settings this task actually runs with — its own snapshot if it has one, else the live config (old tasks). */
function resolveVerify(task: TaskRecord, config: PipelineConfig): VerifyConfig {
  const pc = task.projectConfig;
  if (!pc) return config.verify;
  return { cwd: pc.verifyCwd, commands: pc.verifyCommands };
}

/**
 * The visual-review settings this task actually runs with, or undefined if
 * it shouldn't run the visual loop at all. A task's own snapshot decides
 * this, not whatever REFERENCE_IMAGE_PROMPT happens to be set to right
 * now — a task snapshotted without one stays text-only even if a later,
 * unrelated task turns the loop on. Only tasks with no snapshot at all
 * (created before this existed) fall back to the live config.
 */
function resolveVisual(task: TaskRecord, config: PipelineConfig): VisualConfig | undefined {
  if (!config.visual) return undefined;
  const pc = task.projectConfig;
  if (!pc) return config.visual;
  if (!pc.referenceImagePrompt) return undefined;
  return {
    ...config.visual,
    referenceImagePrompt: pc.referenceImagePrompt,
    referenceImagePath: pc.referenceImagePath ?? config.visual.referenceImagePath,
    screenshotPath: pc.screenshotPath ?? config.visual.screenshotPath,
    buildDir: pc.buildDir ?? config.visual.buildDir,
    screenshotWaitMs: pc.screenshotWaitMs ?? config.visual.screenshotWaitMs,
  };
}

export function log(task: TaskRecord, stage: Stage, by: RoleName, summary: string): void {
  const entry: HistoryEntry = { stage, at: new Date().toISOString(), by, summary };
  task.history.push(entry);
}

/** Generates the reference image once (if this task's visual review is on and it hasn't been made yet). */
async function ensureReferenceImage(task: TaskRecord, config: PipelineConfig): Promise<void> {
  const visual = resolveVisual(task, config);
  if (!visual || task.context.referenceImagePath) return;
  try {
    await visual.generateImage(visual.referenceImagePrompt, visual.referenceImagePath);
    task.context.referenceImagePath = visual.referenceImagePath;
    log(task, task.stage, "gemini", `Reference style image generated at ${visual.referenceImagePath}.`);
  } catch (err) {
    log(task, task.stage, "system", `Reference image generation failed (continuing without it): ${(err as Error).message}`);
  }
}

/**
 * Out of implementation/review budget. Repeated failure to build or pass
 * review usually means the guide itself is the problem, so before giving
 * up, send it back to Claude with everything the attempts learned — a
 * revised architecture, not just another identical retry.
 */
function exhaustBudget(task: TaskRecord, config: PipelineConfig, reason: string): void {
  const used = task.autoRecoveries ?? 0;
  const max = config.maxAutoRecoveries ?? 0;
  if (used >= max) {
    task.stage = "rejected";
    return;
  }
  task.autoRecoveries = used + 1;
  const previous = (task.context.reviewFeedback ?? []).join("\n").slice(-RECOVERY_FEEDBACK_CHARS);
  task.context.reviewFeedback = [
    `Automatic recovery ${used + 1}/${max}: the engineer could not get this to pass (${reason}) after ` +
      `${task.implementationAttempts} implementation attempt(s) and ${task.reviewRejections} review rejection(s). ` +
      `Most recent feedback:\n${previous}\n\n` +
      "Revise the implementation guide so the next attempt succeeds: be far more explicit exactly where it kept failing, and simplify where you can.",
  ];
  task.implementationAttempts = 0;
  task.reviewRejections = 0;
  task.architectureRounds = 0;
  log(task, task.stage, "system", `Budget exhausted (${reason}) — automatic recovery ${used + 1}/${max}: back to architecture with all accumulated feedback.`);
  trace(task, "System", "recovery", `Out of attempts (${reason}); sent back to Claude to revise the architecture (${used + 1}/${max}).`);
  task.stage = "architecture";
}

/** Terminal stages, or stages that need a human decision before they can proceed. */
export function isWaitingForHuman(task: TaskRecord): boolean {
  return task.stage === "checkpoint_idea" || task.stage === "checkpoint_final";
}

export function isTerminal(task: TaskRecord): boolean {
  return task.stage === "done" || task.stage === "rejected";
}

/**
 * Asks Muse for the implementation and records the reply (and the bumped
 * attempt count) on the task — no filesystem writes yet. Split out of the
 * "implementation" stage so the scheduler can run this chat call without
 * holding the shared workspace lock; only applyImplementation below, which
 * actually touches disk, needs it.
 */
export async function draftImplementation(task: TaskRecord, agents: Agents, hooks: AdvanceHooks = {}): Promise<void> {
  const opts: SendOptions = { onChunk: hooks.onChunk, taskId: task.id, signal: hooks.signal };
  const feedback = task.context.reviewFeedback?.length
    ? `\n\nAddress this feedback from the previous attempt:\n${task.context.reviewFeedback.join("\n")}`
    : "";
  const res = await agents.muse.send(PROMPTS.implementation + feedback, pruneContext("implementation", task.context), opts);
  task.context.implementationDiff = res.content;
  task.implementationAttempts += 1;
}

/**
 * Writes the diff draftImplementation already fetched and moves on to
 * verification. Touches the shared project directory — callers should hold
 * the workspace lock across this (and, without releasing it in between,
 * across the verification that immediately follows).
 */
export async function applyImplementation(task: TaskRecord, config: PipelineConfig): Promise<void> {
  const files = parseFileBlocks(task.context.implementationDiff ?? "");
  if (files.length === 0) {
    task.context.implementationFiles = [];
    log(
      task,
      task.stage,
      "system",
      `Implementation attempt #${task.implementationAttempts}: reply had no "FILE:" blocks — nothing was written to disk.`,
    );
  } else {
    const written = await writeFiles(resolveVerify(task, config).cwd, files);
    task.context.implementationFiles = written;
    log(
      task,
      task.stage,
      "muse",
      `Implementation attempt #${task.implementationAttempts}: wrote ${written.length} file(s): ${written.join(", ")}.`,
    );
  }
  task.stage = "verification";
}

/**
 * Runs the current stage's action and moves the task to its next stage.
 * Must not be called while isWaitingForHuman(task) or isTerminal(task) — use
 * resolveCheckpoint for the former.
 */
export async function advance(task: TaskRecord, agents: Agents, config: PipelineConfig, hooks: AdvanceHooks = {}): Promise<TaskRecord> {
  const opts: SendOptions = { onChunk: hooks.onChunk, taskId: task.id, signal: hooks.signal };
  const ctx = (stage: Stage): TaskContext => pruneContext(stage, task.context);

  switch (task.stage) {
    case "ideation": {
      const res = await agents.gemini.send(PROMPTS.ideation, ctx("ideation"), opts);
      task.context.ideaBrief = res.content;
      log(task, task.stage, "gemini", "Idea brief drafted.");
      await ensureReferenceImage(task, config);
      task.stage = "checkpoint_idea";
      return task;
    }

    case "architecture": {
      const res = await agents.claude.send(PROMPTS.architecture, ctx("architecture"), opts);
      task.context.architectureSpec = res.content;
      log(task, task.stage, "claude", "Architecture spec written.");
      // Also checked here, not just in ideation: a task can reach
      // architecture for the first time well after ideation (e.g. the
      // visual loop was turned on partway through, it was created from a
      // plan, or this is a checkpoint_final redesign), and this is still
      // the right moment to have a reference image before implementation.
      await ensureReferenceImage(task, config);
      task.context.reviewFeedback = [];
      task.stage = "architecture_review";
      return task;
    }

    case "architecture_review": {
      const res = await agents.gemini.send(PROMPTS.architectureReview, ctx("architecture_review"), opts);
      log(task, task.stage, "gemini", `Verdict: ${res.verdict ?? "unknown"}.`);
      if (res.verdict === "approve") {
        task.context.reviewFeedback = [];
        task.stage = "implementation";
      } else {
        task.architectureRounds = (task.architectureRounds ?? 0) + 1;
        const maxRounds = config.maxArchitectureRounds ?? 20;
        task.context.reviewFeedback = [`Gemini's architecture feedback (round ${task.architectureRounds}):\n${res.content}`];
        task.stage = task.architectureRounds < maxRounds ? "architecture" : "rejected";
      }
      return task;
    }

    case "implementation": {
      await draftImplementation(task, agents, hooks);
      await applyImplementation(task, config);
      return task;
    }

    case "verification": {
      const verify = resolveVerify(task, config);
      const result = await runVerification(verify);
      task.context.verificationLog = result.log;
      log(task, task.stage, "system", result.passed ? "Verification passed." : "Verification FAILED.");
      if (result.passed) {
        const visual = resolveVisual(task, config);
        if (visual) {
          try {
            await visual.captureScreenshot({
              cwd: verify.cwd,
              buildDir: visual.buildDir,
              outPath: visual.screenshotPath,
              waitMs: visual.screenshotWaitMs,
            });
            task.context.implementationScreenshotPath = visual.screenshotPath;
            log(task, task.stage, "system", `Screenshot of the running implementation captured at ${visual.screenshotPath}.`);
          } catch (err) {
            log(task, task.stage, "system", `Screenshot capture failed (review will be text-only): ${(err as Error).message}`);
          }
        }
        task.stage = "review_gemini";
      } else if (task.implementationAttempts < config.maxImplementationAttempts) {
        task.context.reviewFeedback = [`Verification failed:\n${result.log}`];
        task.stage = "implementation";
      } else {
        task.context.reviewFeedback = [`Verification failed:\n${result.log}`];
        exhaustBudget(task, config, "verification kept failing");
      }
      return task;
    }

    case "review_gemini": {
      // Gemini is the independent reviewer for this stage, but its free
      // tier can go down for stretches (rate limits, server overload) —
      // when it's genuinely exhausted its own retry budget (not just a
      // single blip), Claude stands in for this one round rather than
      // leaving the task stuck waiting on a service that may not come
      // back soon. This is a stand-in for a round, not a permanent
      // reassignment: the next task (or even a later round of this one,
      // after a loop back through implementation) tries Gemini again.
      let res: AgentResponse;
      let reviewer: RoleName;
      try {
        res = await agents.gemini.send(PROMPTS.reviewGemini, ctx("review_gemini"), opts);
        reviewer = "gemini";
      } catch (err) {
        log(
          task,
          task.stage,
          "system",
          `Gemini review unavailable (${(err as Error).message}) — Claude is standing in for this round's independent review.`,
        );
        res = await agents.claude.send(PROMPTS.reviewGeminiFallback, ctx("review_gemini"), opts);
        reviewer = "claude";
      }
      log(task, task.stage, reviewer, `Verdict: ${res.verdict ?? "unknown"}.`);
      // Whatever this independent review's verdict, it goes to Claude next —
      // nothing here loops back to implementation directly. Claude (the
      // mentor who wrote the architecture guide) decides for itself whether
      // the feedback holds up, and is the only one who can actually send the
      // task back to implementation (see review_claude below).
      const reviewerLabel = reviewer === "gemini" ? "Gemini" : "Claude (standing in for Gemini)";
      task.context.reviewFeedback = res.verdict === "reject" ? [`${reviewerLabel} review feedback:\n${res.content}`] : [];
      task.stage = "review_claude";
      return task;
    }

    case "review_claude": {
      const res = await agents.claude.send(PROMPTS.reviewClaude, ctx("review_claude"), opts);
      log(task, task.stage, "claude", `Verdict: ${res.verdict ?? "unknown"}.`);
      if (res.verdict === "approve") {
        task.stage = "checkpoint_final";
      } else {
        task.reviewRejections += 1;
        task.context.reviewFeedback = [`Claude review feedback:\n${res.content}`];
        if (task.reviewRejections < config.maxReviewRejections) {
          task.stage = "implementation";
        } else {
          exhaustBudget(task, config, "review kept rejecting");
        }
      }
      return task;
    }

    default:
      throw new Error(`advance() cannot run stage "${task.stage}" — it needs a human decision or is terminal.`);
  }
}

/**
 * Resolves a human checkpoint. This is the only place a task can reach
 * "done" — no agent output can set it directly.
 */
export function resolveCheckpoint(task: TaskRecord, approved: boolean, feedback?: string): TaskRecord {
  if (!isWaitingForHuman(task)) {
    throw new Error(`Task is not at a checkpoint (stage: ${task.stage}).`);
  }
  if (task.stage === "checkpoint_idea") {
    log(task, task.stage, "ceo", approved ? "Idea approved." : "Idea sent back.");
    task.stage = approved ? "architecture" : "ideation";
  } else if (task.stage === "checkpoint_final") {
    log(task, task.stage, "ceo", approved ? "Shipped." : "Sent back for a redesign.");
    if (approved) {
      task.stage = "done";
    } else {
      // Route all the way back through ideation, not just architecture: a
      // human rejecting at the final checkpoint after both agents already
      // signed off is usually asking for a direction change — and the
      // original ideaBrief stays in every later prompt unchanged unless
      // something rewrites it. Leaving it stale while only the
      // architecture spec moves on creates a standing contradiction
      // ("the brief says outdoor cyberpunk street, the implementation is
      // an indoor office") that a careful reviewer will correctly refuse
      // to approve forever, no matter how many times the code changes.
      // Re-running ideation updates the brief itself, and the CEO
      // re-approves it at checkpoint_idea before architecture/implementation
      // continue from a consistent set of documents.
      task.stage = "ideation";
      task.implementationAttempts = 0;
      task.reviewRejections = 0;
      task.architectureRounds = 0;
      task.autoRecoveries = 0;
    }
  }
  if (!approved && feedback) {
    task.context.reviewFeedback = [feedback];
  }
  return task;
}

/**
 * The lighter alternative to rejecting at the final checkpoint: the design
 * is fine, the result needs specific changes. Goes back to implementation
 * with the CEO's request, keeping the idea brief and architecture — unlike
 * a rejection, which reopens the whole direction through ideation.
 */
export function requestRevision(task: TaskRecord, feedback: string): TaskRecord {
  if (task.stage !== "checkpoint_final") {
    throw new Error(`Only a task waiting for final approval can be sent back for a revision (stage: ${task.stage}).`);
  }
  const request = feedback.trim() || "Revise the result: it doesn't meet the acceptance criteria yet.";
  task.implementationAttempts = 0;
  task.reviewRejections = 0;
  task.autoRecoveries = 0;
  task.context.reviewFeedback = [`CEO revision request (keep the architecture; change exactly this):\n${request}`];
  log(task, task.stage, "ceo", `Revision requested: ${request}`);
  trace(task, "CEO", "revise", `Sent back to implementation for a revision: ${request}`);
  task.stage = "implementation";
  return task;
}

/**
 * Gives a "rejected" task a fresh implementation budget without redoing
 * ideation/architecture. Keeps whatever reviewFeedback is already on the
 * task — usually the last reviewer's actual, specific comments, which is
 * exactly what the engineer needs on the next attempt. Pass clearFeedback
 * only when the old feedback is stale/misleading (e.g. it described a bug
 * in the orchestrator itself, since fixed, rather than in the work).
 */
export function retryFromRejected(task: TaskRecord, opts: { note?: string; clearFeedback?: boolean } = {}): TaskRecord {
  if (task.stage !== "rejected") {
    throw new Error(`Task is not rejected (stage: ${task.stage}) — nothing to retry.`);
  }
  task.implementationAttempts = 0;
  task.reviewRejections = 0;
  task.autoRecoveries = 0;
  if (opts.clearFeedback) {
    task.context.reviewFeedback = [];
  }
  task.stage = "implementation";
  log(task, task.stage, "ceo", opts.note ?? "Retrying implementation with a fresh budget.");
  return task;
}

/**
 * Reopens an already-shipped ("done") task for a further change, keeping
 * its full history (ideaBrief, architectureSpec, prior implementation) —
 * the CEO asking for more work on something already released, not a new
 * task starting from nothing. Routes through architecture (not straight to
 * implementation) for the same reason checkpoint_final rejections do: the
 * spec should actually reflect the new request, not just the code.
 */
export function amendShippedTask(task: TaskRecord, change: string): TaskRecord {
  if (task.stage !== "done") {
    throw new Error(`Task is not done (stage: ${task.stage}) — nothing to amend.`);
  }
  task.implementationAttempts = 0;
  task.reviewRejections = 0;
  task.architectureRounds = 0;
  task.autoRecoveries = 0;
  task.context.reviewFeedback = [change];
  task.stage = "architecture";
  log(task, task.stage, "ceo", `Amending shipped task: ${change}`);
  return task;
}
