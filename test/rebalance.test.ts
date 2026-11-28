import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRebalancePrompt, parseRebalance, type LoadSlot } from "../src/orchestrator/rebalance.js";
import type { Agent, AgentResponse } from "../src/types.js";

const slot = (id: string, tier: 1 | 2 | 3, tasks: LoadSlot["tasks"] = []): LoadSlot => ({
  id,
  name: `Slot ${id}`,
  tier,
  parallel: 1,
  running: tasks.filter((t) => t.queueState === "running").length,
  queued: tasks.filter((t) => t.queueState === "queued").length,
  waitingYou: 0,
  tasks,
});
const task = (id: string, queueState = "queued", movable = true) => ({ id, title: `Task ${id}`, stage: "ideation", queueState, brief: "", waitingOn: [], unblocks: [], movable });

const LOAD: LoadSlot[] = [
  slot("AG-01", 1),
  slot("AG-03", 3, [task("t1", "running", false), task("t2"), task("t3")]),
  slot("AG-04", 3),
];

describe("parseRebalance", () => {
  it("keeps valid reassignments and reprioritizations, with their reasons", () => {
    const reply = JSON.stringify({
      summary: "AG-03 quá tải",
      moves: [
        { taskId: "t3", to: "AG-04", position: "bottom", reason: "AG-04 đang rảnh và cùng chuyên môn dữ liệu" },
        { taskId: "t2", to: "AG-03", position: "top", reason: "t2 mở khoá cho AG-05" },
      ],
    });
    const out = parseRebalance(`Đây là đề xuất:\n\`\`\`json\n${reply}\n\`\`\``, LOAD);
    expect(out.summary).toBe("AG-03 quá tải");
    expect(out.moves).toEqual([
      { taskId: "t3", title: "Task t3", from: "AG-03", to: "AG-04", position: "bottom", kind: "reassign", reason: "AG-04 đang rảnh và cùng chuyên môn dữ liệu" },
      { taskId: "t2", title: "Task t2", from: "AG-03", to: "AG-03", position: "top", kind: "priority", reason: "t2 mở khoá cho AG-05" },
    ]);
    expect(out.notes).toEqual([]);
  });

  it("drops running tasks, unknown tasks, moves to the boss or nowhere, no-ops and duplicates — and says why", () => {
    const reply = JSON.stringify({
      moves: [
        { taskId: "t1", to: "AG-04", reason: "x" },
        { taskId: "nope", to: "AG-04", reason: "x" },
        { taskId: "t2", to: "AG-01", reason: "x" },
        { taskId: "t2", to: "AG-99", reason: "x" },
        { taskId: "t2", to: "AG-03", position: "bottom", reason: "x" },
        { taskId: "t3", to: "AG-04" },
        { taskId: "t3", to: "AG-04", reason: "again" },
      ],
    });
    const out = parseRebalance(reply, LOAD);
    expect(out.moves.map((m) => m.taskId)).toEqual(["t3"]);
    expect(out.moves[0].reason).toBe("(Sếp không nêu lý do)");
    expect(out.notes).toHaveLength(6);
  });

  it("rejects a reply that isn't JSON", () => {
    expect(() => parseRebalance("Tôi nghĩ nên chuyển t3 sang AG-04.", LOAD)).toThrow(/JSON/);
  });

  it("puts the load data after a marker the mock (and a human reading the log) can find", () => {
    const prompt = buildRebalancePrompt(LOAD);
    expect(prompt.startsWith("REBALANCE:")).toBe(true);
    expect(JSON.parse(prompt.slice(prompt.indexOf("LOAD_JSON:") + "LOAD_JSON:".length))).toEqual(LOAD);
  });
});

// ---- end to end through the scheduler ----
const originalCwd = process.cwd();
let company: { close(): Promise<void> } | undefined;
afterEach(async () => {
  await company?.close();
  company = undefined;
  process.chdir(originalCwd);
  vi.resetModules();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(15);
  }
}

