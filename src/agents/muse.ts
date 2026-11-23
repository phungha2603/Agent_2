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

  function getClient(): Promise<Client> {
    if (!clientPromise) {
      clientPromise = (async () => {
        const transport = new StdioClientTransport({
          command: "node",
          args: [opts.serverPath],
          env: opts.profileDir
            ? { ...processEnvSnapshot(), MUSE_PROFILE_DIR: opts.profileDir }
            : processEnvSnapshot(),
        });
        const c = new Client({ name: "ai-company-orchestrator", version: "0.1.0" });
        await c.connect(transport);
        return c;
      })().catch((err) => {
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
      const c = await getClient();
      const timeoutSec = opts.timeoutSec ?? 300;
      const result = await c.callTool(
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
      let reply = rawText;
      try {
        const parsed = JSON.parse(rawText);
        if (parsed && typeof parsed.reply === "string") {
          reply = parsed.reply;
        }
      } catch {
        // Not JSON (e.g. an error string) — use rawText as-is.
      }
      return { role: "muse", content: reply };
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
