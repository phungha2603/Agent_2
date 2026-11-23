import { EventEmitter } from "node:events";
import type { HandoffArtifact, ProjectConfig, TaskRecord } from "../types.js";
import { Semaphore } from "./semaphore.js";
import { limitAgent, type EngineName } from "../agents/limited.js";
import {
  advance,
  createTask,
  isTerminal,
  isWaitingForHuman,
  log,
  resolveCheckpoint,
  retryFromRejected,
  type Agents,
  type PipelineConfig,
} from "./pipeline.js";
import { buildHandoff, reachedHandoffPoint, type HandoffPoint } from "./handoff.js";
import { draftAndReviewPlan, materializePlan, newPlanId, type Department, type PlanLimits, type WorkPlan, type WorkPlanRecord } from "./planner.js";
import { loadTask, saveTask, taskExists } from "../store/taskStore.js";
import { loadPlan, savePlan } from "../store/planStore.js";
import { SLOTS, TIER_LABELS, deriveStatus, loadDashboardState, saveDashboardState, type DashboardState } from "../dashboard/slots.js";

export interface SchedulerSettings {
  claudeConcurrency: number;
  geminiConcurrency: number;
  /** Tasks one slot may have in progress at once, unless overridden per slot. */
  defaultSlotParallel: number;
  slotParallel: Record<string, number>;
  /** Automatic retries of a stage that threw (network, CLI crash, ...) before pausing the task. */
  stageErrorRetries: number;
  stageErrorBackoffMs: number[];
  handoffOn: HandoffPoint;
  planMaxRounds: number;
  planLimits: PlanLimits;
}

export interface CompanyOptions {
  agents: Agents;
  pipeline: PipelineConfig;
  settings: SchedulerSettings;
  projectConfig?: () => ProjectConfig | undefined;
}

export interface Activity {
  engine: EngineName;
  state: "waiting" | "running";
  since: string;
}

export type QueueState = "running" | "waiting_you" | "error" | "rejected" | "blocked" | "waiting_deps" | "queued" | "done";

export interface TaskSnapshot {
  id: string;
  title: string;
  stage: string;
  label: string;
  colorClass: string;
  progress: number;
  queueState: QueueState;
  waitingForYou: boolean;
  checkpointBrief?: string;
  lastFeedback?: string;
  lastError?: string;
  logs: { at: string; text: string }[];
  acceptanceCriteria: string[];
  deps: { total: number; ready: number; waitingOn: string[]; blockedBy?: string };
  activity: Activity | null;
  stageStartedAt?: string;
  liveTail: string;
  liveTotal: number;
  planRef?: TaskRecord["planRef"];
  handedOff: boolean;
}

export interface SlotSnapshot {
  id: string;
  name: string;
  icon: string;
  tier: 1 | 2 | 3;
  tierLabel: string;
  isBoss: boolean;
  parallel: number;
  counts: { running: number; queued: number; waitingYou: number; done: number; problems: number };
  tasks: TaskSnapshot[];
}

export type EngineSnapshot = Record<EngineName, { limit: number; running: number; waiting: number }>;

interface Worker {
  slotId: string;
  cancelled: boolean;
}

interface DependencyState {
  state: "ready" | "waiting" | "blocked";
  handoffs: HandoffArtifact[];
  waitingOn: string[];
  blockedBy?: string;
  total: number;
}

