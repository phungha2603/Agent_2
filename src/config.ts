import "dotenv/config";
import path from "node:path";
import type { Agents } from "./orchestrator/pipeline.js";
import type { PipelineConfig, VisualConfig } from "./orchestrator/pipeline.js";
import { createMockAgent } from "./agents/mock.js";
import { createGeminiAgent } from "./agents/gemini.js";
import { createGeminiImageGenerator } from "./agents/geminiImage.js";
import { createClaudeAgent } from "./agents/claude.js";
import { createClaudeCliAgent } from "./agents/claude-cli.js";
import { createMuseAgent } from "./agents/muse.js";
import { screenshotDevServer } from "./verify/screenshot.js";

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
        ? createClaudeCliAgent({ command: process.env.CLAUDE_CLI_COMMAND, model: process.env.CLAUDE_MODEL, cwd: verifyCwd() })
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
      commands: (process.env.VERIFY_COMMANDS ?? "echo 'no verification command configured'").split(",").map((s) => s.trim()),
    },
    maxImplementationAttempts: Number(process.env.MAX_IMPLEMENTATION_ATTEMPTS ?? 3),
    maxReviewRejections: Number(process.env.MAX_REVIEW_REJECTIONS ?? 3),
    visual: buildVisualConfig(),
  };
}

/**
 * Enabled by setting REFERENCE_IMAGE_PROMPT — everything else has a
 * sensible default. Needs GEMINI_API_KEY regardless of GEMINI_PROVIDER,
 * since image generation is a separate use of the Gemini API.
 */
function buildVisualConfig(): VisualConfig | undefined {
  const referenceImagePrompt = process.env.REFERENCE_IMAGE_PROMPT;
  if (!referenceImagePrompt) return undefined;

  const imageGenerator = createGeminiImageGenerator({
    apiKey: requireEnv("GEMINI_API_KEY"),
    model: process.env.GEMINI_IMAGE_MODEL,
  });
  const visualDataDir = path.resolve(process.cwd(), "data/visual");

  return {
    referenceImagePrompt,
    referenceImagePath: path.join(visualDataDir, "reference.png"),
    screenshotPath: path.join(visualDataDir, "screenshot.png"),
    devCommand: process.env.DEV_SERVER_COMMAND ?? "npm run dev",
    devUrl: process.env.DEV_SERVER_URL ?? "http://localhost:5173",
    screenshotWaitMs: process.env.SCREENSHOT_WAIT_MS ? Number(process.env.SCREENSHOT_WAIT_MS) : undefined,
    generateImage: (prompt, outPath) => imageGenerator.generate(prompt, outPath),
    captureScreenshot: (opts) => screenshotDevServer(opts),
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (set it in .env, or switch that role back to mock).`);
  return v;
}
