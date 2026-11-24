import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeCliAgent } from "../src/agents/claude-cli.js";

/** A stand-in `claude`: prints the arguments it received as its answer, or rejects the lean flags like an old CLI would. */
function fakeClaude(rejectLeanFlags = false): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "fake-claude-")), "claude");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  if (${rejectLeanFlags} && args.includes("--tools")) {
    process.stderr.write("error: unknown option '--tools'\\n");
    process.exit(1);
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(args) }));
});
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const argsOf = async (agent: ReturnType<typeof createClaudeCliAgent>) => JSON.parse((await agent.send("x", { title: "t" })).content) as string[];

describe("Claude CLI lean mode", () => {
  it("turns off built-in tools, MCP servers and skills by default", async () => {
    const args = await argsOf(createClaudeCliAgent({ command: fakeClaude() }));
    expect(args).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--disable-slash-commands"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  });

  it("can allow just file reading, or restore the full CLI", async () => {
    const read = await argsOf(createClaudeCliAgent({ command: fakeClaude(), tools: "Read,Grep,Glob" }));
    expect(read[read.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    const full = await argsOf(createClaudeCliAgent({ command: fakeClaude(), tools: "default" }));
    expect(full).not.toContain("--tools");
    expect(full).not.toContain("--strict-mcp-config");
  });

  it("falls back to the full CLI, once, when an old CLI doesn't know the flags", async () => {
    const agent = createClaudeCliAgent({ command: fakeClaude(true) });
    const first = await argsOf(agent);
    expect(first).not.toContain("--tools");
    expect(first).toContain("--output-format"); // streaming still on
    expect(await argsOf(agent)).not.toContain("--tools"); // and it stays off, no repeated failing attempt
  });
});
