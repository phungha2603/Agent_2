import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { advance, applyImplementation, createTask, specProblem, type PipelineConfig } from "../src/orchestrator/pipeline.js";
import { createMockAgent } from "../src/agents/mock.js";
import { formatContext } from "../src/agents/context.js";
import { verdictFor } from "../src/agents/verdict.js";
import { museReplyOrThrow } from "../src/agents/muse.js";
import type { Agent, AgentResponse, SendOptions, TaskContext } from "../src/types.js";

const sandbox = () => mkdtempSync(path.join(tmpdir(), "guards-"));
const cfg = (over: Partial<PipelineConfig> = {}): PipelineConfig => ({
  verify: { cwd: sandbox(), commands: ["true"] },
  maxImplementationAttempts: 2,
  maxReviewRejections: 3,
  ...over,
});
const agents = (o: Partial<{ gemini: Agent; claude: Agent; muse: Agent }> = {}) => ({
  gemini: o.gemini ?? createMockAgent("gemini"),
  claude: o.claude ?? createMockAgent("claude"),
  muse: o.muse ?? createMockAgent("muse"),
});
const replying = (role: Agent["role"], ...replies: string[]): Agent & { calls: { prompt: string; opts?: SendOptions }[] } => {
  const calls: { prompt: string; opts?: SendOptions }[] = [];
  return {
    role,
    calls,
    async send(prompt: string, _ctx: TaskContext, opts?: SendOptions): Promise<AgentResponse> {
      calls.push({ prompt, opts });
      const content = replies.length > 1 ? replies.shift()! : replies[0];
      return { role, content, verdict: verdictFor(prompt, content) };
    },
  };
};

describe("implementation guards (no files / broken files never reach verification)", () => {
  it("an empty Muse reply is a failed attempt, not a verified one — and out of budget it is rejected", async () => {
    const task = createTask("Empty");
    task.stage = "implementation";
    const c = cfg();
    const a = agents({ muse: replying("muse", "Sorry, I ran out of time.") });
    await advance(task, a, c);
    expect(task.stage).toBe("implementation");
    expect(task.context.reviewFeedback?.[0]).toMatch(/contained no files/);
    expect(task.alerts?.map((x) => x.kind)).toContain("no_files");
    await advance(task, a, c);
    expect(task.stage).toBe("rejected");
    expect(task.history.some((h) => h.summary === "Verification passed.")).toBe(false);
  });

  it("refuses the whole attempt — writes nothing — when any file is unfenced or corrupted", async () => {
    const task = createTask("Corrupt");
    task.stage = "implementation";
    const c = cfg();
    task.context.implementationDiff =
      "FILE: ok.py\n```python\nx = 1\n```\n" +
      'FILE: run.sh\n```bash\n#!/usr/bin/env bash\nexport PATH="\n𝐻\n𝑂\n𝑀\n𝐸\n"\n```\n' +
      "FILE: loose.txt\nno fence here\n";
    task.implementationAttempts = 1;
    await applyImplementation(task, c);
    expect(task.stage).toBe("implementation");
    expect(existsSync(path.join(c.verify.cwd, "ok.py"))).toBe(false);
    const fb = task.context.reviewFeedback!.join("\n");
    expect(fb).toMatch(/run\.sh[\s\S]*math-styled/);
    expect(fb).toMatch(/loose\.txt[\s\S]*fenced code block/);
  });
});

describe("verification guards", () => {
  it("fails with no commands configured instead of passing on a placeholder", async () => {
    const task = createTask("No commands");
    task.stage = "verification";
    await advance(task, agents(), cfg({ verify: { cwd: sandbox(), commands: [] } }));
    expect(task.context.verificationLog).toMatch(/No verification commands/);
    expect(task.stage).toBe("implementation");
  });

  it("re-checks the written files on disk even when the project's own commands pass", async () => {
    const c = cfg();
    writeFileSync(path.join(c.verify.cwd, "gen.py"), 'def f():\n"""doc"""\nreturn 1\n');
    const task = createTask("Broken on disk");
    task.stage = "verification";
    task.implementationAttempts = 1;
    task.context.implementationFiles = ["gen.py"];
    await advance(task, agents(), c);
    expect(task.context.verificationLog).toMatch(/Syntax check[\s\S]*FAILED[\s\S]*gen\.py/);
    expect(task.stage).toBe("implementation");
  });

  it("warns when the verification commands never mention what was written", async () => {
    const c = cfg();
    writeFileSync(path.join(c.verify.cwd, "feature.py"), "x = 1\n");
    const task = createTask("Coverage");
    task.stage = "verification";
    task.context.implementationFiles = ["feature.py"];
    await advance(task, agents(), c); // `true` tests nothing
    expect(task.stage).toBe("review_gemini");
    expect(task.alerts?.find((a) => a.kind === "verify_coverage")?.level).toBe("warn");

    const covered = createTask("Covered");
    covered.stage = "verification";
    covered.context.implementationFiles = ["feature.py"];
    await advance(covered, agents(), cfg({ verify: { cwd: c.verify.cwd, commands: ["python3 -I feature.py"] } }));
    expect((covered.alerts ?? []).some((a) => a.kind === "verify_coverage")).toBe(false);
  });
});

