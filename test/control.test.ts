import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentResponse, RoleName, SendOptions, TaskContext } from "../src/types.js";

// Same isolation as scheduler.test.ts: the stores resolve data/ from the cwd at import time.
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

interface Seen {
  role: RoleName;
  title: string;
  ctx: TaskContext;
  prompt: string;
}

async function setup(overrides: Partial<Record<"gemini" | "claude" | "muse", Agent>> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "control-test-"));
  process.chdir(dir);
  vi.resetModules();
  const { Company } = await import("../src/orchestrator/scheduler.js");
  const { createMockAgent } = await import("../src/agents/mock.js");
  const seen: Seen[] = [];
  const spy = (role: RoleName, delay = 5): Agent => {
    const base = createMockAgent(role);
    return {
      role,
      async send(prompt: string, ctx: TaskContext, opts?: SendOptions): Promise<AgentResponse> {
        seen.push({ role, title: ctx.title, ctx: structuredClone(ctx), prompt });
        await sleep(delay);
        return base.send(prompt, ctx, opts);
      },
    };
  };
  const c = new Company({
    agents: { claude: overrides.claude ?? spy("claude"), gemini: overrides.gemini ?? spy("gemini"), muse: overrides.muse ?? spy("muse") },
    pipeline: { verify: { cwd: dir, commands: ["true"] }, maxImplementationAttempts: 3, maxReviewRejections: 3, maxAutoRecoveries: 1 },
    settings: {
      claudeConcurrency: 2,
      geminiConcurrency: 2,
      defaultSlotParallel: 1,
      slotParallel: {},
      stageErrorRetries: 0,
      stageErrorBackoffMs: [0],
      handoffOn: "checkpoint_final",
      planMaxRounds: 1,
      planLimits: { maxEpics: 3, maxSubtasks: 8 },
    },
  });
  company = c;
  await c.init();
  return { c, seen, spy };
}

const tasksOf = async (c: any) => (await c.statusSnapshot()).slots.flatMap((s: any) => s.tasks);
const byTitle = async (c: any, prefix: string) => (await tasksOf(c)).find((t: any) => t.title.startsWith(prefix));

/** One task taken through its idea checkpoint to the final checkpoint. */
async function taskAtFinal(c: any, slot = "AG-03", goal = "build a parser") {
  await c.runSlot(slot, goal);
  await waitFor(async () => (await c.slotSnapshot(slot)).counts.waitingYou === 1);
  const [t] = (await c.slotSnapshot(slot)).tasks;
  await c.decide(t.id, "approve");
  await waitFor(async () => (await c.slotSnapshot(slot)).tasks[0]?.stage === "checkpoint_final" && (await c.slotSnapshot(slot)).counts.running === 0);
  return t.id as string;
}

describe("approval gates", () => {
  it("holds a gated slot's handoff until the CEO approves, while ungated slots hand off at checkpoint_final", async () => {
    const { c } = await setup();
    const plan = await c.startPlan("goal");
    await waitFor(async () => (await c.planSnapshot())?.status === "awaiting_approval");
    await c.decidePlan(plan.id, true, undefined, { handoffOn: "checkpoint_final" });

    // AG-10 (gated by default) finishes E3.S3 but doesn't hand off; AG-08's integration task keeps waiting for it.
    await waitFor(async () => (await byTitle(c, "E3.S3"))?.queueState === "waiting_you", 15000);
    await waitFor(async () => (await byTitle(c, "E1.S1"))?.queueState === "waiting_you");
    expect((await byTitle(c, "E3.S3")).handedOff).toBe(false);
    expect((await byTitle(c, "E3.S3")).gated).toBe(true);
    expect((await byTitle(c, "E1.S1")).handedOff).toBe(true); // ungated
    expect((await byTitle(c, "E3 · ")).queueState).toBe("waiting_deps");
    expect((await c.slotSnapshot("AG-08")).state.label).toMatch(/Waiting on .*AG-10/);

    await c.decide((await byTitle(c, "E3.S3")).id, "approve");
    await waitFor(async () => (await byTitle(c, "E3 · ")).queueState !== "waiting_deps");
  });

  it("can be toggled per slot", async () => {
    const { c } = await setup();
    expect((await c.slotSnapshot("AG-03")).gated).toBe(false);
    await c.setGate("AG-03", true);
    expect((await c.slotSnapshot("AG-03")).gated).toBe(true);
  });
});

