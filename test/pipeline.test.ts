import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  advance,
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
    expect(task.stage).toBe("implementation");
    expect(task.context.architectureSpec).toBeTruthy();

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

  it("loops implementation back when a reviewer rejects, and never lets an agent set done", async () => {
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

    const a = agents({ gemini: rejectingGemini });
    const cfg = passingConfig();

    await advance(task, a, cfg);
    expect(task.stage).toBe("implementation");
    expect(task.reviewRejections).toBe(1);
    expect(task.context.reviewFeedback?.[0]).toMatch(/Gemini review feedback/);
  });

  it("sends a rejected idea back to ideation instead of forward", () => {
    const task = createTask("Risky idea");
    task.stage = "checkpoint_idea";
    task.context.ideaBrief = "draft";

    resolveCheckpoint(task, false, "Too risky, rethink the approach.");
    expect(task.stage).toBe("ideation");
    expect(task.context.reviewFeedback?.[0]).toMatch(/Too risky/);
  });

  it("retry gives a rejected task a fresh implementation budget without redoing idea/architecture", () => {
    const task = createTask("Something that failed");
    task.context.ideaBrief = "kept";
    task.context.architectureSpec = "kept";
    task.stage = "rejected";
    task.implementationAttempts = 3;
    task.reviewRejections = 2;
    task.context.reviewFeedback = ["old feedback"];

    retryFromRejected(task);

    expect(task.stage).toBe("implementation");
    expect(task.implementationAttempts).toBe(0);
    expect(task.reviewRejections).toBe(0);
    expect(task.context.reviewFeedback).toEqual([]);
    expect(task.context.ideaBrief).toBe("kept");
    expect(task.context.architectureSpec).toBe("kept");
  });

  it("refuses to retry a task that isn't rejected", () => {
    const task = createTask("Still in progress");
    expect(() => retryFromRejected(task)).toThrow(/not rejected/);
  });

  it("refuses to advance a stage that needs a human decision", async () => {
    const task = createTask("x");
    task.stage = "checkpoint_idea";
    await expect(advance(task, agents(), passingConfig())).rejects.toThrow(/human decision/);
  });
});
