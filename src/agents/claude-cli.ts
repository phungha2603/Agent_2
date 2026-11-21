import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Agent, AgentResponse, TaskContext } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Drives the local `claude` CLI in headless mode (`claude -p`) instead of
 * calling the Claude API directly. Uses whatever subscription the CLI is
 * already logged in with on this machine (Pro/Max usage), not pay-per-token
 * API billing.
 */
export function createClaudeCliAgent(opts: { command?: string; model?: string } = {}): Agent {
  const bin = opts.command ?? "claude";
  return {
    role: "claude",
    async send(prompt: string, context: TaskContext): Promise<AgentResponse> {
      const args = ["-p", `${prompt}\n\nTask: ${context.title}`];
      if (opts.model) args.push("--model", opts.model);
      const { stdout } = await execFileAsync(bin, args, { maxBuffer: 10 * 1024 * 1024 });
      const text = stdout.trim();
      const verdict = prompt.startsWith("REVIEW:")
        ? (/\breject\b/i.test(text) ? "reject" : "approve")
        : undefined;
      return { role: "claude", content: text, verdict };
    },
  };
}