describe("pause / resume / stop", () => {
  it("starts nothing while paused and picks up on resume", async () => {
    const { c } = await setup();
    await c.pause();
    await c.runSlot("AG-03", "goal");
    await sleep(100);
    expect((await c.slotSnapshot("AG-03")).counts.running).toBe(0);
    expect((await c.slotSnapshot("AG-03")).state.kind).toBe("paused");
    expect((await c.telemetry()).paused).toBe(true);
    await c.resume();
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.waitingYou === 1);
  });

  it("aborts the call in flight on Stop, without counting it as an error, and redoes that stage on Resume", async () => {
    let slow = true;
    let calls = 0;
    const gemini: Agent = {
      role: "gemini",
      async send(_p, ctx, opts): Promise<AgentResponse> {
        calls++;
        if (slow) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 10_000);
            opts?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        }
        return { role: "gemini", content: `brief for ${ctx.title}` };
      },
    };
    const { c } = await setup({ gemini });
    await c.runSlot("AG-03", "goal");
    await waitFor(() => calls === 1); // the call is genuinely in flight
    await c.stop();
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.running === 0, 2000);
    const detail = await c.taskDetail((await c.slotSnapshot("AG-03")).tasks[0].id);
    expect(detail.task.lastError).toBeUndefined();
    expect(detail.task.stage).toBe("ideation");
    expect(detail.task.runs?.at(-1)?.outcome).toBe("cancelled");
    expect(detail.task.history.some((h: any) => /Stopped by the CEO/.test(h.summary))).toBe(true);

    slow = false;
    await c.resume();
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.waitingYou === 1);
    expect(calls).toBe(2);
  });
});

describe("stop during stage setup", () => {
  it("never starts the agent call when Stop lands before it begins", async () => {
    let calls = 0;
    const gemini: Agent = {
      role: "gemini",
      async send(_p, ctx): Promise<AgentResponse> {
        calls++;
        return { role: "gemini", content: `brief for ${ctx.title}` };
      },
    };
    const { c } = await setup({ gemini });
    await c.runSlot("AG-03", "goal");
    await c.stop(); // immediately: the worker is still setting up its stage
    await sleep(100);
    expect(calls).toBe(0);
    await c.resume();
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.waitingYou === 1);
    expect(calls).toBe(1);
  });
});

