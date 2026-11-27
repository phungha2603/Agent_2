import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Agent, AgentResponse, SendOptions, TaskContext } from "../types.js";
import { formatContext } from "./context.js";

/**
 * Drives the Muse-Chat-MCP server (github.com/duclm1x1/Muse-Chat-MCP) over
 * stdio. That server automates a locally logged-in Chrome session, so this
 * only works on a machine that has already logged in once to create its
 * .muse-profile session — via `npm run muse:login` here, not that repo's
 * own `npm run selftest` (which, despite what its README claims, never
 * actually waits for login: it launches, checks status once, and closes
 * immediately).
 *
 * Create ONE of these per process and reuse it: each instance spawns its own
 * muse-server.mjs, and two of those would fight over the same Chrome
 * profile. Muse-Chat-MCP has no streaming over MCP (only its HTTP shim
 * streams), so onChunk is never called — the dashboard shows elapsed time
 * instead.
 */
export function createMuseAgent(opts: { serverPath: string; profileDir?: string; timeoutSec?: number }): Agent {
  let clientPromise: Promise<Client> | null = null;
  // A previous dead client's close() in flight — Chrome's user-data-dir
  // carries a lock file, so spawning the next muse-server.mjs for the same
  // profile before the old one has actually exited gets rejected as "already
  // in use" and falls back to a throwaway (logged-out) profile instead of
  // erroring. getClient() below waits on this so the handoff is sequential.
  let closing: Promise<void> = Promise.resolve();

  function getClient(): Promise<Client> {
    if (!clientPromise) {
      clientPromise = closing
        .then(async () => {
          const transport = new StdioClientTransport({
            command: "node",
            args: [opts.serverPath],
            // MUSE_SHIM_PORT=0: muse-server.mjs otherwise also opens an
            // OpenAI-compatible HTTP shim on fixed port 8787, which this
            // orchestrator never uses — and with an account pool, every
            // server after the first failed to bind it and crashed, so all
            // but one account answered "Connection closed".
            env: {
              ...processEnvSnapshot(),
              MUSE_SHIM_PORT: "0",
              ...(opts.profileDir ? { MUSE_PROFILE_DIR: opts.profileDir } : {}),
            },
          });
          const c = new Client({ name: "ai-company-orchestrator", version: "0.1.0" });
          await c.connect(transport);
          return c;
        })
        .catch((err) => {
          clientPromise = null; // let the next call try to connect again
          throw err;
        });
    }
    return clientPromise;
  }

  return {
    role: "muse",
    async close(): Promise<void> {
      const pending = clientPromise;
      clientPromise = null;
      if (pending) await (await pending.catch(() => null))?.close();
    },
    async send(prompt: string, context: TaskContext, sendOpts?: SendOptions): Promise<AgentResponse> {
      const clientRef = getClient();
      const c = await clientRef;
      const timeoutSec = opts.timeoutSec ?? 300;
      let result: Awaited<ReturnType<Client["callTool"]>>;
      try {
        result = await c.callTool(
          {
            name: "muse_chat",
            arguments: {
              prompt: `${prompt}\n\n${formatContext(context)}`,
              timeout_sec: timeoutSec,
            },
          },
          undefined,
          // The MCP client's own request timeout is separate from muse_chat's
          // timeout_sec argument above — give it extra headroom so a long
          // reply (Muse typing a real answer in the browser) isn't cut off
          // first by the transport layer.
          { timeout: (timeoutSec + 60) * 1000, signal: sendOpts?.signal },
        );
      } catch (err) {
        // The connection can die mid-session (muse-server.mjs's child
        // process crashing, its browser session dropping, ...) — if we kept
        // the now-dead client cached, every later call (including the CEO's
        // own "Retry") would reuse the same broken connection and fail
        // identically forever instead of reconnecting. Only drop it if it's
        // still the same client this call started with (another concurrent
        // failure may already have replaced it).
        if (clientPromise === clientRef) {
          clientPromise = null;
          closing = clientRef.then((old) => old.close()).catch(() => {});
        }
        throw err;
      }
      const rawText = Array.isArray(result.content)
        ? result.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n")
        : "";
      // muse-server.mjs wraps muse_chat's whole result object
      // ({ reply, messages, threadUrl, ... }) as one JSON-stringified text
      // block, so the actual chat reply is nested inside it — unwrap it,
      // falling back to the raw text if it isn't JSON shaped that way.
      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        // Not JSON (e.g. an error string) — use rawText as-is.
      }
      if (!parsed || typeof parsed.reply !== "string") return { role: "muse", content: rawText };
      return { role: "muse", content: museReplyOrThrow(parsed, timeoutSec) };
    },
  };
}

/**
 * The reply text, only if it is the Markdown Muse wrote. Text read off the
 * rendered chat page ("rendered-text", or an older Muse-Chat-MCP that
 * doesn't say) has already lost `#` comments, indentation and `__names__`,
 * and writing it to disk as code is how projects got corrupted — so that is
 * an error, never a reply. A timed-out reply is cut off mid-file, so it is
 * one too.
 */
export function museReplyOrThrow(parsed: { reply: string; replyFormat?: string; timedOut?: boolean; error?: string }, timeoutSec: number): string {
  if (parsed.timedOut) {
    throw new Error(`Muse did not finish replying within ${timeoutSec}s (MUSE_TIMEOUT_SEC) — the partial reply was discarded.`);
  }
  if (!parsed.reply.trim() && parsed.error) throw new Error(`Muse reported an error: ${parsed.error}`);
  if (parsed.replyFormat !== "markdown-copy" && parsed.replyFormat !== "markdown-dom") {
    throw new Error(
      parsed.replyFormat
        ? `Muse-Chat-MCP could only read the reply as rendered page text (${parsed.replyFormat}), not as Markdown — refusing to use it as code.`
        : "Muse-Chat-MCP did not say how it read the reply (no replyFormat) — it is an older version that returns rendered page text, which corrupts code. Update it to the branch that reads replies as Markdown.",
    );
  }
  return parsed.reply;
}

/**
 * Pools several Muse agents — typically one createMuseAgent per logged-in
 * account (each its own Chrome profile, created via `npm run muse:login`
 * with a distinct MUSE_PROFILE_DIR) — so up to `pool.length` chats run at
 * once, one per account, instead of the single-browser "always one at a
 * time" limit of a lone createMuseAgent. Pairs with Company's
 * `museConcurrency` setting, which should match the pool size so the
 * scheduler actually lets that many calls through.
 */
export function createMusePoolAgent(pool: Agent[]): Agent {
  if (pool.length === 0) throw new Error("createMusePoolAgent requires at least one agent");
  const idle: number[] = pool.map((_, i) => i);
  const waiters: ((index: number) => void)[] = [];

  function acquire(): Promise<number> {
    const next = idle.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => waiters.push(resolve));
  }
  function release(index: number): void {
    const waiter = waiters.shift();
    if (waiter) waiter(index);
    else idle.push(index);
  }

  return {
    role: "muse",
    async send(prompt: string, context: TaskContext, sendOpts?: SendOptions): Promise<AgentResponse> {
      const index = await acquire();
      try {
        return await pool[index].send(prompt, context, sendOpts);
      } finally {
        release(index);
      }
    },
    async close(): Promise<void> {
      await Promise.all(pool.map((account) => account.close?.()));
    },
  };
}

function processEnvSnapshot(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}
