import { describe, expect, it } from "vitest";
import { formatUsage, summarizeUsage } from "../src/orchestrator/usageReport.js";
import type { CallRecord } from "../src/agents/limited.js";
import type { TaskRecord } from "../src/types.js";

const call = (taskId: string, engine: CallRecord["engine"], startedAt: string, inTok: number, outTok: number, costUsd?: number): CallRecord => ({
  taskId,
  engine,
  startedAt,
  endedAt: startedAt,
  waitMs: 0,
  prompt: "p".repeat(inTok * 4),
  output: "o".repeat(outTok * 4),
  usage: { inputTokens: inTok, outputTokens: outTok, costUsd },
});

const task = (id: string, title: string): TaskRecord =>
  ({
    id,
    context: { title },
    runs: [
      { stage: "architecture", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z", waitMs: 0, engines: [], inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false },
      { stage: "implementation", startedAt: "2026-01-01T00:02:00Z", endedAt: "2026-01-01T00:05:00Z", waitMs: 0, engines: [], inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false },
      { stage: "checkpoint_final", startedAt: "2026-01-01T00:06:00Z", waitMs: 0, engines: [], inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false, human: true },
    ],
  }) as unknown as TaskRecord;

describe("summarizeUsage", () => {
  const tasks = new Map([["t1", task("t1", "Data pipeline")], ["t2", task("t2", "UI shell")]]);
  const calls = [
    call("t1", "claude", "2026-01-01T00:00:30Z", 37000, 800, 0.09),
    call("t1", "muse", "2026-01-01T00:03:00Z", 2000, 6000),
    call("t2", "claude", "2026-01-01T00:00:40Z", 37000, 900, 0.09),
    call("plan:p1", "claude", "2026-01-01T00:00:00Z", 5000, 2000),
    call("t1", "gemini", "2026-01-01T09:00:00Z", 100, 10), // outside every run
  ];

  it("attributes each call to the stage whose run contains it, and to plan / unknown otherwise", () => {
    const s = summarizeUsage(calls, tasks);
    expect(s.byStage.architecture.calls).toBe(2);
    expect(s.byStage.implementation.calls).toBe(1);
    expect(s.byStage.plan.calls).toBe(1);
    expect(s.byStage["?"].calls).toBe(1);
    expect(s.total.calls).toBe(5);
    expect(s.total.input).toBe(81100);
  });

  it("splits by engine, ranks tasks and the biggest calls", () => {
    const s = summarizeUsage(calls, tasks);
    expect(s.byEngine.claude).toMatchObject({ calls: 3, input: 79000 });
    expect(s.byEngine.claude.costUsd).toBeCloseTo(0.18);
    expect(s.byTask[0].title).toBe("Data pipeline");
    expect(s.biggest[0]).toMatchObject({ engine: "claude", stage: "architecture", tokens: 37900 });
  });

  it("prints a readable report", () => {
    const text = formatUsage(summarizeUsage(calls, tasks));
    expect(text).toContain("Tổng: 5 lượt gọi");
    expect(text).toMatch(/architecture\s+2 lượt/);
    expect(text).toContain("Task tốn nhiều nhất");
  });
});