describe("CEO decisions and steering", () => {
  it("revise sends a finished task back to implementation with the CEO's request, keeping the design", async () => {
    const { c, seen } = await setup();
    const id = await taskAtFinal(c);
    await c.decide(id, "revise", "Rename the parse() function to parseInput()");
    await waitFor(async () => (await c.slotSnapshot("AG-03")).tasks[0]?.stage === "checkpoint_final" && (await c.slotSnapshot("AG-03")).counts.running === 0);
    const museAfter = seen.filter((s) => s.role === "muse").at(-1)!;
    expect(museAfter.prompt).toContain("parseInput()");
    const detail = await c.taskDetail(id);
    expect(detail.task.trace?.some((t: any) => t.kind === "revise")).toBe(true);
  });

  it("delivers a slot directive to that slot's next agent calls, and a company directive to everyone", async () => {
    const { c, seen } = await setup();
    await c.steer("AG-03", "Focus on competitors in the Vietnamese market");
    await c.steer(null, "Write all user-facing text in Vietnamese");
    await c.runSlot("AG-03", "market analysis");
    await c.runSlot("AG-04", "data model");
    await waitFor(async () => (await c.slotSnapshot("AG-04")).counts.waitingYou === 1 && (await c.slotSnapshot("AG-03")).counts.waitingYou === 1);
    const forAg03 = seen.find((s) => s.title === "market analysis")!;
    const forAg04 = seen.find((s) => s.title === "data model")!;
    expect(forAg03.ctx.directives).toEqual(["Focus on competitors in the Vietnamese market", "Write all user-facing text in Vietnamese"]);
    expect(forAg04.ctx.directives).toEqual(["Write all user-facing text in Vietnamese"]);
    expect(forAg03.prompt).toBeTruthy();
  });

  it("with redo, sends a task that's past architecture back to it with the directive as feedback", async () => {
    const { c, seen } = await setup();
    const id = await taskAtFinal(c);
    await c.steer("AG-03", "Use streaming parsing, not whole-file reads", true);
    await waitFor(async () => {
      const t = (await c.slotSnapshot("AG-03")).tasks[0];
      return t.stage === "checkpoint_final" && (await c.slotSnapshot("AG-03")).counts.running === 0 && seen.filter((s) => s.role === "claude").length > 3;
    });
    const arch = seen.filter((s) => s.role === "claude" && !s.prompt.startsWith("REVIEW:")).at(-1)!;
    expect(arch.ctx.reviewFeedback?.[0]).toMatch(/streaming parsing/);
    expect(arch.ctx.directives).toContain("Use streaming parsing, not whole-file reads");
    expect((await c.taskDetail(id)).task.trace?.some((t: any) => t.kind === "directive")).toBe(true);
  });

  it("removes a directive", async () => {
    const { c } = await setup();
    const d = await c.steer(null, "temporary");
    expect(c.control().directives).toHaveLength(1);
    await c.removeDirective(d.id);
    expect(c.control().directives).toHaveLength(0);
  });

  it("ties a directive to the plan active when it was given: other plans' tasks never see it, and it shows as stale once another plan is active", async () => {
    const { c } = await setup();
    const internals = c as any;
    internals.state.activePlanId = "plan-old";
    const d = await c.steer("AG-05", "Rewrite the Swift tests");
    expect(d.planId).toBe("plan-old");
    internals.state.activePlanId = null;
    expect((await c.steer("AG-05", "Applies everywhere — no plan was active")).planId).toBeUndefined();
    internals.state.activePlanId = "plan-old";

    const forPlan = (planId?: string) =>
      internals.directivesFor({ id: "t", slotId: "AG-05", planRef: planId ? { planId, epicId: "E1" } : undefined });
    expect(forPlan("plan-old")).toEqual(["Rewrite the Swift tests", "Applies everywhere — no plan was active"]);
    expect(forPlan("plan-new")).toEqual(["Applies everywhere — no plan was active"]);
    expect(forPlan(undefined)).toEqual(["Applies everywhere — no plan was active"]);

    expect((await c.slotSnapshot("AG-05")).directives.map((x: any) => x.stale)).toEqual([false, false]);
    internals.state.activePlanId = "plan-new";
    expect((await c.slotSnapshot("AG-05")).directives.map((x: any) => x.stale)).toEqual([true, false]);
  });
});

describe("reassigning and prioritizing", () => {
  const slowGemini = (): Agent => ({
    role: "gemini",
    async send(_p, ctx): Promise<AgentResponse> {
      await sleep(60);
      return { role: "gemini", content: `brief for ${ctx.title}` };
    },
  });

  it("moves a queued task to another slot, where it starts", async () => {
    const { c } = await setup({ gemini: slowGemini() });
    await c.runSlot("AG-03", "first");
    await c.runSlot("AG-03", "second");
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.running === 1);
    const second = (await c.slotSnapshot("AG-03")).tasks.find((t: any) => t.title === "second");
    await c.moveTask(second.id, "AG-04");
    await waitFor(async () => (await c.slotSnapshot("AG-04")).tasks[0]?.title === "second");
    const detail = await c.taskDetail(second.id);
    expect(detail.task.slotId).toBe("AG-04");
    expect(detail.task.trace?.some((t: any) => t.kind === "reassign" && /AG-03 to AG-04/.test(t.text))).toBe(true);
  });

  it("refuses to move a running task", async () => {
    const { c } = await setup({ gemini: slowGemini() });
    await c.runSlot("AG-03", "first");
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.running === 1);
    const [running] = (await c.slotSnapshot("AG-03")).tasks;
    await expect(c.moveTask(running.id, "AG-04")).rejects.toThrow(/đang chạy/);
  });

  it("moving a task to the top of its own queue makes it run next", async () => {
    const order: string[] = [];
    const gemini: Agent = {
      role: "gemini",
      async send(_p, ctx): Promise<AgentResponse> {
        order.push(ctx.title);
        await sleep(60);
        return { role: "gemini", content: "brief" };
      },
    };
    const { c } = await setup({ gemini });
    await c.runSlot("AG-03", "one");
    await c.runSlot("AG-03", "two");
    await c.runSlot("AG-03", "three");
    await waitFor(() => order.length === 1);
    const three = (await c.slotSnapshot("AG-03")).tasks.find((t: any) => t.title === "three");
    await c.moveTask(three.id, "AG-03", "top");
    await waitFor(() => order.length === 3, 5000);
    expect(order).toEqual(["one", "three", "two"]);
  });
});

