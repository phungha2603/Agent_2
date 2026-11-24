import { spawn } from "node:child_process";
import type { Agent, AgentResponse, SendOptions, TaskContext, Usage } from "../types.js";
import { formatContext } from "./context.js";
import { LineDecoder, parseClaudeCliLine } from "./streamParsers.js";

class StreamFlagsUnsupported extends Error {}
class LeanFlagsUnsupported extends Error {}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI with the prompt on stdin, not argv: a review prompt carries
 * the whole implementation, and a single argument that large can exceed the
 * OS limit (128 KB per argument on Linux). Closing stdin also means the CLI
 * never sits waiting for more input.
 */
function abortError(): Error {
  const err = new Error("stopped by the CEO");
  err.name = "AbortError";
  return err;
}

function runCli(
  bin: string,
  args: string[],
  input: string,
  cwd: string | undefined,
  timeoutMs: number,
  onStdout?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not start "${bin}" (${err.message}) — set CLAUDE_CLI_COMMAND to the absolute path from \`which claude\``));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) reject(abortError());
      else if (timedOut) reject(new Error(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {
      // The process exited before reading all input; the close handler reports it.
    });
    child.stdin.end(input);
  });
}

/**
 * Drives the local `claude` CLI in headless mode (`claude -p`) instead of
 * calling the Claude API directly. Uses whatever subscription the CLI is
 * already logged in with on this machine (Pro/Max usage), not pay-per-token
 * API billing. Streams token-by-token via --output-format stream-json; if
 * the installed CLI doesn't know those flags, falls back to plain output
 * for the rest of the process's life.
 *
 * Token overhead: a default `claude -p` call carries Claude Code's whole
 * tool set, skills and MCP servers in its prompt — about 37,000 input tokens
 * for a one-word question, measured. This pipeline sends everything the
 * model needs in the prompt, so by default the built-in tools, MCP servers
 * and skills are switched off (~3,000 tokens, measured): `tools` = "" (the
 * default) is that lean mode, "Read,Grep,Glob" lets Claude open files from
 * the project itself (roughly 6,000-15,000 depending on the CLI's cache),
 * and "default" restores the full CLI.
 */
export function createClaudeCliAgent(
  opts: { command?: string; model?: string; cwd?: string; stream?: boolean; timeoutSec?: number; tools?: string } = {},
): Agent {
  const bin = opts.command ?? "claude";
  const timeoutMs = (opts.timeoutSec ?? 900) * 1000;
  const modelArgs = opts.model ? ["--model", opts.model] : [];
  let streaming = opts.stream ?? true;
  const toolsSetting = opts.tools ?? "";
  // An old CLI that doesn't know these flags falls back to the full CLI instead of failing every call.
  let lean = toolsSetting !== "default";
  const leanArgs = () =>
    lean ? ["--tools", toolsSetting, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands"] : [];

  async function runStreaming(input: string, onChunk?: (t: string) => void, signal?: AbortSignal): Promise<{ text: string; usage?: Usage }> {
    const lines = new LineDecoder();
    let partial = "";
    let assistant = "";
    let sawDelta = false;
    let result: { text: string; isError: boolean; usage?: Usage } | undefined;
    const handle = (line: string): void => {
      const ev = parseClaudeCliLine(line);
      if (ev.delta) {
        sawDelta = true;
        partial += ev.delta;
        onChunk?.(ev.delta);
      }
      for (const tool of ev.tools ?? []) onChunk?.(`\n[${tool}] `);
      if (ev.assistantText) {
        assistant += ev.assistantText;
        if (!sawDelta) onChunk?.(ev.assistantText);
      }
      if (ev.result) result = ev.result;
    };
    const proc = await runCli(
      bin,
      ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...modelArgs, ...leanArgs()],
      input,
      opts.cwd,
      timeoutMs,
      (chunk) => lines.push(chunk).forEach(handle),
      signal,
    );
    lines.flush().forEach(handle);
    if (!result && proc.code !== 0) {
      if (lean && /unknown option[^\n]*(--tools|--strict-mcp-config|--mcp-config|--disable-slash-commands)/i.test(proc.stderr)) throw new LeanFlagsUnsupported(proc.stderr);
      if (/unknown option|output-format|include-partial-messages|--verbose/i.test(proc.stderr)) throw new StreamFlagsUnsupported(proc.stderr);
      throw new Error(`claude CLI exited with code ${proc.code}: ${proc.stderr.slice(-2000)}`);
    }
    if (result?.isError) throw new Error(`claude CLI reported an error: ${result.text.slice(0, 2000)}`);
    return { text: (result?.text || assistant || partial).trim(), usage: result?.usage };
  }

  async function runPlain(input: string, onChunk?: (t: string) => void, signal?: AbortSignal): Promise<{ text: string; usage?: Usage }> {
    const proc = await runCli(bin, ["-p", ...modelArgs, ...leanArgs()], input, opts.cwd, timeoutMs, undefined, signal);
    if (proc.code !== 0) {
      if (lean && /unknown option[^\n]*(--tools|--strict-mcp-config|--mcp-config|--disable-slash-commands)/i.test(proc.stderr)) throw new LeanFlagsUnsupported(proc.stderr);
      throw new Error(`claude CLI exited with code ${proc.code}: ${proc.stderr.slice(-2000)}`);
    }
    const text = proc.stdout.trim();
    onChunk?.(text);
    return { text };
  }

  return {
    role: "claude",
    async send(prompt: string, context: TaskContext, sendOpts?: SendOptions): Promise<AgentResponse> {
      // With tools enabled ("Read,Grep,Glob" or "default"), headless
      // `claude -p` can check the actual project on disk — but only if it's
      // run from that project's directory, which is why cwd is VERIFY_CWD.
      const input = `${prompt}\n\n${formatContext(context)}`;
      const signal = sendOpts?.signal;
      const attempt = async (): Promise<{ text: string; usage?: Usage }> => {
        if (!streaming) return runPlain(input, sendOpts?.onChunk, signal);
        try {
          return await runStreaming(input, sendOpts?.onChunk, signal);
        } catch (err) {
          if (!(err instanceof StreamFlagsUnsupported)) throw err;
          streaming = false;
          return runPlain(input, sendOpts?.onChunk, signal);
        }
      };
      let out: { text: string; usage?: Usage };
      try {
        out = await attempt();
      } catch (err) {
        if (!(err instanceof LeanFlagsUnsupported)) throw err;
        lean = false;
        out = await attempt();
      }
      const verdict = prompt.startsWith("REVIEW:")
        ? (/\breject\b/i.test(out.text) ? "reject" : "approve")
        : undefined;
      return { role: "claude", content: out.text, verdict, usage: out.usage };
    },
  };
}
