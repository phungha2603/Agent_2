import "dotenv/config";
import type { Agents } from "./orchestrator/pipeline.js";
import type { PipelineConfig } from "./orchestrator/pipeline.js";
import { createMockAgent } from "./agents/mock.js";
import { createGeminiAgent } from "./agents/gemini.js";
import { createClaudeAgent } from "./agents/claude.js";
import { createClaudeCliAgent } from "./agents/claude-cli.js";
import { createMuseAgent } from "./agents/muse.js";

function provider(name: string): "real" | "mock" {
  const v = (process.env[name] ?? "mock").toLowerCase();
  return v === "real" ? "real" : "mock";
}

function claudeProvider(): "api" | "cli" | "mock" {
  const v = (process.env.CLAUDE_PROVIDER ?? "mock").toLowerCase();
  return v === "api" || v === "cli" ? v : "mock";
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
        ? createClaudeCliAgent({ command: process.env.CLAUDE_CLI_COMMAND, model: process.env.CLAUDE_MODEL })
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
      cwd: process.env.VERIFY_CWD ?? process.cwd(),
      commands: (process.env.VERIFY_COMMANDS ?? "echo 'no verification command configured'").split(",").map((s) => s.trim()),
    },
    maxImplementationAttempts: Number(process.env.MAX_IMPLEMENTATION_ATTEMPTS ?? 3),
    maxReviewRejections: Number(process.env.MAX_REVIEW_REJECTIONS ?? 3),
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (set it in .env, or switch that role back to mock).`);
  return v;
}