describe("engine queues and checkpoint waits", () => {
  it("shows each task's place in an engine queue and lets the CEO move one to the front", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const gemini: Agent = {
      role: "gemini",
      async send(_p, ctx): Promise<AgentResponse> {
        order.push(ctx.title);
        if (order.length === 1) await gate; // hold the only slot so the others queue up
        return { role: "gemini", content: `brief for ${ctx.title}` };
      },
    };
    const { c } = await setup({ gemini });
    // One Gemini slot for this test.
    (c as any).engines.gemini = new (await import("../src/orchestrator/semaphore.js")).Semaphore(1);
    (c as any).agents.gemini = (await import("../src/agents/limited.js")).limitAgent(gemini, (c as any).engines.gemini, "gemini", {
      onWait: (id: string, e: any) => (c as any).pushActivity(id, e, "waiting"),
      onStart: (id: string, e: any) => (c as any).markRunning(id, e),
      onEnd: (id: string, e: any) => (c as any).popActivity(id, e),
    });
    await c.runSlot("AG-03", "first");
    await c.runSlot("AG-04", "second");
    await c.runSlot("AG-06", "third");
    await waitFor(() => c.engineSnapshot().gemini.waiting === 2);

    const snap = c.engineSnapshot().gemini;
    expect(snap.queue.running.map((x: any) => x.label)).toEqual(["first"]);
    expect(snap.queue.waiting.map((x: any) => x.label)).toEqual(["second", "third"]);
    const third = (await c.slotSnapshot("AG-06")).tasks[0];
    expect(third.engineQueue).toEqual({ engine: "gemini", state: "waiting", position: 2, of: 2 });

    await c.promote("gemini", third.id);
    expect(c.engineSnapshot().gemini.queue.waiting.map((x: any) => x.label)).toEqual(["third", "second"]);
    release();
    await waitFor(() => order.length === 3);
    expect(order).toEqual(["first", "third", "second"]);
    expect((await c.taskDetail(third.id)).task.trace?.some((t: any) => t.kind === "priority" && /gemini queue/.test(t.text))).toBe(true);
    await expect(c.promote("gemini", third.id)).rejects.toThrow(/không còn trong hàng đợi/);
  });

  it("records the time a task waits for the CEO, closes it with the decision, and summarizes the reviews", async () => {
    const { c } = await setup();
    const id = await taskAtFinal(c);
    const snap = (await c.slotSnapshot("AG-03")).tasks[0];
    expect(snap.review).toEqual({ verification: "passed", gemini: "approve", geminiStandIn: false, claude: "approve" });
    expect(snap.waitingSince).toBeTruthy();

    // Its verify command is a bare `true`, which never touches the file Muse
    // wrote: that's a red warning, so shipping needs an explicit confirmation.
    expect(snap.alerts.map((a: any) => a.level)).toContain("warn");
    await expect(c.decide(id, "approve")).rejects.toThrow(/cảnh báo đỏ/);
    expect(await c.approveAllWaiting()).toBe(0); // bulk approval skips results with red warnings
    await c.decide(id, "approve", undefined, { confirmWarnings: true });
    const runs = (await c.taskDetail(id)).task.runs!.filter((r: any) => r.human);
    expect(runs.map((r: any) => [r.stage, r.decision, Boolean(r.endedAt)])).toEqual([
      ["checkpoint_idea", "approve", true],
      ["checkpoint_final", "approve", true],
    ]);
    // Waiting for the CEO isn't counted as the agents' working time.
    expect((await c.slotSnapshot("AG-03")).tasks[0].lastRun.stage).not.toMatch(/checkpoint/);

    const statuses = (await c.timeline()).rows.find((r: any) => r.slotId === "AG-03").spans.map((s: any) => s.status);
    expect(statuses.filter((x: string) => x === "review")).toHaveLength(2);
    expect(statuses).toContain("done");
  });
});