async function setup(claude?: Agent) {
  process.chdir(mkdtempSync(path.join(tmpdir(), "rebalance-test-")));
  vi.resetModules();
  const { Company } = await import("../src/orchestrator/scheduler.js");
  const { createMockAgent } = await import("../src/agents/mock.js");
  const slowGemini: Agent = {
    role: "gemini",
    async send(_p, ctx): Promise<AgentResponse> {
      await sleep(300);
      return { role: "gemini", content: `brief for ${ctx.title}` };
    },
  };
  const c = new Company({
    agents: { claude: claude ?? createMockAgent("claude"), gemini: slowGemini, muse: createMockAgent("muse") },
    pipeline: { verify: { cwd: process.cwd(), commands: ["true"] }, maxImplementationAttempts: 3, maxReviewRejections: 3 },
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
  return c;
}

describe("boss rebalance proposals", () => {
  it("proposes moving work off an overloaded slot, and applies only what the CEO picked, with the reason traced", async () => {
    const c = await setup();
    await c.runSlot("AG-03", "a");
    await c.runSlot("AG-03", "b");
    await c.runSlot("AG-03", "c");
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.running === 1);

    const p = await c.proposeRebalance();
    expect(p.status).toBe("drafting");
    await waitFor(() => c.rebalanceSnapshot()?.status === "ready");
    const ready = c.rebalanceSnapshot()!;
    expect(ready.moves).toHaveLength(1);
    const move = ready.moves[0];
    expect(move.from).toBe("AG-03");
    expect(move.to).not.toBe("AG-03");
    expect(move.reason).toMatch(/quá tải/);

    const res = await c.applyRebalance(ready.id, [0]);
    expect(res).toEqual({ applied: 1, skipped: 0 });
    expect(c.rebalanceSnapshot()?.status).toBe("applied");
    const detail = await c.taskDetail(move.taskId);
    expect(detail.task.slotId).toBe(move.to);
    const t = detail.task.trace!.find((x: any) => x.kind === "reassign")!;
    expect(t.by).toBe("AG-01 (Claude) · CEO duyệt");
    expect(t.text).toMatch(/quá tải/);

    c.dismissRebalance();
    expect(c.rebalanceSnapshot()).toBeNull();
  });

  it("answers without calling Claude when nothing is movable", async () => {
    let calls = 0;
    const claude: Agent = { role: "claude", async send() { calls++; return { role: "claude", content: "{}" }; } };
    const c = await setup(claude);
    const p = await c.proposeRebalance();
    expect(p.status).toBe("ready");
    expect(p.moves).toEqual([]);
    expect(calls).toBe(0);
  });

  it("fails visibly on an unusable reply, and refuses to apply a proposal that isn't ready", async () => {
    const claude: Agent = { role: "claude", async send() { return { role: "claude", content: "Mọi thứ ổn cả." }; } };
    const c = await setup(claude);
    await c.runSlot("AG-03", "a");
    await c.runSlot("AG-03", "b");
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.running === 1);
    const p = await c.proposeRebalance();
    await waitFor(() => c.rebalanceSnapshot()?.status === "failed");
    expect(c.rebalanceSnapshot()?.error).toMatch(/JSON/);
    await expect(c.applyRebalance(p.id)).rejects.toThrow(/hiệu lực/);
  });

  it("skips a move whose task started running in the meantime, and notes it", async () => {
    const claude: Agent = {
      role: "claude",
      async send(prompt): Promise<AgentResponse> {
        const load = JSON.parse(prompt.slice(prompt.indexOf("LOAD_JSON:") + "LOAD_JSON:".length));
        const queued = load.find((s: any) => s.id === "AG-03").tasks.find((t: any) => t.movable);
        return { role: "claude", content: JSON.stringify({ summary: "s", moves: [{ taskId: queued.id, to: "AG-04", reason: "r" }] }) };
      },
    };
    const c = await setup(claude);
    await c.runSlot("AG-03", "a");
    await c.runSlot("AG-03", "b");
    await waitFor(async () => (await c.slotSnapshot("AG-03")).counts.running === 1);
    await c.proposeRebalance();
    await waitFor(() => c.rebalanceSnapshot()?.status === "ready");
    // Let "a" finish so "b" starts running before the CEO applies.
    await waitFor(async () => (await c.slotSnapshot("AG-03")).tasks.find((t: any) => t.title === "b")?.queueState === "running", 5000);
    const res = await c.applyRebalance(c.rebalanceSnapshot()!.id);
    expect(res).toEqual({ applied: 0, skipped: 1 });
    expect(c.rebalanceSnapshot()?.notes.at(-1)).toMatch(/đang chạy/);
  });
});
