import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { advance, createTask, type PipelineConfig } from "../src/orchestrator/pipeline.js";
import { createMockAgent } from "../src/agents/mock.js";
import { shadowDirFor } from "../src/verify/workspace.js";
import type { Agent, AgentResponse } from "../src/types.js";

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p));
const agents = (muse: Agent) => ({ gemini: createMockAgent("gemini"), claude: createMockAgent("claude"), muse });
const museWriting = (files: Record<string, string>): Agent => ({
  role: "muse",
  async send(): Promise<AgentResponse> {
    return { role: "muse", content: Object.entries(files).map(([p, c]) => `FILE: ${p}\n\`\`\`\n${c}\`\`\``).join("\n\n") };
  },
});

function setup(commands: string[]) {
  const project = tmp("iso-project-");
  writeFileSync(path.join(project, "keep.txt"), "approved content\n");
  const cfg: PipelineConfig = {
    verify: { cwd: project, commands },
    maxImplementationAttempts: 1,
    maxReviewRejections: 3,
    isolation: { root: tmp("iso-root-"), exclude: [".build"] },
  };
  return { project, cfg };
}

async function implementAndVerify(cfg: PipelineConfig, muse: Agent) {
  const task = createTask("iso");
  task.stage = "implementation";
  await advance(task, agents(muse), cfg); // implementation: checks only, nothing written
  expect(task.stage).toBe("verification");
  await advance(task, agents(muse), cfg);
  return task;
}

describe("isolated verification", () => {
  it("writes nothing to the project until verification passes, then promotes exactly the attempt's files", async () => {
    // The test command has a side effect (like a test regenerating the Xcode project): it must stay in the copy.
    const { project, cfg } = setup(["test -f new.txt", "echo regenerated > keep.txt"]);
    const task = await implementAndVerify(cfg, museWriting({ "new.txt": "hello\n" }));
    expect(task.stage).toBe("review_gemini");
    expect(readFileSync(path.join(project, "new.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(path.join(project, "keep.txt"), "utf8")).toBe("approved content\n");
    expect(task.context.verificationLog).toMatch(/isolated copy/);
  });

  it("leaves the project untouched when verification fails — including files the attempt overwrote", async () => {
    const { project, cfg } = setup(["false"]);
    const task = await implementAndVerify(cfg, museWriting({ "keep.txt": "broken rewrite\n", "new.txt": "x\n" }));
    expect(task.stage).toBe("rejected");
    expect(readFileSync(path.join(project, "keep.txt"), "utf8")).toBe("approved content\n");
    expect(existsSync(path.join(project, "new.txt"))).toBe(false);
  });

  it("keeps the copy in sync with the project but leaves excluded build caches in place", async () => {
    const { project, cfg } = setup(["true"]);
    const shadow = shadowDirFor(project, cfg.isolation!);
    mkdirSync(path.join(shadow, ".build"), { recursive: true });
    writeFileSync(path.join(shadow, ".build", "cache"), "warm");
    writeFileSync(path.join(shadow, "stale.txt"), "left over from an earlier attempt");
    await implementAndVerify(cfg, museWriting({ "a.txt": "a\n" }));
    expect(readFileSync(path.join(shadow, ".build", "cache"), "utf8")).toBe("warm");
    expect(existsSync(path.join(shadow, "stale.txt"))).toBe(false);
    expect(readFileSync(path.join(shadow, "keep.txt"), "utf8")).toBe("approved content\n");
  });
});