describe("artifacts, traces and telemetry", () => {
  it("forwards one agent's artifact to another slot as input material", async () => {
    const { c, seen } = await setup();
    const id = await taskAtFinal(c);
    const arts = await c.listArtifacts(id);
    expect(arts.map((a: any) => a.kind).sort()).toEqual(["brief", "file", "spec", "verification"]);
    const file = arts.find((a: any) => a.kind === "file");
    expect((await c.artifactContent(id, "file", file.path)).content).toContain("Mock implementation note");

    const res = await c.sendArtifact({ taskId: id, kind: "spec" }, "AG-09", "Turn this into user docs");
    expect(res.created).toBe(true);
    await waitFor(() => seen.some((s) => s.ctx.attachments?.length));
    const call = seen.find((s) => s.ctx.attachments?.length)!;
    expect(call.ctx.attachments![0].title).toBe("Architecture guide");
    expect(call.ctx.attachments![0].content).toContain("Turn this into user docs");
    expect(call.ctx.attachments![0].from).toMatch(/^AG-03/);
  });

  it("counts only the current plan's tasks, and lists each plan as its own project", async () => {
    const { c } = await setup();
    const plan = await c.startPlan("first goal. More detail here");
    await waitFor(async () => (await c.planSnapshot())?.status === "awaiting_approval");
    await c.decidePlan(plan.id, true, undefined, { handoffOn: "checkpoint_final" });
    await waitFor(async () => (await c.telemetry()).counts.total === 9, 15000);

    const [project] = await c.projects();
    expect(project).toMatchObject({ id: plan.id, title: "first goal.", active: true, tasks: { total: 9 } });
    expect(project.finishedAt).toBeUndefined();
    await expect(c.projectGuide(plan.id)).rejects.toThrow(/chưa hoàn tất/);
    expect((await c.listArtifacts()).every((x: any) => x.planId === plan.id)).toBe(true);

    await c.stop();
    await c.startPlan("second goal");
    expect((await c.telemetry()).counts.total).toBe(0); // the first plan's 9 tasks no longer count
    expect((await c.projects()).find((p: any) => p.id === plan.id).active).toBe(false);
  });

  it("records stage runs, tokens, full prompts, the decision trace and the critical path", async () => {
    const { c } = await setup();
    await c.setGate("AG-08", false);
    await c.setGate("AG-10", false);
    const plan = await c.startPlan("goal");
    await waitFor(async () => (await c.planSnapshot())?.status === "awaiting_approval");
    await c.decidePlan(plan.id, true, undefined, { handoffOn: "checkpoint_final" });
    await waitFor(async () => (await tasksOf(c)).filter((t: any) => t.queueState === "waiting_you").length === 9, 15000);

    const tel = await c.telemetry();
    expect(tel.counts).toMatchObject({ total: 9, waitingYou: 9, running: 0 });
    expect(tel.percent).toBeGreaterThan(80);
    expect(tel.tokens.input).toBeGreaterThan(0);
    expect(tel.tokensEstimated).toBe(true); // mocks report no usage
    expect(Object.keys(tel.byEngine).sort()).toEqual(["claude", "gemini", "muse"]);

    const s1 = await byTitle(c, "E1.S1");
    expect(s1.lastRun.durationMs).toBeGreaterThanOrEqual(0);
    expect(s1.totals.runs).toBeGreaterThanOrEqual(6);
    expect(s1.assignedBy).toBe("AG-01 (Claude)");
    expect(s1.outputsTo.map((o: any) => o.slotId).sort()).toEqual(["AG-04", "AG-11"]);

    const detail = await c.taskDetail(s1.id);
    expect(detail.calls.length).toBeGreaterThanOrEqual(5);
    expect(detail.calls[0].prompt).toContain("E1.S1");
    expect(detail.task.trace?.find((t: any) => t.kind === "assign")?.text).toMatch(/Data engineering is AG-03's specialty/);

    const tl = await c.timeline();
    expect(tl.rows.find((r: any) => r.slotId === "AG-03").spans.length).toBeGreaterThan(0);
    const chain = tl.criticalPath!.tasks.map((t: any) => t.title.split(" ")[0]);
    // Every step of the chain depends on the one before it, so it starts with a task that has no dependencies.
    expect(["E1.S1", "E2.S1", "E3.S1"]).toContain(chain[0]);
    expect(tl.criticalPath!.totalMs).toBeGreaterThan(0);

    const ins = await c.insights();
    expect(ins.handoffs.length).toBeGreaterThan(0);
    expect(ins.alerts.some((a: any) => /chờ duyệt/.test(a.text))).toBe(true);
  });
});
