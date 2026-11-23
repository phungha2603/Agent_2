import "dotenv/config";
import path from "node:path";
import type { ProjectConfig } from "./types.js";
import type { Agents } from "./orchestrator/pipeline.js";
import type { PipelineConfig, VisualConfig } from "./orchestrator/pipeline.js";
import { createMockAgent } from "./agents/mock.js";
import { createGeminiAgent } from "./agents/gemini.js";
import { createGeminiImageGenerator } from "./agents/geminiImage.js";
import { createClaudeAgent } from "./agents/claude.js";
import { createClaudeCliAgent } from "./agents/claude-cli.js";
import { createMuseAgent } from "./agents/muse.js";
import { screenshotBuildOutput } from "./verify/screenshot.js";
import type { SchedulerSettings } from "./orchestrator/scheduler.js";

function provider(name: string): "real" | "mock" {
  const v = (process.env[name] ?? "mock").toLowerCase();
  return v === "real" ? "real" : "mock";
}

function claudeProvider(): "api" | "cli" | "mock" {
  const v = (process.env.CLAUDE_PROVIDER ?? "mock").toLowerCase();
  return v === "api" || v === "cli" ? v : "mock";
}

function verifyCwd(): string {
  return process.env.VERIFY_CWD ?? process.cwd();
}

function verifyCommands(): string[] {
  return (process.env.VERIFY_COMMANDS ?? "echo 'no verification command configured'").split(",").map((s) => s.trim());
}

const VISUAL_DATA_DIR = path.resolve(process.cwd(), "data/visual");

/**
 * What a new task should remember about "how to build/review it", read
 * from .env at the moment it's created. Pass this to createTask() so a
 * later unrelated change to .env (a different project, a different
 * REFERENCE_IMAGE_PROMPT) doesn't retroactively change this task's rules —
 * see ProjectConfig's doc comment.
 */
export function buildProjectConfigSnapshot(): ProjectConfig {
  const referenceImagePrompt = process.env.REFERENCE_IMAGE_PROMPT;
  return {
    verifyCwd: verifyCwd(),
    verifyCommands: verifyCommands(),
    referenceImagePrompt,
    referenceImagePath: referenceImagePrompt ? path.join(VISUAL_DATA_DIR, "reference.png") : undefined,
    screenshotPath: referenceImagePrompt ? path.join(VISUAL_DATA_DIR, "screenshot.png") : undefined,
    buildDir: process.env.BUILD_OUTPUT_DIR,
    screenshotWaitMs: process.env.SCREENSHOT_WAIT_MS ? Number(process.env.SCREENSHOT_WAIT_MS) : undefined,
  };
}

export function buildAgents(): Agents {
  const gemini =
    provider("GEMINI_PROVIDER") === "real"
      ? createGeminiAgent({ apiKey: requireEnv("GEMINI_API_KEY"), model: process.env.GEMINI_MODEL })
      : createMockAgent("gemini");

  const claudeMode = claudeProvider();
  const claude =
    claudeMode === "api"
      ? createClaudeAgent({ apiKey: requireEnv("ANTHROPIC_API_KEY"), model: process.env.CLAUDE_MODEL })
      : claudeMode === "cli"
        ? createClaudeCliAgent({
            command: process.env.CLAUDE_CLI_COMMAND,
            model: process.env.CLAUDE_MODEL,
            cwd: verifyCwd(),
            stream: (process.env.CLAUDE_CLI_STREAM ?? "1") !== "0",
            timeoutSec: num("CLAUDE_CLI_TIMEOUT_SEC", 900),
          })
        : createMockAgent("claude");

  const muse =
    provider("MUSE_PROVIDER") === "real"
      ? createMuseAgent({
          serverPath: requireEnv("MUSE_MCP_SERVER_PATH"),
          profileDir: process.env.MUSE_PROFILE_DIR,
          timeoutSec: process.env.MUSE_TIMEOUT_SEC ? Number(process.env.MUSE_TIMEOUT_SEC) : undefined,
        })
      : createMockAgent("muse");

  return { gemini, claude, muse };
}

export function buildPipelineConfig(): PipelineConfig {
  return {
    verify: {
      cwd: verifyCwd(),
      commands: verifyCommands(),
    },
    maxImplementationAttempts: num("MAX_IMPLEMENTATION_ATTEMPTS", 3),
    maxReviewRejections: num("MAX_REVIEW_REJECTIONS", 3),
    maxArchitectureRounds: num("MAX_ARCHITECTURE_ROUNDS", 20),
    maxAutoRecoveries: num("MAX_AUTO_RECOVERIES", 1),
    visual: buildVisualConfig(),
  };
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(v) ? v : fallback;
}

/** "AG-05:2,AG-03:2" -> { "AG-05": 2, "AG-03": 2 } */
function parseSlotParallel(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (raw ?? "").split(",")) {
    const [id, n] = part.split(":").map((s) => s.trim());
    const value = Number(n);
    if (id && Number.isInteger(value) && value > 0) out[id] = value;
  }
  return out;
}

export function buildSchedulerSettings(): SchedulerSettings {
  const handoffOn = process.env.HANDOFF_ON === "done" ? "done" : "checkpoint_final";
  return {
    claudeConcurrency: Math.max(1, num("CLAUDE_CONCURRENCY", 2)),
    geminiConcurrency: Math.max(1, num("GEMINI_CONCURRENCY", 2)),
    defaultSlotParallel: Math.max(1, num("SLOT_MAX_PARALLEL", 1)),
    slotParallel: parseSlotParallel(process.env.SLOT_PARALLEL_OVERRIDES),
    stageErrorRetries: Math.max(0, num("STAGE_ERROR_RETRIES", 2)),
    stageErrorBackoffMs: [5000, 20000, 60000],
    handoffOn,
    planMaxRounds: Math.max(1, num("PLAN_MAX_REVIEW_ROUNDS", 3)),
    planLimits: { maxEpics: Math.max(1, num("PLAN_MAX_EPICS", 3)), maxSubtasks: Math.max(1, num("PLAN_MAX_SUBTASKS", 8)) },
  };
}

/**
 * Enabled by setting REFERENCE_IMAGE_PROMPT — everything else has a
 * sensible default. Needs GEMINI_API_KEY regardless of GEMINI_PROVIDER,
 * since image generation is a separate use of the Gemini API. This is the
 * live/default config; which task actually uses which parts of it goes
 * through resolveVisual() in the pipeline against each task's own
 * ProjectConfig snapshot (see buildProjectConfigSnapshot above).
 */
function buildVisualConfig(): VisualConfig | undefined {
  const referenceImagePrompt = process.env.REFERENCE_IMAGE_PROMPT;
  if (!referenceImagePrompt) return undefined;

  const imageGenerator = createGeminiImageGenerator({
    apiKey: requireEnv("GEMINI_API_KEY"),
    model: process.env.GEMINI_IMAGE_MODEL,
  });

  return {
    referenceImagePrompt,
    referenceImagePath: path.join(VISUAL_DATA_DIR, "reference.png"),
    screenshotPath: path.join(VISUAL_DATA_DIR, "screenshot.png"),
    buildDir: process.env.BUILD_OUTPUT_DIR ?? "dist",
    screenshotWaitMs: process.env.SCREENSHOT_WAIT_MS ? Number(process.env.SCREENSHOT_WAIT_MS) : undefined,
    generateImage: (prompt, outPath) => imageGenerator.generate(prompt, outPath),
    captureScreenshot: (opts) => screenshotBuildOutput(opts),
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (set it in .env, or switch that role back to mock).`);
  return v;
}
