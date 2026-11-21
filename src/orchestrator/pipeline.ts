import type { Agent, HistoryEntry, RoleName, Stage, TaskRecord } from "../types.js";
import type { VerifyConfig } from "../verify/runner.js";
import { runVerification } from "../verify/runner.js";
import { newTaskId } from "../store/taskStore.js";
import { parseFileBlocks, writeFiles } from "../apply/applyFiles.js";

export function createTask(title: string): TaskRecord {
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
  };
}

export interface Agents {
  gemini: Agent;
  claude: Agent;
  muse: Agent;
}

/**
 * Optional visual review loop: Gemini generates a reference style image at
 * ideation time, and a real screenshot of the running implementation is
 * taken after verification passes, so review_gemini can compare the two
 * instead of only reading text. Both steps degrade gracefully (logged, not
 * fatal) if generation or the dev server fails — a missing image means the
 * review just falls back to text only, it doesn't block the pipeline.
 */
export interface VisualConfig {
  referenceImagePrompt: string;
  referenceImagePath: string;
  screenshotPath: string;
  devCommand: string;
  devUrl: string;
  screenshotWaitMs?: number;
  generateImage: (prompt: string, outPath: string) => Promise<string>;
  captureScreenshot: (opts: { cwd: string; devCommand: string; url: string; outPath: string; waitMs?: number }) => Promise<string>;
}

export interface PipelineConfig {
  verify: VerifyConfig;
  maxImplementationAttempts: number;
  maxReviewRejections: number;
  visual?: VisualConfig;
}

const PROMPTS = {
  ideation:
    "You are the ideation lead. Propose a concrete idea/feature brief for this task: goals, target users, rough scope. Keep it short.",
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

function log(task: TaskRecord, stage: Stage, by: RoleName, summary: string): void {
  const entry: HistoryEntry = { stage, at: new Date().toISOString(), by, summary };
  task.history.push(entry);
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

      if (config.visual && !task.context.referenceImagePath) {
        try {
          await config.visual.generateImage(config.visual.referenceImagePrompt, config.visual.referenceImagePath);
          task.context.referenceImagePath = config.visual.referenceImagePath;
          log(task, task.stage, "gemini", `Reference style image generated at ${config.visual.referenceImagePath}.`);
        } catch (err) {
          log(task, task.stage, "system", `Reference image generation failed (continuing without it): ${(err as Error).message}`);
        }
      }

      task.stage = "checkpoint_idea";
      return task;
    }

    case "architecture": {
      const res = await agents.claude.send(PROMPTS.architecture, task.context);
      task.context.architectureSpec = res.content;
      log(task, task.stage, "claude", "Architecture spec written.");
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
        const written = await writeFiles(config.verify.cwd, files);
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
      const result = await runVerification(config.verify);
      task.context.verificationLog = result.log;
      log(task, task.stage, "system", result.passed ? "Verification passed." : "Verification FAILED.");
      if (result.passed) {
        if (config.visual) {
          try {
            await config.visual.captureScreenshot({
              cwd: config.verify.cwd,
              devCommand: config.visual.devCommand,
              url: config.visual.devUrl,
              outPath: config.visual.screenshotPath,
              waitMs: config.visual.screenshotWaitMs,
            });
            task.context.implementationScreenshotPath = config.visual.screenshotPath;
            log(task, task.stage, "system", `Screenshot of the running implementation captured at ${config.visual.screenshotPath}.`);
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
      // Route back through architecture, not straight to implementation:
      // a human rejecting at the final checkpoint after both agents already
      // signed off is usually asking for a direction change, not a small
      // code fix — and the engineer is bound by architectureSpec, so if it
      // doesn't change to reflect the feedback, the next attempt just gets
      // re-approved against the same unchanged spec.
      task.stage = "architecture";
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
