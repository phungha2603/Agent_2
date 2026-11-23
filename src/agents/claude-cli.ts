import { spawn } from "node:child_process";
import type { Agent, AgentResponse, SendOptions, TaskContext, Usage } from "../types.js";
import { formatContext } from "./context.js";
import { LineDecoder, parseClaudeCliLine } from "./streamParsers.js";

class StreamFlagsUnsupported extends Error {}

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
 */
export function createClaudeCliAgent(
  opts: { command?: string; model?: string; cwd?: string; stream?: boolean; timeoutSec?: number } = {},
): Agent {
  const bin = opts.command ?? "claude";
  const timeoutMs = (opts.timeoutSec ?? 900) * 1000;
  const modelArgs = opts.model ? ["--model", opts.model] : [];
  let streaming = opts.stream ?? true;

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
      ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...modelArgs],
      input,
      opts.cwd,
      timeoutMs,
      (chunk) => lines.push(chunk).forEach(handle),
      signal,
    );
    lines.flush().forEach(handle);
    if (!result && proc.code !== 0) {
      if (/unknown option|output-format|include-partial-messages|--verbose/i.test(proc.stderr)) throw new StreamFlagsUnsupported(proc.stderr);
      throw new Error(`claude CLI exited with code ${proc.code}: ${proc.stderr.slice(-2000)}`);
    }
    if (result?.isError) throw new Error(`claude CLI reported an error: ${result.text.slice(0, 2000)}`);
    return { text: (result?.text || assistant || partial).trim(), usage: result?.usage };
  }

  async function runPlain(input: string, onChunk?: (t: string) => void, signal?: AbortSignal): Promise<{ text: string; usage?: Usage }> {
    const proc = await runCli(bin, ["-p", ...modelArgs], input, opts.cwd, timeoutMs, undefined, signal);
    if (proc.code !== 0) throw new Error(`claude CLI exited with code ${proc.code}: ${proc.stderr.slice(-2000)}`);
    const text = proc.stdout.trim();
    onChunk?.(text);
    return { text };
  }

  return {
    role: "claude",
    async send(prompt: string, context: TaskContext, sendOpts?: SendOptions): Promise<AgentResponse> {
      // Headless `claude -p` still has real tool access (Bash, Read, ...),
      // so it can independently check the actual project on disk — but
      // only if it's run from that project's directory, not wherever this
      // orchestrator script happens to live.
      const input = `${prompt}\n\n${formatContext(context)}`;
      const signal = sendOpts?.signal;
      let out: { text: string; usage?: Usage };
      if (streaming) {
        try {
          out = await runStreaming(input, sendOpts?.onChunk, signal);
        } catch (err) {
          if (!(err instanceof StreamFlagsUnsupported)) throw err;
          streaming = false;
          out = await runPlain(input, sendOpts?.onChunk, signal);
        }
      } else {
        out = await runPlain(input, sendOpts?.onChunk, signal);
      }
      const verdict = prompt.startsWith("REVIEW:")
        ? (/\breject\b/i.test(out.text) ? "reject" : "approve")
        : undefined;
      return { role: "claude", content: out.text, verdict, usage: out.usage };
    },
  };
}