const DEPARTMENTS: Department[] = SLOTS.map((s) => ({ id: s.id, name: s.name, tier: s.tier }));
const BOSS_ID = SLOTS.find((s) => s.tier === 1)!.id;
const LIVE_TAIL_CHARS = 2000;
const LIVE_FLUSH_MS = 250;
const DONE_SHOWN_PER_SLOT = 5;
const QUEUE_ORDER: QueueState[] = ["running", "waiting_you", "error", "blocked", "waiting_deps", "queued", "rejected", "done"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

/**
 * Runs the company: per-slot task queues with a per-slot parallelism cap,
 * per-engine concurrency limits (Claude, Gemini, Muse — Muse is always 1,
 * it's one browser), a lock on the shared project directory for the
 * write-then-verify step, dependency-ordered handoffs between tasks,
 * automatic retries, and the boss's plan. Emits "slot" (slotId), "plan",
 * "engines" and "live" ({ id, slotId, text }) events for the dashboard.
 *
 * Planning, architecture and reviews (Claude/Gemini) for different tasks run
 * in parallel; implementation+verification is serialized across tasks
 * because they all write into, and build, the same VERIFY_CWD — two tasks'
 * files landing in between one task's write and its build would make that
 * build meaningless.
 */
export class Company extends EventEmitter {
  readonly engines: Record<EngineName, Semaphore>;
  private readonly agents: Agents;
  private readonly rawAgents: Agents;
  private readonly pipeline: PipelineConfig;
  private readonly settings: SchedulerSettings;
  private readonly projectConfig: () => ProjectConfig | undefined;
  private state: DashboardState = { slots: {}, activePlanId: null };
  private readonly workers = new Map<string, Worker>();
  /** In-memory task objects for running workers — the source of truth while they run. */
  private readonly running = new Map<string, TaskRecord>();
  private readonly activity = new Map<string, Activity[]>();
  private readonly liveTail = new Map<string, string>();
  private readonly liveBuffer = new Map<string, { stage: string; start: number; text: string }>();
  /** Characters produced so far in the current stage (not truncated like liveTail). */
  private readonly liveTotal = new Map<string, number>();
  private liveTimer: NodeJS.Timeout | null = null;
  private pumping = false;
  private pumpAgain = false;
  private stateWrite: Promise<void> = Promise.resolve();
  private planPhase: string | null = null;

  constructor(opts: CompanyOptions) {
    super();
    this.setMaxListeners(100);
    this.rawAgents = opts.agents;
    this.pipeline = opts.pipeline;
    this.settings = opts.settings;
    this.projectConfig = opts.projectConfig ?? (() => undefined);
    this.engines = {
      claude: new Semaphore(opts.settings.claudeConcurrency),
      gemini: new Semaphore(opts.settings.geminiConcurrency),
      muse: new Semaphore(1),
      workspace: new Semaphore(1),
    };
    const hooks = {
      onWait: (id: string, engine: EngineName) => this.pushActivity(id, engine, "waiting"),
      onStart: (id: string, engine: EngineName) => this.markRunning(id, engine),
      onEnd: (id: string, engine: EngineName) => this.popActivity(id, engine),
    };
    this.agents = {
      claude: limitAgent(opts.agents.claude, this.engines.claude, "claude", hooks),
      gemini: limitAgent(opts.agents.gemini, this.engines.gemini, "gemini", hooks),
      muse: limitAgent(opts.agents.muse, this.engines.muse, "muse", hooks),
    };
  }

  async init(): Promise<void> {
    this.state = await loadDashboardState();
    const plan = await this.activePlan();
    if (plan?.status === "drafting") {
      // The process that was generating it is gone.
      plan.status = "failed";
      plan.error = "The server stopped while this plan was being drafted — retry to draft it again.";
      await savePlan(plan);
    }
    this.pump();
  }

  async close(): Promise<void> {
    for (const w of this.workers.values()) w.cancelled = true;
    await Promise.all(Object.values(this.rawAgents).map((a) => a.close?.().catch(() => {})));
  }

  // ---------- commands ----------

  /** A goal adds a new task to the slot's queue; no goal resumes the slot's paused (errored) tasks. */
  async runSlot(slotId: string, goal?: string): Promise<void> {
    if (!SLOTS.some((s) => s.id === slotId)) throw new Error(`unknown slot ${slotId}`);
    const text = goal?.trim();
    if (text) {
      const task = createTask(text, this.projectConfig());
      task.slotId = slotId;
      await saveTask(task);
      await this.mutateState((s) => s.slots[slotId].push(task.id));
    } else {
      for (const id of this.state.slots[slotId]) {
        const task = await this.load(id);
        if (task?.lastError && !this.workers.has(id)) {
          task.lastError = undefined;
          log(task, task.stage, "ceo", "Resumed by the CEO.");
          await saveTask(task);
        }
      }
    }
    this.emit("slot", slotId);
    this.pump();
  }

  async decide(taskId: string, approved: boolean, feedback?: string): Promise<void> {
    if (this.workers.has(taskId)) throw new Error("task is running");
    const task = await this.load(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (!isWaitingForHuman(task)) throw new Error(`task is not waiting for a decision (stage: ${task.stage})`);
    const hadHandoff = Boolean(task.handoff);
    resolveCheckpoint(task, approved, feedback?.trim() || undefined);
    if (approved && !task.handoff && reachedHandoffPoint(task.stage, this.settings.handoffOn)) {
      await this.publishHandoff(task);
    }
    if (!approved && hadHandoff) {
      task.handoff = undefined;
      for (const dep of await this.findDependents(task.id)) {
        log(dep, dep.stage, "system", `Warning: upstream "${task.context.title}" was sent back by the CEO after handing off — this task built on a version that may still change.`);
        await saveTask(dep);
        this.emitTask(dep);
      }
    }
    await saveTask(task);
    this.emitTask(task);
    this.pump();
  }

  /** The CEO approving every task currently waiting at a checkpoint in one go. Returns how many were approved. */
  async approveAllWaiting(): Promise<number> {
    let approved = 0;
    for (const ids of Object.values(this.state.slots)) {
      for (const id of [...ids]) {
        if (this.workers.has(id)) continue;
        const task = await this.load(id);
        if (task && isWaitingForHuman(task)) {
          await this.decide(id, true);
          approved++;
        }
      }
    }
    return approved;
  }

  /** Clears a paused runtime error, or gives a rejected task a fresh budget (keeping its last feedback). */
  async retryTask(taskId: string): Promise<void> {
    if (this.workers.has(taskId)) throw new Error("task is running");
    const task = await this.load(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (task.lastError) {
      task.lastError = undefined;
      log(task, task.stage, "ceo", "Retry requested by the CEO.");
    } else if (task.stage === "rejected") {
      retryFromRejected(task);
    } else {
      throw new Error("nothing to retry");
    }
    await saveTask(task);
    this.emitTask(task);
    this.pump();
  }

  async startPlan(goal: string): Promise<WorkPlanRecord> {
    const current = await this.activePlan();
    if (current && (current.status === "drafting" || current.status === "awaiting_approval")) {
      throw new Error("A plan is already being drafted or waiting for approval — decide on it first.");
    }
    const now = new Date().toISOString();
    const plan: WorkPlanRecord = { id: newPlanId(), goal: goal.trim(), status: "drafting", createdAt: now, updatedAt: now };
    await savePlan(plan);
    await this.mutateState((s) => (s.activePlanId = plan.id));
    this.emitPlan();
    void this.generatePlan(plan);
    return plan;
  }

  async decidePlan(planId: string, approved: boolean, feedback?: string): Promise<void> {
    const plan = await loadPlan(planId);
    if (!plan || plan.status !== "awaiting_approval") throw new Error("plan is not waiting for approval");
    if (approved) {
      const tasks = materializePlan(plan, this.projectConfig());
      for (const t of tasks) await saveTask(t);
      plan.status = "approved";
      await savePlan(plan);
      await this.mutateState((s) => {
        for (const t of tasks) s.slots[t.slotId!].push(t.id);
      });
      for (const slot of new Set(tasks.map((t) => t.slotId!))) this.emit("slot", slot);
      this.emitPlan();
      this.pump();
      return;
    }
    const previous: WorkPlan | undefined = plan.epics ? { summary: plan.summary ?? "", epics: plan.epics } : undefined;
    plan.status = "drafting";
    plan.revisionFeedback = feedback?.trim() || "The CEO rejected this plan without a specific note — rethink the breakdown.";
    await savePlan(plan);
    this.emitPlan();
    void this.generatePlan(plan, { feedback: plan.revisionFeedback, previous });
  }

  async retryPlan(planId: string): Promise<void> {
    const plan = await loadPlan(planId);
    if (!plan || plan.status !== "failed") throw new Error("plan has not failed");
    plan.status = "drafting";
    plan.error = undefined;
    await savePlan(plan);
    this.emitPlan();
    void this.generatePlan(plan, plan.revisionFeedback ? { feedback: plan.revisionFeedback } : undefined);
  }

  /** Un-assigns every task (task files stay in data/tasks) and stops running workers after their current stage. */
  async reset(): Promise<void> {
    for (const w of this.workers.values()) w.cancelled = true;
    const plan = await this.activePlan();
    if (plan && (plan.status === "drafting" || plan.status === "awaiting_approval")) {
      plan.status = "discarded";
      await savePlan(plan);
    }
    await this.mutateState((s) => {
      for (const slot of SLOTS) s.slots[slot.id] = [];
      s.activePlanId = null;
    });
    for (const slot of SLOTS) this.emit("slot", slot.id);
    this.emitPlan();
  }

  // ---------- snapshots ----------

  engineSnapshot(): EngineSnapshot {
    const snap = {} as EngineSnapshot;
    for (const [name, sem] of Object.entries(this.engines) as [EngineName, Semaphore][]) {
      snap[name] = { limit: sem.limit, running: sem.running, waiting: sem.waiting };
    }
    return snap;
  }

  async slotSnapshot(slotId: string): Promise<SlotSnapshot> {
    const slot = SLOTS.find((s) => s.id === slotId);
    if (!slot) throw new Error(`unknown slot ${slotId}`);
    const tasks: TaskSnapshot[] = [];
    for (const id of this.state.slots[slotId] ?? []) {
      const task = await this.load(id);
      if (task) tasks.push(await this.taskSnapshot(task));
    }
    tasks.sort((a, b) => QUEUE_ORDER.indexOf(a.queueState) - QUEUE_ORDER.indexOf(b.queueState));
    const done = tasks.filter((t) => t.queueState === "done");
    const shown = [...tasks.filter((t) => t.queueState !== "done"), ...done.slice(-DONE_SHOWN_PER_SLOT).reverse()];
    const count = (...states: QueueState[]) => tasks.filter((t) => states.includes(t.queueState)).length;
    return {
      id: slot.id,
      name: slot.name,
      icon: slot.icon,
      tier: slot.tier,
      tierLabel: TIER_LABELS[slot.tier],
      isBoss: slot.tier === 1,
      parallel: this.parallelFor(slot.id),
      counts: {
        running: count("running"),
        queued: count("queued", "waiting_deps", "blocked"),
        waitingYou: count("waiting_you"),
        done: done.length,
        problems: count("error", "rejected"),
      },
      tasks: shown,
    };
  }

  async planSnapshot(): Promise<(WorkPlanRecord & { phase: string | null; activity: Activity | null; liveTail: string; liveTotal: number; taskStages: Record<string, string> }) | null> {
    const plan = await this.activePlan();
    if (!plan) return null;
    const taskStages: Record<string, string> = {};
    for (const epic of plan.epics ?? []) {
      for (const id of [epic.taskId, ...epic.subtasks.map((s) => s.taskId)]) {
        if (!id) continue;
        const t = await this.load(id);
        if (t) taskStages[id] = (await this.taskSnapshot(t)).queueState === "running" ? `${t.stage} ▶` : t.stage;
      }
    }
    const key = `plan:${plan.id}`;
    return {
      ...plan,
      phase: plan.status === "drafting" ? this.planPhase : null,
      activity: this.currentActivity(key),
      liveTail: this.liveTail.get(key) ?? "",
      liveTotal: this.liveTotal.get(key) ?? 0,
      taskStages,
    };
  }

  async statusSnapshot() {
    return {
      slots: await Promise.all(SLOTS.map((s) => this.slotSnapshot(s.id))),
      engines: this.engineSnapshot(),
      plan: await this.planSnapshot(),
      settings: { handoffOn: this.settings.handoffOn, stageErrorRetries: this.settings.stageErrorRetries, maxAutoRecoveries: this.pipeline.maxAutoRecoveries ?? 0 },
    };
  }

  // ---------- scheduling ----------

  private parallelFor(slotId: string): number {
    return this.settings.slotParallel[slotId] ?? this.settings.defaultSlotParallel;
  }

  pump(): void {
    void this.doPump();
  }

  private async doPump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (const slot of SLOTS) {
          const limit = this.parallelFor(slot.id);
          let active = [...this.workers.values()].filter((w) => w.slotId === slot.id).length;
          for (const id of this.state.slots[slot.id] ?? []) {
            if (active >= limit) break;
            if (this.workers.has(id)) continue;
            const task = await this.load(id);
            if (!task || isTerminal(task) || isWaitingForHuman(task) || task.lastError) continue;
            const deps = await this.dependencyState(task);
            if (deps.state !== "ready") continue;
            if (task.dependsOn?.length && !task.context.upstream?.length) {
              task.context.upstream = deps.handoffs;
              log(task, task.stage, "system", `Received ${deps.handoffs.length} upstream handoff(s): ${deps.handoffs.map((h) => h.title).join("; ")}.`);
              await saveTask(task);
            }
            this.startWorker(task, slot.id);
            active++;
          }
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private startWorker(task: TaskRecord, slotId: string): void {
    const worker: Worker = { slotId, cancelled: false };
    this.workers.set(task.id, worker);
    this.running.set(task.id, task);
    task.slotId ??= slotId;
    void this.runWorker(task, worker);
  }

  private async runWorker(task: TaskRecord, w: Worker): Promise<void> {
    this.emit("slot", w.slotId);
    try {
      while (!isWaitingForHuman(task) && !isTerminal(task) && !w.cancelled) {
        if (!(await this.runStage(task, w))) break;
      }
    } catch (err) {
      task.lastError = { at: new Date().toISOString(), stage: task.stage, message: (err as Error).message, attempts: 1 };
      await saveTask(task).catch(() => {});
    } finally {
      this.workers.delete(task.id);
      this.running.delete(task.id);
      this.resetLive(task.id);
      this.emit("slot", w.slotId);
      if (task.planRef) this.emitPlan();
      this.emit("engines");
      this.pump();
    }
  }

  /** Runs the current stage with automatic retries on runtime errors. False means stop this worker. */
  private async runStage(task: TaskRecord, w: Worker): Promise<boolean> {
    const retries = this.settings.stageErrorRetries;
    for (let attempt = 0; ; attempt++) {
      task.stageStartedAt = new Date().toISOString();
      this.resetLive(task.id);
      await saveTask(task);
      this.emitTask(task);
      try {
        await this.executeStage(task);
        task.lastError = undefined;
        await this.afterStage(task);
        return true;
      } catch (err) {
        if (w.cancelled) return false;
        const message = (err as Error).message ?? String(err);
        if (attempt < retries) {
          const backoff = this.settings.stageErrorBackoffMs;
          const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 5000;
          log(task, task.stage, "system", `Runtime error at ${task.stage} (attempt ${attempt + 1}/${retries + 1}): ${message} — retrying in ${Math.round(delay / 1000)}s.`);
          await saveTask(task);
          this.emitTask(task);
          await sleep(delay);
          if (w.cancelled) return false;
          continue;
        }
        task.lastError = { at: new Date().toISOString(), stage: task.stage, message, attempts: attempt + 1 };
        log(task, task.stage, "system", `Paused after ${attempt + 1} failed attempt(s) at ${task.stage}: ${message}`);
        await saveTask(task);
        this.emitTask(task);
        return false;
      }
    }
  }

  private async executeStage(task: TaskRecord): Promise<void> {
    const hooks = { onChunk: (text: string) => this.onChunk(task.id, text) };
    if (task.stage !== "implementation" && task.stage !== "verification") {
      await advance(task, this.agents, this.pipeline, hooks);
      return;
    }
    await this.withEngine("workspace", task.id, async () => {
      const wasImplementation = task.stage === "implementation";
      await advance(task, this.agents, this.pipeline, hooks);
      if (wasImplementation && task.stage === "verification") {
        // Verify while still holding the workspace, so no other task's
        // files land between this task's write and its build.
        await saveTask(task);
        task.stageStartedAt = new Date().toISOString();
        this.resetLive(task.id);
        this.emitTask(task);
        await advance(task, this.agents, this.pipeline, hooks);
      }
    });
  }

  private async afterStage(task: TaskRecord): Promise<void> {
    if (!task.handoff && reachedHandoffPoint(task.stage, this.settings.handoffOn)) {
      await this.publishHandoff(task);
    }
    await saveTask(task);
    this.emitTask(task);
    if (task.handoff) this.pump();
  }

  private async publishHandoff(task: TaskRecord): Promise<void> {
    task.handoff = buildHandoff(task);
    const dependents = await this.findDependents(task.id);
    log(
      task,
      task.stage,
      "system",
      dependents.length
        ? `Handoff ready — passed to ${dependents.length} dependent task(s): ${dependents.map((d) => `${d.slotId ?? "?"} ${d.context.title}`).join("; ")}.`
        : "Handoff ready.",
    );
  }

  private async dependencyState(task: TaskRecord): Promise<DependencyState> {
    const ids = task.dependsOn ?? [];
    const result: DependencyState = { state: "ready", handoffs: [], waitingOn: [], total: ids.length };
    for (const id of ids) {
      const dep = await this.load(id);
      if (!dep) {
        result.state = "blocked";
        result.blockedBy = `dependency ${id} no longer exists`;
        continue;
      }
      if (dep.handoff) {
        result.handoffs.push(dep.handoff);
      } else if (dep.stage === "rejected") {
        result.state = "blocked";
        result.blockedBy = `"${dep.context.title}" was rejected — retry it to unblock this task`;
      } else {
        if (result.state === "ready") result.state = "waiting";
        result.waitingOn.push(`${dep.slotId ?? "?"} ${dep.context.title}`);
      }
    }
    return result;
  }

  private async findDependents(taskId: string): Promise<TaskRecord[]> {
    const out: TaskRecord[] = [];
    for (const ids of Object.values(this.state.slots)) {
      for (const id of ids) {
        const t = await this.load(id);
        if (t?.dependsOn?.includes(taskId)) out.push(t);
      }
    }
    return out;
  }

  private async generatePlan(plan: WorkPlanRecord, revision?: { feedback: string; previous?: WorkPlan }): Promise<void> {
    const key = `plan:${plan.id}`;
    this.planPhase = "Claude is drafting";
    try {
      const res = await draftAndReviewPlan({ claude: this.agents.claude, gemini: this.agents.gemini }, plan.goal, DEPARTMENTS, {
        maxRounds: this.settings.planMaxRounds,
        limits: this.settings.planLimits,
        revisionFeedback: revision?.feedback,
        previous: revision?.previous,
        send: { taskId: key, onChunk: (t) => this.onChunk(key, t) },
        onRound: (round, phase) => {
          this.planPhase = phase === "draft" ? `Round ${round}: Claude is drafting` : `Round ${round}: Gemini is reviewing`;
          this.resetLive(key);
          this.emitPlan();
        },
      });
      Object.assign(plan, {
        summary: res.plan.summary,
        epics: res.plan.epics,
        notes: res.notes,
        reviewRounds: res.rounds,
        unresolvedReview: res.unresolvedReview,
        status: "awaiting_approval",
        error: undefined,
      });
    } catch (err) {
      plan.status = "failed";
      plan.error = (err as Error).message;
    }
    this.planPhase = null;
    this.resetLive(key);
    if (this.state.activePlanId !== plan.id) plan.status = "discarded"; // reset while drafting
    await savePlan(plan);
    this.emitPlan();
  }

  // ---------- helpers ----------

  private async activePlan(): Promise<WorkPlanRecord | undefined> {
    return this.state.activePlanId ? loadPlan(this.state.activePlanId) : undefined;
  }

  private async load(id: string): Promise<TaskRecord | undefined> {
    const live = this.running.get(id);
    if (live) return live;
    if (!taskExists(id)) return undefined;
    try {
      return await loadTask(id);
    } catch (err) {
      console.error(`Could not load task ${id} (${(err as Error).message}).`);
      return undefined;
    }
  }

  private async mutateState(fn: (s: DashboardState) => void): Promise<void> {
    fn(this.state);
    const snapshot = JSON.parse(JSON.stringify(this.state)) as DashboardState;
    this.stateWrite = this.stateWrite.then(() => saveDashboardState(snapshot)).catch((err) => console.error(`Could not save dashboard state: ${err.message}`));
    await this.stateWrite;
  }

  private async withEngine<T>(engine: EngineName, id: string, fn: () => Promise<T>): Promise<T> {
    this.pushActivity(id, engine, "waiting");
    const release = await this.engines[engine].acquire();
    this.markRunning(id, engine);
    try {
      return await fn();
    } finally {
      release();
      this.popActivity(id, engine);
    }
  }

  private pushActivity(id: string, engine: EngineName, state: Activity["state"]): void {
    const stack = this.activity.get(id) ?? [];
    stack.push({ engine, state, since: new Date().toISOString() });
    this.activity.set(id, stack);
    this.emitActivity(id);
  }

  private markRunning(id: string, engine: EngineName): void {
    const stack = this.activity.get(id) ?? [];
    const entry = [...stack].reverse().find((a) => a.engine === engine && a.state === "waiting");
    if (entry) {
      entry.state = "running";
      entry.since = new Date().toISOString();
    } else {
      stack.push({ engine, state: "running", since: new Date().toISOString() });
      this.activity.set(id, stack);
    }
    this.emitActivity(id);
  }

  private popActivity(id: string, engine: EngineName): void {
    const stack = this.activity.get(id) ?? [];
    const idx = stack.map((a) => a.engine).lastIndexOf(engine);
    if (idx !== -1) stack.splice(idx, 1);
    if (stack.length === 0) this.activity.delete(id);
    this.emitActivity(id);
  }

  private currentActivity(id: string): Activity | null {
    const stack = this.activity.get(id);
    return stack?.length ? stack[stack.length - 1] : null;
  }

  private emitActivity(id: string): void {
    this.emit("engines");
    if (id.startsWith("plan:")) this.emitPlan();
    else {
      const slotId = this.slotOf(id);
      if (slotId) this.emit("slot", slotId);
    }
  }

  private slotOf(taskId: string): string | undefined {
    for (const [slotId, ids] of Object.entries(this.state.slots)) if (ids.includes(taskId)) return slotId;
    return undefined;
  }

  private emitTask(task: TaskRecord): void {
    const slotId = task.slotId ?? this.slotOf(task.id);
    if (slotId) this.emit("slot", slotId);
    if (task.planRef) this.emitPlan();
  }

  private emitPlan(): void {
    this.emit("plan");
    this.emit("slot", BOSS_ID);
  }

  /** What a live chunk belongs to — the task's stage, or the plan's current round/phase — so the UI can start a fresh box when it changes. */
  private liveStageOf(id: string): string {
    return id.startsWith("plan:") ? (this.planPhase ?? "") : (this.running.get(id)?.stage ?? "");
  }

  /**
   * `start` is the character offset of this text within the stage's output,
   * so a client that already has some of it (from a snapshot's liveTail
   * taken while this chunk was still buffered) appends only the unseen part.
   */
  private emitLive(id: string, buf: { stage: string; start: number; text: string }): void {
    this.emit("live", { id, slotId: id.startsWith("plan:") ? BOSS_ID : this.slotOf(id), stage: buf.stage, start: buf.start, text: buf.text });
  }

  /** A new stage (or plan round) starts with an empty live box. */
  private resetLive(id: string): void {
    const pending = this.liveBuffer.get(id);
    if (pending) {
      this.emitLive(id, pending);
      this.liveBuffer.delete(id);
    }
    this.liveTail.delete(id);
    this.liveTotal.delete(id);
  }

  private onChunk(id: string, text: string): void {
    if (!text) return;
    const stage = this.liveStageOf(id);
    const start = this.liveTotal.get(id) ?? 0;
    this.liveTotal.set(id, start + text.length);
    this.liveTail.set(id, ((this.liveTail.get(id) ?? "") + text).slice(-LIVE_TAIL_CHARS));
    const pending = this.liveBuffer.get(id);
    if (pending && pending.stage !== stage) {
      // Never batch the end of one stage with the start of the next.
      this.emitLive(id, pending);
      this.liveBuffer.delete(id);
    }
    const buf = this.liveBuffer.get(id) ?? { stage, start, text: "" };
    buf.text += text;
    this.liveBuffer.set(id, buf);
    if (!this.liveTimer) {
      this.liveTimer = setTimeout(() => {
        this.liveTimer = null;
        for (const [key, b] of this.liveBuffer) this.emitLive(key, b);
        this.liveBuffer.clear();
      }, LIVE_FLUSH_MS);
    }
  }

  private async taskSnapshot(task: TaskRecord): Promise<TaskSnapshot> {
    const status = deriveStatus(task.stage);
    const isRunning = this.workers.has(task.id);
    const deps = await this.dependencyState(task);
    let queueState: QueueState;
    if (isRunning) queueState = "running";
    else if (task.lastError) queueState = "error";
    else if (isWaitingForHuman(task)) queueState = "waiting_you";
    else if (task.stage === "done") queueState = "done";
    else if (task.stage === "rejected") queueState = "rejected";
    else if (deps.state === "blocked") queueState = "blocked";
    else if (deps.state === "waiting") queueState = "waiting_deps";
    else queueState = "queued";

    return {
      id: task.id,
      title: task.context.title,
      stage: task.stage,
      label: status.label,
      // A planned task "sits at" architecture before it has started; don't color it as if it were planning.
      colorClass: queueState === "queued" || queueState === "waiting_deps" || queueState === "blocked" ? "gray" : status.colorClass,
      progress: status.progress,
      queueState,
      waitingForYou: isWaitingForHuman(task) && !isRunning,
      checkpointBrief: task.stage === "checkpoint_idea" ? task.context.ideaBrief : undefined,
      lastFeedback: task.context.reviewFeedback?.length ? task.context.reviewFeedback.join("\n").slice(0, 1500) : undefined,
      lastError: task.lastError ? `${task.lastError.stage}: ${task.lastError.message}`.slice(0, 1500) : undefined,
      logs: task.history.slice(-4).map((h) => ({ at: hhmm(h.at), text: h.summary })),
      acceptanceCriteria: task.context.acceptanceCriteria ?? [],
      deps: { total: deps.total, ready: deps.handoffs.length, waitingOn: deps.waitingOn, blockedBy: deps.blockedBy },
      activity: this.currentActivity(task.id),
      stageStartedAt: isRunning ? task.stageStartedAt : undefined,
      liveTail: this.liveTail.get(task.id) ?? "",
      liveTotal: this.liveTotal.get(task.id) ?? 0,
      planRef: task.planRef,
      handedOff: Boolean(task.handoff),
    };
  }
}
