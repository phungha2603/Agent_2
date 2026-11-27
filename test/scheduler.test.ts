import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentResponse, RoleName, SendOptions, TaskContext } from "../src/types.js";

// The stores resolve data/ from process.cwd() at import time, so each test
// chdirs into a throwaway directory and imports fresh copies of the modules.
const originalCwd = process.cwd();
let company: { close(): Promise<void> } | undefined;

afterEach(async () => {
  await company?.close();
  company = undefined;
  process.chdir(originalCwd);
  vi.resetModules();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(15);
  }
}

interface Call {
  role: RoleName;
  title: string;
  upstream: number;
  kind: string;
}

function tracker() {
  const active: Record<string, number> = { claude: 0, gemini: 0, muse: 0 };
  const peak: Record<string, number> = { claude: 0, gemini: 0, muse: 0 };
  const calls: Call[] = [];
  return { active, peak, calls };
}

async function setup(overrides: { gemini?: Agent; claude?: Agent; slotParallel?: Record<string, number> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "scheduler-test-"));
  process.chdir(dir);
  vi.resetModules();
  const { Company } = await import("../src/orchestrator/scheduler.js");
  const { createMockAgent } = await import("../src/agents/mock.js");
  const t = tracker();

  const instrumented = (role: RoleName, delayMs: number): Agent => {
    const base = createMockAgent(role);
    return {
      role,
      async send(prompt: string, ctx: TaskContext, opts?: SendOptions): Promise<AgentResponse> {
        t.active[role]++;
        t.peak[role] = Math.max(t.peak[role], t.active[role]);
        t.calls.push({ role, title: ctx.title, upstream: ctx.upstream?.length ?? 0, kind: prompt.slice(0, 12) });
        try {
          await sleep(delayMs);
          return await base.send(prompt, ctx, opts);
        } finally {
          t.active[role]--;
        }
      },
    };
  };

  const c = new Company({
    agents: {
      claude: overrides.claude ?? instrumented("claude", 15),
      gemini: overrides.gemini ?? instrumented("gemini", 10),
      muse: instrumented("muse", 10),
    },
    pipeline: { verify: { cwd: dir, commands: ["true"] }, maxImplementationAttempts: 3, maxReviewRejections: 3, maxAutoRecoveries: 1 },
    settings: {
      claudeConcurrency: 2,
      geminiConcurrency: 2,
      defaultSlotParallel: 1,
      slotParallel: overrides.slotParallel ?? {},
      stageErrorRetries: 1,
      stageErrorBackoffMs: [0],
      handoffOn: "checkpoint_final",
      planMaxRounds: 2,
      planLimits: { maxEpics: 3, maxSubtasks: 8 },
    },
  });
  company = c;
  await c.init();
  return { company: c, t, dir };
}

async function allTasks(c: any) {
  const status = await c.statusSnapshot();
  return status.slots.flatMap((s: any) => s.tasks);
}

