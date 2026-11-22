import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advance,
  amendShippedTask,
  createTask,
  isTerminal,
  isWaitingForHuman,
  resolveCheckpoint,
  retryFromRejected,
} from "../src/orchestrator/pipeline.js";
import { createMockAgent } from "../src/agents/mock.js";
import type { Agent, AgentResponse, TaskContext } from "../src/types.js";
import type { PipelineConfig } from "../src/orchestrator/pipeline.js";

function agents(overrides: Partial<{ gemini: Agent; claude: Agent; muse: Agent }> = {}) {
  return {
    gemini: overrides.gemini ?? createMockAgent("gemini"),
    claude: overrides.claude ?? createMockAgent("claude"),
    muse: overrides.muse ?? createMockAgent("muse"),
  };
}

/** Never run the pipeline's file-writing step against the real repo. */
function sandboxDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ai-company-test-"));
}

function passingConfig(): PipelineConfig {
  return {
    verify: { cwd: sandboxDir(), commands: ["true"] },
    maxImplementationAttempts: 3,
    maxReviewRejections: 3,
  };
}

function failingConfig(): PipelineConfig {
  return {
    verify: { cwd: sandboxDir(), commands: ["false"] },
    maxImplementationAttempts: 2,
    maxReviewRejections: 3,
  };
}

