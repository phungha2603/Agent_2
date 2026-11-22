import type { Agent, HistoryEntry, ProjectConfig, RoleName, Stage, TaskRecord } from "../types.js";
import type { VerifyConfig } from "../verify/runner.js";
import { runVerification } from "../verify/runner.js";
import { newTaskId } from "../store/taskStore.js";
import { parseFileBlocks, writeFiles } from "../apply/applyFiles.js";

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
    projectConfig,
  };
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
  visual?: VisualConfig;
}

const PROMPTS = {
  ideation:
    "You are the ideation lead. Propose a concrete idea/feature brief for this task: goals, target users, rough scope. Keep it short. " +
    "If feedback from a previous round is included below, this is a revision of the brief itself — rewrite it to actually reflect the new direction the feedback describes, replacing anything in the old brief that now contradicts it, not just appending a note.",
  architecture:
    "You are the architecture lead. Do NOT write code. Write an implementation spec (modules, data flow, interfaces, key decisions) that an engineer will follow exactly. " +
    "If feedback from a previous round is included below, this is a revision: write a full updated spec that actually changes to address that feedback — don't repeat the previous design unchanged.",
  implementation:
    "You are the engineer. Implement the following architecture spec in code.\n" +
    "For every file you create or change, write a line starting with exactly:\n" +
    "FILE: relative/path/to/file.ext\n" +
    "followed by the FULL contents of that file (not a diff), then the next FILE: line for the next file. " +
    "Do not skip writing a file's contents, and do not just describe what a file would contain.",
  reviewGemini:
    "REVIEW: Review this implementation against the idea brief and verification log. " +
    "If a reference style image and a screenshot of the running implementation are attached, compare them directly — " +
    "say concretely where the screenshot matches or deviates from the reference's look (composition, color, mood, missing/extra elements), not just whether the code builds. " +
    "Approve or reject, with reasons.",
  reviewClaude: "REVIEW: Final sign-off review. Check the implementation matches the architecture spec and passed verification. Approve or reject, with reasons.",
};

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

function log(task: TaskRecord, stage: Stage, by: RoleName, summary: string): void {
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

/** Terminal stages, or stages that need a human decision before they can proceed. */
export function isWaitingForHuman(task: TaskRecord): boolean {
  return task.stage === "checkpoint_idea" || task.stage === "checkpoint_final";
}

export function isTerminal(task: TaskRecord): boolean {
  return task.stage === "done" || task.stage === "rejected";
}

/**
 * Runs the current stage's action and moves the task to its next stage.
 * Must not be called while isWaitingForHuman(task) or isTerminal(task) — use
 * resolveCheckpoint for the former.
 */
export async function advance(task: TaskRecord, agents: Agents, config: PipelineConfig): Promise<TaskRecord> {
  switch (task.stage) {
    case "ideation": {
      const res = await agents.gemini.send(PROMPTS.ideation, task.context);
      task.context.ideaBrief = res.content;
      log(task, task.stage, "gemini", "Idea brief drafted.");
      await ensureReferenceImage(task, config);
      task.stage = "checkpoint_idea";
      return task;
    }

    case "architecture": {
      const res = await agents.claude.send(PROMPTS.architecture, task.context);
      task.context.architectureSpec = res.content;
      log(task, task.stage, "claude", "Architecture spec written.");
      // Also checked here, not just in ideation: a task can reach
      // architecture for the first time well after ideation (e.g. the
      // visual loop was turned on partway through, or this is a
      // checkpoint_final redesign), and this is still the right moment to
      // have a reference image before implementation starts.
      await ensureReferenceImage(task, config);
      task.stage = "implementation";
      return task;
    }

    case "implementation": {
      const feedback = task.context.reviewFeedback?.length
        ? `\n\nAddress this feedback from the previous attempt:\n${task.context.reviewFeedback.join("\n")}`
        : "";
      const res = await agents.muse.send(PROMPTS.implementation + feedback, task.context);
      task.context.implementationDiff = res.content;
      task.implementationAttempts += 1;

      const files = parseFileBlocks(res.content);
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
        task.stage = "rejected";
      }
      return task;
    }

    case "review_gemini": {
      const res = await agents.gemini.send(PROMPTS.reviewGemini, task.context);
      log(task, task.stage, "gemini", `Verdict: ${res.verdict ?? "unknown"}.`);
      if (res.verdict === "approve") {
        task.context.reviewFeedback = [];
        task.stage = "review_claude";
      } else {
        task.reviewRejections += 1;
        task.context.reviewFeedback = [`Gemini review feedback:\n${res.content}`];
        task.stage = task.reviewRejections < config.maxReviewRejections ? "implementation" : "rejected";
      }
      return task;
    }

    case "review_claude": {
      const res = await agents.claude.send(PROMPTS.reviewClaude, task.context);
      log(task, task.stage, "claude", `Verdict: ${res.verdict ?? "unknown"}.`);
      if (res.verdict === "approve") {
        task.stage = "checkpoint_final";
      } else {
        task.reviewRejections += 1;
        task.context.reviewFeedback = [`Claude review feedback:\n${res.content}`];
        task.stage = task.reviewRejections < config.maxReviewRejections ? "implementation" : "rejected";
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
    }
  }
  if (!approved && feedback) {
    task.context.reviewFeedback = [feedback];
  }
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
  task.context.reviewFeedback = [change];
  task.stage = "architecture";
  log(task, task.stage, "ceo", `Amending shipped task: ${change}`);
  return task;
}
