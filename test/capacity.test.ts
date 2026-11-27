import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { advance, createTask, type PipelineConfig } from "../src/orchestrator/pipeline.js";
import { createMockAgent } from "../src/agents/mock.js";
import { createMusePoolAgent, type PoolAccount } from "../src/agents/muse.js";
import { failureDigest } from "../src/verify/failureDigest.js";
import { verdictFor } from "../src/agents/verdict.js";
import type { Agent, AgentResponse, SendOptions, TaskContext } from "../src/types.js";

const cfg = (over: Partial<PipelineConfig> = {}): PipelineConfig => ({
  verify: { cwd: mkdtempSync(path.join(tmpdir(), "cap-")), commands: ["true"] },
  maxImplementationAttempts: 2,
  maxReviewRejections: 2,
  ...over,
});

function recordingClaude(log: SendOptions[]): Agent {
  return {
    role: "claude",
    async send(prompt: string, _ctx: TaskContext, opts?: SendOptions): Promise<AgentResponse> {
      log.push(opts ?? {});
      const content = prompt.startsWith("REVIEW:") ? "fine\nVERDICT: APPROVE" : "Guide.\n" + "- a.ts: does a thing precisely.\n".repeat(8) + "FILES: a.ts";
      return { role: "claude", content, verdict: verdictFor(prompt, content) };
    },
  };
}

describe("P5 — Claude model per step", () => {
  it("uses the architecture model for the guide and the review model for the sign-off", async () => {
    const calls: SendOptions[] = [];
    const agents = { gemini: createMockAgent("gemini"), claude: recordingClaude(calls), muse: createMockAgent("muse") };
    const c = cfg({ claudeModels: { architecture: "claude-opus-5-5", review: "claude-sonnet-5-5" } });
    const task = createTask("Models");
    task.stage = "architecture";
    await advance(task, agents, c);
    task.stage = "review_claude";
    await advance(task, agents, c);
    expect(calls[0].model).toBe("claude-opus-5-5");
    expect(calls.at(-1)!.model).toBe("claude-sonnet-5-5");
  });
});

describe("P6 — skipping Claude's review on a green subtask", () => {
  const atGeminiReview = (over: { skip: boolean; subtask?: boolean; ceo?: string[]; warn?: boolean }) => {
    const t = createTask("Skip");
    t.stage = "review_gemini";
    t.projectConfig = { verifyCwd: "/x", verifyCommands: ["true"], skipClaudeReviewWhenGreen: over.skip };
    t.planRef = { planId: "p", epicId: "E1", ...(over.subtask === false ? {} : { subtaskId: "E1.S1" }) };
    if (over.ceo) t.context.ceoRequests = over.ceo;
    if (over.warn) t.alerts = [{ kind: "verify_coverage", level: "warn", at: "", stage: "verification", text: "x" }];
    return t;
  };
  const agents = { gemini: createMockAgent("gemini"), claude: createMockAgent("claude"), muse: createMockAgent("muse") };

  it("goes straight to the checkpoint when the option is on and Gemini approved a clean subtask", async () => {
    const t = atGeminiReview({ skip: true });
    await advance(t, agents, cfg());
    expect(t.stage).toBe("checkpoint_final");
  });

  it("still asks Claude for integration tasks, CEO revisions, red warnings, or with the option off", async () => {
    for (const over of [{ skip: false }, { skip: true, subtask: false }, { skip: true, ceo: ["fix X"] }, { skip: true, warn: true }]) {
      const t = atGeminiReview(over);
      await advance(t, agents, cfg());
      expect(t.stage, JSON.stringify(over)).toBe("review_claude");
    }
  });
});

describe("P7 — one Muse user at a time", () => {
  it("never runs two profiles of the same Muse user together, and leaves out a logged-out one", async () => {
    let active = 0;
    let peak = 0;
    const warns: string[] = [];
    const account = (label: string, viewerId: string | null, loggedIn = true): PoolAccount => ({
      role: "muse",
      label,
      identity: async () => ({ loggedIn, viewerId }),
      async send(): Promise<AgentResponse> {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { role: "muse", content: label };
      },
    });
    const pool = createMusePoolAgent([account("p1", "userA"), account("p2", "userA"), account("p3", null, false)], { warn: (m) => warns.push(m) });
    const replies = await Promise.all([1, 2, 3].map(() => pool.send("x", {} as TaskContext)));
    expect(peak).toBe(1); // p1 and p2 are the same user; p3 is not logged in
    expect(replies.every((r) => r.content !== "p3")).toBe(true);
    expect(warns.join(" ")).toMatch(/p1 and p2 are the same Muse user/);
    expect(warns.join(" ")).toMatch(/p3 is not logged in/);
  });

  it("runs distinct Muse users in parallel", async () => {
    let active = 0;
    let peak = 0;
    const account = (label: string, viewerId: string): PoolAccount => ({
      role: "muse",
      label,
      identity: async () => ({ loggedIn: true, viewerId }),
      async send(): Promise<AgentResponse> {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { role: "muse", content: label };
      },
    });
    const pool = createMusePoolAgent([account("p1", "userA"), account("p3", "userB")], { warn: () => {} });
    await Promise.all([1, 2].map(() => pool.send("x", {} as TaskContext)));
    expect(peak).toBe(2);
  });
});

describe("P8 — failure digest for the engineer", () => {
  it("keeps commands and failure lines, drops the noise, and caps the size", () => {
    const noise = Array.from({ length: 20000 }, (_, i) => `[${i}/20000] Compiling something.swift`).join("\n");
    const log = `$ swift build\n${noise}\n$ swift test\nTests/X.swift:57: error: XCTAssertTrue failed - workflow must run xcodebuild -list\nTest Suite 'All tests' failed`;
    const d = failureDigest(log);
    expect(d.length).toBeLessThan(7000);
    expect(d).toMatch(/\$ swift build/);
    expect(d).toMatch(/\$ swift test/);
    expect(d).toMatch(/XCTAssertTrue failed/);
    expect(failureDigest("short log")).toBe("short log");
  });
});