describe("pipeline", () => {
  it("runs the happy path from idea to done only via the human checkpoint", async () => {
    const task = createTask("Add dark mode toggle");
    const a = agents();
    const cfg = passingConfig();

    expect(task.stage).toBe("ideation");
    await advance(task, a, cfg);
    expect(task.stage).toBe("checkpoint_idea");
    expect(task.context.ideaBrief).toBeTruthy();
    expect(isWaitingForHuman(task)).toBe(true);

    resolveCheckpoint(task, true);
    expect(task.stage).toBe("architecture");

    await advance(task, a, cfg);
    expect(task.stage).toBe("architecture_review");
    expect(task.context.architectureSpec).toBeTruthy();

    await advance(task, a, cfg); // Gemini signs off on the architecture (mock always approves)
    expect(task.stage).toBe("implementation");

    await advance(task, a, cfg);
    expect(task.stage).toBe("verification");
    expect(task.implementationAttempts).toBe(1);
    expect(task.context.implementationFiles).toEqual(["NOTES.md"]);
    expect(readFileSync(path.join(cfg.verify.cwd, "NOTES.md"), "utf8")).toContain("Add dark mode toggle");

    await advance(task, a, cfg);
    expect(task.stage).toBe("review_gemini");

    await advance(task, a, cfg);
    expect(task.stage).toBe("review_claude");

    await advance(task, a, cfg);
    expect(task.stage).toBe("checkpoint_final");
    expect(isTerminal(task)).toBe(false);

    // Nothing but the human checkpoint can move this to "done".
    resolveCheckpoint(task, true);
    expect(task.stage).toBe("done");
    expect(isTerminal(task)).toBe(true);
  });

  it("never reaches done when verification keeps failing — it gives up instead", async () => {
    const task = createTask("Broken feature");
    task.stage = "implementation";
    const a = agents();
    const cfg = failingConfig();

    await advance(task, a, cfg); // implementation -> verification
    await advance(task, a, cfg); // verification fails -> back to implementation (attempt 1 < max 2)
    expect(task.stage).toBe("implementation");
    expect(task.context.reviewFeedback?.[0]).toMatch(/Verification failed/);

    await advance(task, a, cfg); // implementation -> verification
    await advance(task, a, cfg); // verification fails again, attempts (2) >= max (2) -> rejected
    expect(task.stage).toBe("rejected");
    expect(isTerminal(task)).toBe(true);
  });

  it("routes a reviewer's rejection through Claude before looping back to implementation — Gemini alone can't send it back", async () => {
    const task = createTask("Needs rework");
    task.stage = "review_gemini";
    task.context.implementationDiff = "diff";
    task.context.verificationLog = "ok";

    const rejectingGemini: Agent = {
      role: "gemini",
      async send(prompt: string, context: TaskContext): Promise<AgentResponse> {
        return { role: "gemini", verdict: "reject", content: "Not aligned with the brief." };
      },
    };
    const agreeingClaude: Agent = {
      role: "claude",
      async send(): Promise<AgentResponse> {
        return { role: "claude", verdict: "reject", content: "Agreed with Gemini — fix the validation logic in step 2." };
      },
    };

    const a = agents({ gemini: rejectingGemini, claude: agreeingClaude });
    const cfg = passingConfig();

    await advance(task, a, cfg);
    expect(task.stage).toBe("review_claude");
    expect(task.reviewRejections).toBe(0); // not yet — Claude hasn't ruled
    expect(task.context.reviewFeedback?.[0]).toMatch(/Gemini review feedback/);

    await advance(task, a, cfg);
    expect(task.stage).toBe("implementation");
    expect(task.reviewRejections).toBe(1);
    expect(task.context.reviewFeedback?.[0]).toMatch(/Claude review feedback/);
  });

  it("lets Claude overrule a Gemini rejection and approve anyway", async () => {
    const task = createTask("Needs rework");
    task.stage = "review_gemini";

    const rejectingGemini: Agent = {
      role: "gemini",
      async send(): Promise<AgentResponse> {
        return { role: "gemini", verdict: "reject", content: "Nit: naming could be clearer." };
      },
    };
    const overrulingClaude: Agent = {
      role: "claude",
      async send(): Promise<AgentResponse> {
        return { role: "claude", verdict: "approve", content: "Overruling Gemini — naming matches the spec's own terms." };
      },
    };

    const a = agents({ gemini: rejectingGemini, claude: overrulingClaude });
    const cfg = passingConfig();

    await advance(task, a, cfg); // review_gemini -> review_claude
    await advance(task, a, cfg); // review_claude approves despite Gemini's reject
    expect(task.stage).toBe("checkpoint_final");
    expect(task.reviewRejections).toBe(0);
  });

  it("falls back to Claude for the review_gemini round when Gemini's own retries are exhausted", async () => {
    const task = createTask("Needs rework");
    task.stage = "review_gemini";
    task.context.implementationDiff = "diff";
    task.context.verificationLog = "ok";

    const unavailableGemini: Agent = {
      role: "gemini",
      async send(): Promise<AgentResponse> {
        throw new Error("Gemini API error 503: overloaded");
      },
    };
    let claudePrompt = "";
    const standInClaude: Agent = {
      role: "claude",
      async send(prompt: string): Promise<AgentResponse> {
        claudePrompt = prompt;
        return { role: "claude", verdict: "approve", content: "Looks fine, standing in for Gemini." };
      },
    };

    const a = agents({ gemini: unavailableGemini, claude: standInClaude });
    const cfg = passingConfig();

    await advance(task, a, cfg);

    expect(claudePrompt).toMatch(/standing in/i);
    expect(task.stage).toBe("review_claude");
    expect(task.history.some((h) => /Claude is standing in/.test(h.summary))).toBe(true);
  });

  it("labels a fallback rejection as Claude standing in, not Gemini, before Claude's own final ruling takes over", async () => {
    const task = createTask("Needs rework");
    task.stage = "review_gemini";

    const unavailableGemini: Agent = {
      role: "gemini",
      async send(): Promise<AgentResponse> {
        throw new Error("Gemini API error 429: rate limited");
      },
    };
    const rejectingStandIn: Agent = {
      role: "claude",
      async send(): Promise<AgentResponse> {
        return { role: "claude", verdict: "reject", content: "Doesn't match the brief." };
      },
    };

    const a = agents({ gemini: unavailableGemini, claude: rejectingStandIn });
    const cfg = passingConfig();

    await advance(task, a, cfg); // review_gemini (Claude standing in) -> review_claude
    expect(task.stage).toBe("review_claude");
    expect(task.reviewRejections).toBe(0);
    expect(task.context.reviewFeedback?.[0]).toMatch(/Claude \(standing in for Gemini\) review feedback/);

    await advance(task, a, cfg); // review_claude: same mock agent rejects again -> implementation
    expect(task.stage).toBe("implementation");
    expect(task.reviewRejections).toBe(1);
    expect(task.context.reviewFeedback?.[0]).toMatch(/Claude review feedback/);
  });

  it("loops the architecture spec back to Claude when Gemini has concerns, with no cap on normal rounds", async () => {
    const task = createTask("New feature");
    task.stage = "architecture_review";
    task.context.architectureSpec = "v1 draft";

    const nitpickyGemini: Agent = {
      role: "gemini",
      async send(): Promise<AgentResponse> {
        return { role: "gemini", verdict: "reject", content: "Missing error handling for the empty-input case." };
      },
    };
    const a = agents({ gemini: nitpickyGemini });
    const cfg = passingConfig();

    await advance(task, a, cfg);
    expect(task.stage).toBe("architecture");
    expect(task.architectureRounds).toBe(1);
    expect(task.context.reviewFeedback?.[0]).toMatch(/Missing error handling/);

    await advance(task, a, cfg); // Claude revises -> architecture_review again
    expect(task.stage).toBe("architecture_review");

    await advance(task, a, cfg); // Gemini still has concerns -> back to architecture, round 2
    expect(task.stage).toBe("architecture");
    expect(task.architectureRounds).toBe(2);
  });

  it("gives up the architecture discussion once it hits the safety ceiling", async () => {
    const task = createTask("New feature");
    task.stage = "architecture_review";
    task.architectureRounds = 19;

    const nitpickyGemini: Agent = {
      role: "gemini",
      async send(): Promise<AgentResponse> {
        return { role: "gemini", verdict: "reject", content: "Still missing something." };
      },
    };
    const a = agents({ gemini: nitpickyGemini });
    const cfg: PipelineConfig = { ...passingConfig(), maxArchitectureRounds: 20 };

    await advance(task, a, cfg);
    expect(task.architectureRounds).toBe(20);
    expect(task.stage).toBe("rejected");
  });

  it("sends a rejected idea back to ideation instead of forward", () => {
    const task = createTask("Risky idea");
    task.stage = "checkpoint_idea";
    task.context.ideaBrief = "draft";

    resolveCheckpoint(task, false, "Too risky, rethink the approach.");
    expect(task.stage).toBe("ideation");
    expect(task.context.reviewFeedback?.[0]).toMatch(/Too risky/);
  });

  it("sends a CEO rejection at the final checkpoint all the way back through ideation, not just architecture", () => {
    const task = createTask("Wrong direction entirely");
    task.stage = "checkpoint_final";
    task.context.ideaBrief = "old, now-contradicted idea brief";
    task.context.architectureSpec = "old spec";
    task.implementationAttempts = 2;
    task.reviewRejections = 1;
    task.architectureRounds = 4;

    resolveCheckpoint(task, false, "This needs a completely different layout.");

    // Not "architecture": leaving ideaBrief stale and unrevised would keep
    // contradicting whatever architecture writes next, which a careful
    // reviewer should (and did, in practice) refuse to approve forever.
    expect(task.stage).toBe("ideation");
    expect(task.implementationAttempts).toBe(0);
    expect(task.reviewRejections).toBe(0);
    expect(task.architectureRounds).toBe(0);
    expect(task.context.reviewFeedback?.[0]).toMatch(/completely different layout/);
  });

  it("retry keeps the last reviewer's feedback by default (that's what the engineer needs next)", () => {
    const task = createTask("Something that failed");
    task.context.ideaBrief = "kept";
    task.context.architectureSpec = "kept";
    task.stage = "rejected";
    task.implementationAttempts = 3;
    task.reviewRejections = 2;
    task.context.reviewFeedback = ["fix the B constant"];

    retryFromRejected(task);

    expect(task.stage).toBe("implementation");
    expect(task.implementationAttempts).toBe(0);
    expect(task.reviewRejections).toBe(0);
    expect(task.context.reviewFeedback).toEqual(["fix the B constant"]);
    expect(task.context.ideaBrief).toBe("kept");
    expect(task.context.architectureSpec).toBe("kept");
  });

  it("retry clears feedback only when asked to", () => {
    const task = createTask("Something that failed for an unrelated reason");
    task.stage = "rejected";
    task.context.reviewFeedback = ["stale feedback about a now-fixed orchestrator bug"];

    retryFromRejected(task, { clearFeedback: true });

    expect(task.context.reviewFeedback).toEqual([]);
  });

  it("refuses to retry a task that isn't rejected", () => {
    const task = createTask("Still in progress");
    expect(() => retryFromRejected(task)).toThrow(/not rejected/);
  });

  it("amend reopens a shipped task through architecture, keeping its history", () => {
    const task = createTask("Shipped feature");
    task.context.ideaBrief = "original idea, kept";
    task.context.architectureSpec = "original spec, kept";
    task.stage = "done";
    task.implementationAttempts = 2;
    task.reviewRejections = 1;
    task.architectureRounds = 3;

    amendShippedTask(task, "Also add a dark mode toggle.");

    expect(task.stage).toBe("architecture");
    expect(task.implementationAttempts).toBe(0);
    expect(task.reviewRejections).toBe(0);
    expect(task.architectureRounds).toBe(0);
    expect(task.context.reviewFeedback).toEqual(["Also add a dark mode toggle."]);
    expect(task.context.ideaBrief).toBe("original idea, kept");
    expect(task.context.architectureSpec).toBe("original spec, kept");
  });

  it("refuses to amend a task that isn't done", () => {
    const task = createTask("Still in progress");
    expect(() => amendShippedTask(task, "change")).toThrow(/not done/);
  });

  it("refuses to advance a stage that needs a human decision", async () => {
    const task = createTask("x");
    task.stage = "checkpoint_idea";
    await expect(advance(task, agents(), passingConfig())).rejects.toThrow(/human decision/);
  });
});