describe("architecture guards", () => {
  const FAKE_TOOL = "I'll check what's actually on disk first.\n\n<function_calls>\n<invoke name=\"Bash\">\n<parameter name=\"command\">find .</parameter>\n</invoke>\n</function_calls>";
  const GUIDE = "Implementation guide.\n" + "- file.ts: does the thing, with the exact interface described here.\n".repeat(5);

  it("recognises a fake tool call or a one-line note as not-a-guide", () => {
    expect(specProblem(FAKE_TOOL, { requireLength: true })).toMatch(/tool call/);
    expect(specProblem("I'll look at the files first.", { requireLength: true })).toMatch(/characters/);
    expect(specProblem(GUIDE, { requireLength: true })).toBeUndefined();
    // The shapes Claude actually wrote in the VocabApp run.
    expect(specProblem("I'll inspect first.\n\n**Tool: bash**\n\nInput: ...", { requireLength: false })).toMatch(/tool call/);
    expect(specProblem("I'll inspect first.\n\n**1 tool use**\n\nls -la", { requireLength: false })).toMatch(/tool call/);
  });

  it("asks Claude again instead of handing an empty spec to Gemini, in the task's project with read-only tools", async () => {
    const claude = replying("claude", FAKE_TOOL, GUIDE);
    const task = createTask("Spec");
    task.stage = "architecture";
    const c = cfg();
    await advance(task, agents({ claude }), c);
    expect(task.context.architectureSpec).toBe(GUIDE);
    expect(task.stage).toBe("architecture_review");
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1].prompt).toMatch(/could not be used/);
    expect(claude.calls[0].opts).toMatchObject({ cwd: c.verify.cwd, tools: "Read,Grep,Glob" });
    expect(task.alerts?.map((a) => a.kind)).toContain("spec_rewritten");
  });

  it("errors out (visible to the CEO) rather than looping when Claude never produces a guide", async () => {
    const task = createTask("Never");
    task.stage = "architecture";
    await expect(advance(task, agents({ claude: replying("claude", FAKE_TOOL) }), cfg())).rejects.toThrow(/usable architecture guide/);
  });

  it("a Gemini reply saying REJECTED really sends the spec back", async () => {
    const task = createTask("Review");
    task.stage = "architecture_review";
    task.context.architectureSpec = GUIDE;
    const gemini = replying("gemini", "REJECTED\n\nThe spec is empty.", "VERDICT: REJECT");
    await advance(task, agents({ gemini }), cfg());
    expect(task.stage).toBe("architecture");
    expect(task.context.reviewFeedback?.[0]).toMatch(/spec is empty/);
  });
});

describe("review evidence and alerts", () => {
  it("puts the orchestrator's own verification log first and labels the engineer's claims as unverified", () => {
    const text = formatContext({ title: "t", implementationDiff: "All verified in my sandbox!", verificationLog: "$ swift test\nok", implementationFiles: ["a.swift"] });
    expect(text.indexOf("Verification log (commands the orchestrator actually ran")).toBeLessThan(text.indexOf("Implementation (engineer's reply"));
    expect(text).toMatch(/unverified statement/);
    expect(text).toMatch(/Files written to the project this attempt ---\n- a\.swift/);
  });

  it("a Gemini outage leaves a red warning: only one engine reviewed the work", async () => {
    const task = createTask("Down");
    task.stage = "review_gemini";
    const gemini: Agent = { role: "gemini", async send() { throw new Error("Gemini API error 401"); } };
    await advance(task, agents({ gemini }), cfg());
    expect(task.stage).toBe("checkpoint_final");
    expect(task.alerts?.find((a) => a.kind === "gemini_down")).toMatchObject({ level: "warn" });
  });
});

describe("Muse reply format", () => {
  it("accepts only Markdown read back as Markdown", () => {
    expect(museReplyOrThrow({ reply: "FILE: a", replyFormat: "markdown-copy" }, 300)).toBe("FILE: a");
    expect(museReplyOrThrow({ reply: "FILE: a", replyFormat: "markdown-dom" }, 300)).toBe("FILE: a");
    expect(() => museReplyOrThrow({ reply: "FILE: a", replyFormat: "rendered-text" }, 300)).toThrow(/rendered page text/);
    expect(() => museReplyOrThrow({ reply: "FILE: a" }, 300)).toThrow(/older version/);
    expect(() => museReplyOrThrow({ reply: "FILE: a, cut", replyFormat: "markdown-dom", timedOut: true }, 300)).toThrow(/within 300s/);
  });
});