describe("Company scheduler", () => {
  it("plans, waits for the CEO, then runs the whole tree in parallel within engine limits and in dependency order", async () => {
    const { company: c, t } = await setup();
    // This test is about parallelism and dependency order; gates have their own test below.
    await c.setGate("AG-08", false);
    await c.setGate("AG-10", false);

    const plan = await c.startPlan("Build the analytics product");
    await waitFor(async () => (await c.planSnapshot())?.status === "awaiting_approval");
    expect(await allTasks(c)).toHaveLength(0); // nothing starts before the CEO approves the plan

    await c.decidePlan(plan.id, true, undefined, { handoffOn: "checkpoint_final" });
    await waitFor(async () => (await allTasks(c)).filter((x: any) => x.queueState === "waiting_you").length === 9);

    // Engine caps held, and independent work really did overlap.
    expect(t.peak.muse).toBe(1);
    expect(t.peak.claude).toBe(2);
    expect(t.peak.gemini).toBeLessThanOrEqual(2);

    // Dependents only started after their upstream handed off, and received the handoff.
    const firstCall = (prefix: string, role: RoleName) => t.calls.findIndex((x) => x.role === role && x.title.startsWith(prefix));
    const archCall = (prefix: string) => t.calls.find((x) => x.role === "claude" && x.title.startsWith(prefix) && !x.kind.startsWith("REVIEW"));
    expect(firstCall("E1.S1", "muse")).toBeLessThan(firstCall("E1.S2", "claude"));
    expect(archCall("E1.S2")?.upstream).toBe(1);
    expect(archCall("E3.S3")?.upstream).toBe(2);
    expect(archCall("E1 · ")?.upstream).toBe(2); // epic integration task gets both subtasks' handoffs

    // The CEO is still the one who ships each task (one by one, or all at once).
    const [first] = await allTasks(c);
    await c.decide(first.id, true);
    expect(await c.approveAllWaiting()).toBe(8);
    await waitFor(async () => (await allTasks(c)).every((x: any) => x.queueState === "done"));
  });

  it("queues a slot's second task behind its first when the slot runs one at a time", async () => {
    const slowGemini: Agent = {
      role: "gemini",
      async send(_p, ctx): Promise<AgentResponse> {
        await sleep(80);
        return { role: "gemini", content: `brief for ${ctx.title}` };
      },
    };
    const { company: c } = await setup({ gemini: slowGemini });
    await c.runSlot("AG-03", "first");
    await c.runSlot("AG-03", "second");
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.running === 1);
    const snap = await c.slotSnapshot("AG-03");
    expect(snap.counts.queued).toBe(1);
    expect(snap.tasks.map((x: any) => x.queueState)).toEqual(["running", "queued"]);
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.waitingYou === 2);
  });

  it("runs a slot's tasks side by side when its parallel limit allows it", async () => {
    const slowGemini: Agent = {
      role: "gemini",
      async send(_p, ctx): Promise<AgentResponse> {
        await sleep(80);
        return { role: "gemini", content: `brief for ${ctx.title}` };
      },
    };
    const { company: c } = await setup({ gemini: slowGemini, slotParallel: { "AG-03": 2 } });
    await c.runSlot("AG-03", "first");
    await c.runSlot("AG-03", "second");
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.running === 2);
  });

  it("retries a stage that throws, and keeps the error out of the next agent's feedback", async () => {
    let calls = 0;
    const flaky: Agent = {
      role: "gemini",
      async send(_p, ctx): Promise<AgentResponse> {
        if (++calls === 1) throw new Error("socket hang up");
        return { role: "gemini", content: `brief for ${ctx.title}` };
      },
    };
    const { company: c } = await setup({ gemini: flaky });
    await c.runSlot("AG-03", "flaky goal");
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.waitingYou === 1);
    const [task] = (await c.slotSnapshot("AG-03")).tasks;
    expect(task.lastError).toBeUndefined();
    expect(task.lastFeedback).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("pauses a task whose stage keeps failing, shows the error, and resumes on retry", async () => {
    let failing = true;
    const down: Agent = {
      role: "gemini",
      async send(_p, ctx): Promise<AgentResponse> {
        if (failing) throw new Error("Gemini API error 500");
        return { role: "gemini", content: `brief for ${ctx.title}` };
      },
    };
    const { company: c } = await setup({ gemini: down });
    await c.runSlot("AG-04", "goal");
    await waitFor(async () => (await c.slotSnapshot("AG-04")).counts.problems === 1);
    let [task] = (await c.slotSnapshot("AG-04")).tasks;
    expect(task.queueState).toBe("error");
    expect(task.lastError).toMatch(/Gemini API error 500/);
    expect(task.lastFeedback).toBeUndefined();

    failing = false;
    await c.retryTask(task.id);
    await waitFor(async () => (await c.slotSnapshot("AG-04")).counts.waitingYou === 1);
    [task] = (await c.slotSnapshot("AG-04")).tasks;
    expect(task.lastError).toBeUndefined();
  });

  it("refuses to start a second plan while one is waiting for approval", async () => {
    const { company: c } = await setup();
    await c.startPlan("goal one");
    await expect(c.startPlan("goal two")).rejects.toThrow(/kế hoạch/);
  });
});

describe("plan project settings", () => {
  it("runs every task of the plan in the plan's own directory with its own commands, and won't approve without commands", async () => {
    const { company: c, dir } = await setup();
    const projectDir = path.join(dir, "vocab-app");
    const plan = await c.startPlan("Build the vocab app", projectDir);
    expect(plan.project?.warnings.join(" ")).toMatch(/chưa tồn tại/);
    expect(plan.project?.handoffOn).toBe("checkpoint_final"); // a new project keeps the company setting
    await waitFor(async () => (await c.planSnapshot())?.status === "awaiting_approval");
    expect((await c.planSnapshot())?.project?.verifyCommands).toEqual(["test -s NOTES.md"]); // Claude's proposal

    await c.updatePlanProject(plan.id, { verifyCommands: [" ", ""] });
    await expect(c.decidePlan(plan.id, true)).rejects.toThrow(/chưa có lệnh kiểm tra/);
    await expect(c.updatePlanProject(plan.id, { dir: "relative/path" })).rejects.toThrow(/tuyệt đối/);

    await c.decidePlan(plan.id, true, undefined, { verifyCommands: ["test -s NOTES.md", "true"] });
    const tasks = await allTasks(c);
    const detail = await c.taskDetail(tasks[0].id);
    expect(detail.task.projectConfig).toMatchObject({ verifyCwd: projectDir, verifyCommands: ["test -s NOTES.md", "true"], handoffOn: "checkpoint_final" });
  });

  it("warns when the project directory already holds other files", async () => {
    const { company: c, dir } = await setup();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dir, "factorial.py"), "x = 1\n");
    const plan = await c.startPlan("goal", dir);
    expect(plan.project?.warnings.join(" ")).toMatch(/factorial\.py/);
    // Repairing an existing project: dependents wait for the CEO's approval by default.
    expect(plan.project?.handoffOn).toBe("done");
  });
});
