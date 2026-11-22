import { advance, createTask, isTerminal, isWaitingForHuman, resolveCheckpoint } from "../orchestrator/pipeline.js";
import { loadTask, saveTask, taskExists } from "../store/taskStore.js";
import { buildAgents, buildPipelineConfig, buildProjectConfigSnapshot } from "../config.js";
import type { TaskRecord } from "../types.js";
import { SLOTS, loadDashboardState, saveDashboardState } from "./slots.js";

/**
 * All slot actions go through one in-process queue, run strictly one at a
 * time — not per-slot-parallel — so "run the whole company" doesn't fire
 * 10 simultaneous bursts of Gemini/Claude/Muse calls at once (exactly the
 * kind of burst that tripped the free-tier rate limit earlier).
 */
type QueueJob =
  | { kind: "run"; slotId: string; goal?: string }
  | { kind: "decision"; slotId: string; approved: boolean; feedback?: string };

const queue: QueueJob[] = [];
let processing = false;

export function enqueueRun(slotId: string, goal?: string): void {
  queue.push({ kind: "run", slotId, goal });
  void processQueue();
}

export function enqueueDecision(slotId: string, approved: boolean, feedback?: string): void {
  queue.push({ kind: "decision", slotId, approved, feedback });
  void processQueue();
}

export function enqueueRunAll(goal: string): void {
  for (const slot of SLOTS) {
    queue.push({ kind: "run", slotId: slot.id, goal: `${slot.name}: ${goal}` });
  }
  void processQueue();
}

export function queueLength(): number {
  return queue.length + (processing ? 1 : 0);
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      await runJob(job).catch(() => {
        // A single bad job shouldn't wedge the rest of the queue.
      });
    }
  } finally {
    processing = false;
  }
}

async function runJob(job: QueueJob): Promise<void> {
  const state = await loadDashboardState();
  const taskId = state[job.slotId];

  if (job.kind === "decision") {
    if (!taskId || !taskExists(taskId)) return;
    const task = await loadTask(taskId);
    if (!isWaitingForHuman(task)) return;
    resolveCheckpoint(task, job.approved, job.feedback);
    await saveTask(task);
    await runToCheckpoint(task);
    return;
  }

  if (!taskId || !taskExists(taskId)) {
    const slot = SLOTS.find((s) => s.id === job.slotId);
    const title = job.goal?.trim() || `${slot?.name ?? job.slotId}: (chưa có mục tiêu cụ thể)`;
    const task = createTask(title, buildProjectConfigSnapshot());
    await saveTask(task);
    state[job.slotId] = task.id;
    await saveDashboardState(state);
    await runToCheckpoint(task);
    return;
  }

  const task = await loadTask(taskId);
  if (isWaitingForHuman(task) || isTerminal(task)) return;
  await runToCheckpoint(task);
}

async function runToCheckpoint(task: TaskRecord): Promise<void> {
  const agents = buildAgents();
  const config = buildPipelineConfig();
  while (!isWaitingForHuman(task) && !isTerminal(task)) {
    try {
      await advance(task, agents, config);
    } catch (err) {
      task.context.reviewFeedback = [`Lỗi khi chạy tự động: ${(err as Error).message}`];
      await saveTask(task);
      return;
    }
    await saveTask(task);
  }
}

export async function resetAllSlots(): Promise<void> {
  const empty = Object.fromEntries(SLOTS.map((s) => [s.id, null]));
  await saveDashboardState(empty);
}
