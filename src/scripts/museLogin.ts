import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * One-off: logs in to Muse-Chat-MCP. `npm run selftest` in that repo does
 * NOT wait for login despite what its own README says — it launches Chrome,
 * checks status once, and closes immediately, every time. The only thing
 * that actually waits for you to sign in is the MCP tool `muse_login`
 * (a long poll with its own timeout_sec), and that tool only exists over
 * the MCP stdio protocol, not as a plain CLI command. This connects as a
 * minimal MCP client, calls that tool with a generous timeout, and leaves
 * the Chrome window open until you've signed in (or it times out) — run it
 * once to create the session under MUSE_PROFILE_DIR, and again later only
 * if that session ever expires.
 */
async function main(): Promise<void> {
  const serverPath = process.env.MUSE_MCP_SERVER_PATH;
  if (!serverPath) {
    throw new Error(
      "Set MUSE_MCP_SERVER_PATH in .env first — the absolute path to Muse-Chat-MCP/muse-server.mjs.",
    );
  }
  // 900s (15 min) is muse_login's own documented max; raise MUSE_LOGIN_TIMEOUT_SEC
  // only if the server's own cap is ever raised to match.
  const timeoutSec = Number(process.env.MUSE_LOGIN_TIMEOUT_SEC ?? 900);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const transport = new StdioClientTransport({ command: "node", args: [serverPath], env });
  const client = new Client({ name: "ai-company-muse-login", version: "0.1.0" });
  await client.connect(transport);

  console.log(`Connected to Muse-Chat-MCP. A Chrome window should open now — sign in with your Meta account within ${timeoutSec}s.`);

  const result = await client.callTool(
    { name: "muse_login", arguments: { timeout_sec: timeoutSec } },
    undefined,
    // The MCP request's own timeout must outlast muse_login's timeout_sec,
    // same reasoning as muse_chat in src/agents/muse.ts.
    { timeout: (timeoutSec + 60) * 1000 },
  );

  const text = Array.isArray(result.content)
    ? result.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
    : JSON.stringify(result);
  console.log(text);

  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
