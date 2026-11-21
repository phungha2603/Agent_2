import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Agent, AgentResponse, TaskContext } from "../types.js";
import { formatContext } from "./context.js";

/**
 * Drives the Muse-Chat-MCP server (github.com/duclm1x1/Muse-Chat-MCP) over
 * stdio. That server automates a locally logged-in Chrome session, so this
 * only works on a machine that has already run `npm run selftest` once
 * against that server to create its .muse-profile login.
 */
export function createMuseAgent(opts: { serverPath: string; profileDir?: string; timeoutSec?: number }): Agent {
  let client: Client | null = null;

  async function getClient(): Promise<Client> {
    if (client) return client;
    const transport = new StdioClientTransport({
      command: "node",
      args: [opts.serverPath],
      env: opts.profileDir
        ? { ...processEnvSnapshot(), MUSE_PROFILE_DIR: opts.profileDir }
        : processEnvSnapshot(),
    });
    const c = new Client({ name: "ai-company-orchestrator", version: "0.1.0" });
    await c.connect(transport);
    client = c;
    return c;
  }

  return {
    role: "muse",
    async send(prompt: string, context: TaskContext): Promise<AgentResponse> {
      const c = await getClient();
      const result = await c.callTool({
        name: "muse_chat",
        arguments: {
          prompt: `${prompt}\n\n${formatContext(context)}`,
          timeout_sec: opts.timeoutSec ?? 120,
        },
      });
      const text = Array.isArray(result.content)
        ? result.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n")
        : "";
      return { role: "muse", content: text };
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
