import { EventEmitter } from "node:events";
import type { HandoffArtifact, ProjectConfig, Stage, StageRun, TaskRecord } from "../types.js";
import { Semaphore } from "./semaphore.js";
import { limitAgent, type CallRecord, type EngineName, type Price } from "../agents/limited.js";
import {
  advance,
  applyImplementation,
  createTask,
  draftImplementation,
  isTerminal,
  isWaitingForHuman,
  log,
  requestRevision,
  resolveCheckpoint,
  retryFromRejected,
  trace,
  type Agents,
  type PipelineConfig,
} from "./pipeline.js";
import { buildHandoff, reachedHandoffPoint, type HandoffPoint } from "./handoff.js";
import { execFile } from "node:child_process";
import { hhmm as clockTime, quotaResumeAt } from "./quota.js";
import { formatSurvey, surveyProject } from "../verify/survey.js";
import { commitTaskFiles, discardTaskFiles, ensureProjectRepo, isGitRepo, type GithubOps } from "../verify/gitProject.js";
import type { Notifier } from "../dashboard/notify.js";
import path from "node:path";
import {
  allPlanCommands,
  commandWarnings,
  draftAndReviewPlan,
  materializePlan,
  newPlanId,
  newProjectDir,
  projectDirWarnings,
  type Department,
  type PlanLimits,
  type WorkPlan,
  type WorkPlanRecord,
} from "./planner.js";
import { parseFileBlocks } from "../apply/applyFiles.js";
import { buildRebalancePrompt, parseRebalance, type LoadSlot, type RebalanceProposal } from "./rebalance.js";
import { listAllTasks, loadTask, saveTask, taskExists } from "../store/taskStore.js";
import { loadPlan, savePlan } from "../store/planStore.js";
import { appendCall, readCalls } from "../store/callLogStore.js";
import { ROLES, TEAMS, roleById, teamById, type ModelTier, type RoleCheck, type TeamId } from "../org/roles.js";
import { formatGuidance, loadPlaybook } from "../org/playbooks.js";
import { acceptedLessons, addLesson, decideLesson, loadLessons, proposeLessonFrom, type Lesson } from "../org/lessons.js";
import { SLOTS, TIER_LABELS, deriveStatus, loadDashboardState, saveDashboardState, type DashboardState, type Directive } from "../dashboard/slots.js";

export interface SchedulerSettings {
  claudeConcurrency: number;
  geminiConcurrency: number;
  /** How many Muse accounts (browser profiles) can chat at once — 1 unless a pool is configured. */
  museConcurrency?: number;
  /** Tasks one slot may have in progress at once, unless overridden per slot. */
  defaultSlotParallel: number;
  slotParallel: Record<string, number>;
  /** Automatic retries of a stage that threw (network, CLI crash, ...) before pausing the task. */
  stageErrorRetries: number;
  stageErrorBackoffMs: number[];
  /** Where non-gated slots hand off; gated slots always wait for the CEO ("done"). */
  handoffOn: HandoffPoint;
  planMaxRounds: number;
  /** Claude model for drafting plans and rebalance proposals (CLAUDE_MODEL_PLAN); unset = the agent's own. */
  planModel?: string;
  planLimits: PlanLimits;
  /** Only used when a provider doesn't report its own cost. */
  prices?: Partial<Record<"claude" | "gemini", Price>>;
}

export interface CompanyOptions {
  agents: Agents;
  pipeline: PipelineConfig;
  settings: SchedulerSettings;
  projectConfig?: () => ProjectConfig | undefined;
  /** Desktop notifications for the CEO (checkpoints, errors, finished plans). */
  notify?: Notifier;
  /** PROJECTS_ROOT: a plan given no directory gets its own new folder here, named after its goal. */
  projectsRoot?: string;
  /** Creates each project's own GitHub repository and pushes approved tasks (undefined = GitHub off). */
  github?: GithubOps;
}

export interface Activity {
  engine: EngineName;
  state: "waiting" | "running";
  since: string;
}

export type QueueState = "running" | "waiting_you" | "error" | "rejected" | "blocked" | "waiting_deps" | "queued" | "done";
export type SlotStateKind = "running" | "needs_review" | "blocked" | "waiting_input" | "ready" | "paused" | "done" | "idle";

export interface RunSummary {
  stage: Stage;
  durationMs: number;
  waitMs: number;
  tokens: number;
  costUsd: number;
  estimated: boolean;
  outcome?: StageRun["outcome"];
}

export interface TaskSnapshot {
  id: string;
  title: string;
  stage: Stage;
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
  /** Slots this task takes input from / delivers to, for the handoff badges and arrows. */
  inputsFrom: { slotId: string; title: string; handedOff: boolean }[];
  outputsTo: { slotId: string; title: string }[];
  activity: Activity | null;
  stageStartedAt?: string;
  liveTail: string;
  liveTotal: number;
  planRef?: TaskRecord["planRef"];
  handedOff: boolean;
  gated: boolean;
  lastRun: RunSummary | null;
  totals: { tokens: number; costUsd: number; activeMs: number; runs: number };
  redoPending: boolean;
  /** Where this task stands in an engine's queue right now, if it is waiting for one. */
  engineQueue: { engine: EngineName; state: "waiting" | "running"; position: number; of: number } | null;
  /** The latest verification result and review verdicts — what the CEO weighs at the final checkpoint. */
  review: { verification: "passed" | "failed" | null; gemini: string | null; geminiStandIn: boolean; claude: string | null };
  /** When the task started waiting for the CEO, if it is. */
  waitingSince?: string;
  assignedBy?: string;
  /** How many Claude↔Gemini architecture rounds and review rejections this task has gone through so far. */
  architectureRounds: number;
  reviewRejections: number;
  /** Warnings for the CEO; "warn" ones make shipping ask for a second confirmation. */
  alerts: { level: "warn" | "info"; text: string }[];
}

export interface SlotSnapshot {
  id: string;
  name: string;
  icon: string;
  tier: 1 | 2 | 3;
  tierLabel: string;
  /** The team this role belongs to, its display name, and the role's specialty. */
  team: TeamId;
  teamName: string;
  summary: string;
  modelTier: ModelTier;
  checks: RoleCheck[];
  isBoss: boolean;
  parallel: number;
  gated: boolean;
  state: { kind: SlotStateKind; label: string; detail?: string };
  counts: { running: number; queued: number; waitingYou: number; done: number; problems: number };
  /** Unfinished tasks after the one shown. */
  queueRemaining: number;
  directives: Directive[];
  inFrom: string[];
  outTo: string[];
  tasks: TaskSnapshot[];
}

export interface EngineQueueEntry {
  id: string;
  label: string;
  slotId?: string;
  since?: string;
}

export type EngineSnapshot = Record<EngineName, { limit: number; running: number; waiting: number; queue: { running: EngineQueueEntry[]; waiting: EngineQueueEntry[] } }>;

export interface Telemetry {
  paused: boolean;
  runStartedAt: string | null;
  runEndedAt: string | null;
  percent: number;
  counts: { total: number; running: number; queued: number; waitingYou: number; errors: number; done: number };
  tokens: { input: number; output: number };
  byEngine: Record<string, { input: number; output: number; costUsd: number }>;
  costUsd: number;
  costPartial: boolean;
  tokensEstimated: boolean;
}

export interface RoleScore {
  slotId: string;
  tasks: number;
  done: number;
  rejected: number;
  /** Shipped without a review rejection, a failed verification or a CEO send-back. */
  firstPass: number;
  archRejects: number;
  reviewRejects: number;
  verifyFails: number;
  ceoSendBacks: number;
  roleCheckFails: number;
  tokens: number;
  costUsd: number;
  activeMs: number;
}

function emptyScore(slotId: string): RoleScore {
  return { slotId, tasks: 0, done: 0, rejected: 0, firstPass: 0, archRejects: 0, reviewRejects: 0, verifyFails: 0, ceoSendBacks: 0, roleCheckFails: 0, tokens: 0, costUsd: 0, activeMs: 0 };
}

export interface Insights {
  handoffs: { at: string; from: string; to: string[]; title: string }[];
  waits: { slotId: string; title: string; waitingOn: string[]; sinceMs: number }[];
  alerts: { level: "error" | "warn" | "info"; text: string }[];
}

export interface ArtifactInfo {
  id: string;
  taskId: string;
  slotId?: string;
  taskTitle: string;
  kind: "brief" | "spec" | "file" | "verification";
  path?: string;
  title: string;
  size: number;
  updatedAt: string;
}

interface Worker {
  slotId: string;
  cancelled: boolean;
}

interface DependencyState {
  state: "ready" | "waiting" | "blocked";
  handoffs: HandoffArtifact[];
  waitingOn: string[];
  waitingOnSlots: string[];
  blockedBy?: string;
  total: number;
}

type Index = Map<string, TaskRecord>;

const DEPARTMENTS: Department[] = ROLES.map((r) => ({ id: r.id, name: r.name, tier: r.tier, team: teamById(r.team)?.name, teamMission: teamById(r.team)?.mission, summary: r.summary }));
const BOSS_ID = SLOTS.find((s) => s.tier === 1)!.id;
const LIVE_TAIL_CHARS = 2000;
const LIVE_FLUSH_MS = 250;
const DONE_SHOWN_PER_SLOT = 5;
const ATTACHMENT_CHARS = 30000;
const QUEUE_ORDER: QueueState[] = ["running", "waiting_you", "error", "blocked", "waiting_deps", "queued", "rejected", "done"];
const LATE_STAGES: Stage[] = ["architecture_review", "implementation", "verification", "review_gemini", "review_claude", "checkpoint_final"];
const LONG_STAGE_MS = 15 * 60 * 1000;
const LONG_REVIEW_WAIT_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const ms = (from?: string, to?: string) => (from ? (to ? Date.parse(to) : Date.now()) - Date.parse(from) : 0);
const minutes = (msValue: number) => Math.max(1, Math.round(msValue / 60000));

export class UserError extends Error {}

/**
 * Runs the company: per-slot task queues with a per-slot parallelism cap,
 * per-engine concurrency limits (Claude, Gemini, Muse — Muse is always 1,
 * it's one browser), a lock on the shared project directory for the
 * write-then-verify step, dependency-ordered handoffs between tasks,
 * approval gates, CEO steering, automatic retries, pause/resume/stop, and
 * the boss's plan. Records every stage attempt and agent call, so the
 * dashboard can show timelines, tokens/cost and full prompts. Emits "slot"
 * (slotId), "plan", "engines", "control" and "live" events.
 *
 * Planning, architecture and reviews (Claude/Gemini) for different tasks run
 * in parallel; implementation+verification is serialized across tasks
 * because they all write into, and build, the same VERIFY_CWD.
 */
/** Red warnings on a result waiting for final approval — shipping it needs an explicit second confirmation. */
export function shipWarnings(task: TaskRecord): string[] {
  if (task.stage !== "checkpoint_final") return [];
  return (task.alerts ?? []).filter((a) => a.level === "warn").map((a) => a.text);
}

function directiveApplies(d: Directive, task: TaskRecord): boolean {
  return !d.planId || d.planId === task.planRef?.planId;
}

export class Company extends EventEmitter {
  readonly engines: Record<EngineName, Semaphore>;
  private readonly agents: Agents;
  private readonly rawAgents: Agents;
  private readonly pipeline: PipelineConfig;
  private readonly settings: SchedulerSettings;
  private readonly projectConfig: () => ProjectConfig | undefined;
  private readonly notify: Notifier;
  private readonly projectsRoot?: string;
  private readonly github?: GithubOps;
  private githubAvailable = false;
  private state: DashboardState = { slots: {}, activePlanId: null, gates: {}, directives: [], paused: false };
  private readonly workers = new Map<string, Worker>();
  /** In-memory task objects for running workers — the source of truth while they run. */
  private readonly running = new Map<string, TaskRecord>();
  private readonly activity = new Map<string, Activity[]>();
  private readonly currentRun = new Map<string, StageRun>();
  private readonly controllers = new Map<string, AbortController>();
  private planController: AbortController | null = null;
  private rebalanceController: AbortController | null = null;
  private rebalance: RebalanceProposal | null = null;
  private readonly planUsage = new Map<string, { input: number; output: number; costUsd: number }>();
  private pauseWaiters: (() => void)[] = [];
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
    this.notify = opts.notify ?? (() => {});
    this.projectsRoot = opts.projectsRoot;
    this.github = opts.github;
    void opts.github?.available().then((ok) => (this.githubAvailable = ok));
    this.engines = {
      claude: new Semaphore(opts.settings.claudeConcurrency),
      gemini: new Semaphore(opts.settings.geminiConcurrency),
      muse: new Semaphore(Math.max(1, opts.settings.museConcurrency ?? 1)),
      workspace: new Semaphore(1),
    };
    const hooks = {
      onWait: (id: string, engine: EngineName) => this.pushActivity(id, engine, "waiting"),
      onStart: (id: string, engine: EngineName) => this.markRunning(id, engine),
      onEnd: (id: string, engine: EngineName) => this.popActivity(id, engine),
      onCall: (rec: CallRecord) => this.recordCall(rec),
    };
    const prices = opts.settings.prices ?? {};
    this.agents = {
      claude: limitAgent(opts.agents.claude, this.engines.claude, "claude", hooks, prices.claude),
      gemini: limitAgent(opts.agents.gemini, this.engines.gemini, "gemini", hooks, prices.gemini),
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
    // A task whose stage was in flight when the process died has an open run; close it.
    for (const ids of Object.values(this.state.slots)) {
      for (const id of ids) {
        const t = await this.load(id);
        // A usage-limit pause survives a restart: re-arm its automatic resume.
        if (t?.lastError?.resumeAt) this.scheduleQuotaResume(t.id, new Date(t.lastError.resumeAt));
        const open = t?.runs?.filter((r) => !r.endedAt && !(r.human && isWaitingForHuman(t))) ?? [];
        if (t && open.length) {
          for (const r of open) Object.assign(r, { endedAt: t.updatedAt, outcome: "cancelled" });
          await saveTask(t);
        }
      }
    }
    this.pump();
  }

  async close(): Promise<void> {
    for (const w of this.workers.values()) w.cancelled = true;
    for (const c of this.controllers.values()) c.abort();
    this.planController?.abort();
    this.releasePauseWaiters();
    await Promise.all(Object.values(this.rawAgents).map((a) => a.close?.().catch(() => {})));
  }

  // ---------- run control ----------

  /** Let calls already in flight finish, start nothing new. */
  async pause(): Promise<void> {
    await this.mutateState((s) => (s.paused = true));
    this.emitControl();
  }

  async resume(): Promise<void> {
    await this.mutateState((s) => (s.paused = false));
    this.releasePauseWaiters();
    this.emitControl();
    this.pump();
  }

  /** Abort every call in flight now (the CLI process is killed, HTTP requests cancelled) and pause. Resume restarts the interrupted stages. */
  async stop(): Promise<void> {
    await this.mutateState((s) => (s.paused = true));
    for (const c of this.controllers.values()) c.abort();
    this.planController?.abort();
    this.rebalanceController?.abort();
    this.emitControl();
  }

  private releasePauseWaiters(): void {
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const w of waiters) w();
  }

  private async waitIfPaused(w: Worker): Promise<void> {
    while (this.state.paused && !w.cancelled) {
      await new Promise<void>((r) => this.pauseWaiters.push(r));
    }
  }

  // ---------- commands ----------

  /** A goal adds a new task to the slot's queue; no goal resumes the slot's paused (errored) tasks. */
  async runSlot(slotId: string, goal?: string): Promise<void> {
    this.requireSlot(slotId);
    const text = goal?.trim();
    if (text) {
      const task = createTask(text, this.projectConfig());
      task.slotId = slotId;
      trace(task, "CEO", "assign", `Created directly for ${slotId} by the CEO.`);
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

  /** approve / reject (redesign from ideation) / revise (back to implementation with the CEO's change request). */
  async decide(
    taskId: string,
    action: boolean | "approve" | "reject" | "revise",
    feedback?: string,
    opts: { confirmWarnings?: boolean } = {},
  ): Promise<void> {
    const act = action === true ? "approve" : action === false ? "reject" : action;
    if (this.workers.has(taskId)) throw new UserError("Task đang chạy.");
    const task = await this.load(taskId);
    if (!task) throw new UserError(`Không tìm thấy task ${taskId}.`);
    if (!isWaitingForHuman(task)) throw new UserError(`Task không ở điểm chờ duyệt (stage: ${task.stage}).`);
    const warnings = shipWarnings(task);
    if (act === "approve" && warnings.length && !opts.confirmWarnings) {
      throw new UserError(`Task có ${warnings.length} cảnh báo đỏ — xem và xác nhận trước khi ship:\n- ${warnings.join("\n- ")}`);
    }
    const hadHandoff = Boolean(task.handoff);
    const gated = this.isGated(task);

    const wait = [...(task.runs ?? [])].reverse().find((r) => r.human && !r.endedAt);
    if (wait) Object.assign(wait, { endedAt: nowIso(), outcome: "ok", decision: act });
    const finalCheckpoint = task.stage === "checkpoint_final";
    if (act === "revise") requestRevision(task, feedback ?? "");
    else resolveCheckpoint(task, act === "approve", feedback?.trim() || undefined);
    if (finalCheckpoint) await this.recordInGit(task, act === "approve");
    if (finalCheckpoint && act === "approve") void this.notifyIfPlanFinished(task).catch(() => {});
    if (finalCheckpoint && act === "approve" && task.stage === "done") {
      // A task that needed corrections leaves its role a lesson for the CEO to review.
      void proposeLessonFrom(task)
        .then((l) => l && this.emit("lessons"))
        .catch(() => {});
    }

    if (act === "approve") {
      if (task.stage === "done") trace(task, "CEO", "gate", gated ? "Approved at the approval gate — result handed off." : "Approved and shipped.");
      if (!task.handoff && reachedHandoffPoint(task.stage, this.handoffPointFor(task))) await this.publishHandoff(task);
    } else if (hadHandoff) {
      task.handoff = undefined;
      await this.warnDependents(task, act === "revise" ? "sent back for a revision" : "sent back for a redesign");
    }
    await saveTask(task);
    this.emitTask(task);
    this.pump();
  }

  /** The CEO approving every task currently waiting at a checkpoint in one go. Returns how many were approved. */
  /** Approves everything waiting — except results with red warnings, which need their own look. */
  async approveAllWaiting(): Promise<number> {
    let approved = 0;
    for (const ids of Object.values(this.state.slots)) {
      for (const id of [...ids]) {
        if (this.workers.has(id)) continue;
        const task = await this.load(id);
        if (task && isWaitingForHuman(task) && !shipWarnings(task).length) {
          await this.decide(id, "approve");
          approved++;
        }
      }
    }
    return approved;
  }

  /** Clears a paused runtime error, or gives a rejected task a fresh budget (keeping its last feedback). */
  /**
   * In a git project, the final decision is recorded there too: an approved
   * task's files become one commit; a rejected or revised task's files go
   * back to the last commit (new ones are deleted), so work the CEO turned
   * down doesn't stay in the project. Not a git repository: nothing happens.
   */
  private gitQueues = new Map<string, Promise<void>>();

  /**
   * One git operation at a time per repository: auto-approved tasks can be
   * decided at the same moment, and two concurrent commits in one repo make
   * git refuse one of them (index.lock) — that task's commit and push would
   * silently be lost.
   */
  private inRepoQueue(dir: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.gitQueues.get(dir) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.gitQueues.set(dir, next.catch(() => {}));
    return next;
  }

  private async recordInGit(task: TaskRecord, approved: boolean): Promise<void> {
    const dir = task.projectConfig?.verifyCwd;
    if (!dir) return;
    return this.inRepoQueue(path.resolve(dir), () => this.recordInGitNow(task, approved, dir));
  }

  private async recordInGitNow(task: TaskRecord, approved: boolean, dir: string): Promise<void> {
    const files = task.context.implementationFiles ?? [];
    if (!files.length || !(await isGitRepo(dir))) return;
    try {
      if (approved) {
        const hash = await commitTaskFiles(dir, files, `${task.context.title}\n\nTask ${task.id}, approved by the CEO in the AI Company dashboard.`);
        log(task, task.stage, "system", hash ? `Committed ${files.length} file(s) to the project's git repository: ${hash}.` : "No file changes to commit to git.");
        if (hash && task.projectConfig?.githubPush && this.github) {
          // A failed push (offline, expired login) never blocks the work; the next approval pushes this commit too.
          try {
            await this.github.push(dir);
            log(task, task.stage, "system", `Pushed ${hash} to the project's GitHub repository.`);
          } catch (err) {
            log(task, task.stage, "system", `Push to GitHub failed (${(err as Error).message.slice(0, 200)}) — the commit is kept locally and goes up with the next push.`);
          }
        }
      } else {
        const { restored, removed } = await discardTaskFiles(dir, files);
        log(
          task,
          task.stage,
          "system",
          `Undid this task's files in the project (git): restored ${restored.length ? restored.join(", ") : "none"}; removed ${removed.length ? removed.join(", ") : "none"}.`,
        );
      }
    } catch (err) {
      log(task, task.stage, "system", `Git ${approved ? "commit" : "undo"} failed (the decision itself stands): ${(err as Error).message.slice(0, 300)}`);
    }
  }

  /**
   * The project's own GitHub repository: created (private) on approval if
   * the plan asks for one and the folder has no origin yet; an existing
   * origin is reused. Failures are noted on the plan, never fatal.
   */
  private async connectGithub(plan: WorkPlanRecord, dir: string): Promise<void> {
    const project = plan.project;
    if (!project?.githubRepo || !this.github) return;
    try {
      const existing = await this.github.remoteUrl(dir);
      if (existing) {
        project.githubUrl = existing;
        await this.github.push(dir).catch(() => {});
        (plan.notes ??= []).push(`GitHub: using the folder's existing repository ${existing}.`);
        return;
      }
      if (!(await this.github.available())) {
        (plan.notes ??= []).push("GitHub: gh is not logged in (run `gh auth login`) — the project keeps its local git only.");
        return;
      }
      project.githubUrl = await this.github.createRepo(dir, plan.goal);
      (plan.notes ??= []).push(`GitHub: created private repository ${project.githubUrl} and pushed the first commit.`);
    } catch (err) {
      (plan.notes ??= []).push(`GitHub: could not create the repository (${(err as Error).message.slice(0, 200)}) — the project keeps its local git only.`);
    }
  }

  private quotaTimers = new Map<string, NodeJS.Timeout>();

  /** Clears a usage-limit pause at its reset time and lets the task run again (if nothing else happened to it meanwhile). */
  private scheduleQuotaResume(taskId: string, at: Date): void {
    clearTimeout(this.quotaTimers.get(taskId));
    const timer = setTimeout(async () => {
      this.quotaTimers.delete(taskId);
      const task = await this.load(taskId);
      if (!task?.lastError?.resumeAt || this.workers.has(taskId)) return;
      task.lastError = undefined;
      log(task, task.stage, "system", "Usage limit reset — resuming automatically.");
      await saveTask(task);
      this.emitTask(task);
      this.pump();
    }, Math.max(0, at.getTime() - Date.now()));
    timer.unref?.();
    this.quotaTimers.set(taskId, timer);
  }

  async retryTask(taskId: string): Promise<void> {
    if (this.workers.has(taskId)) throw new UserError("Task đang chạy.");
    const task = await this.load(taskId);
    if (!task) throw new UserError(`Không tìm thấy task ${taskId}.`);
    if (task.lastError) {
      task.lastError = undefined;
      log(task, task.stage, "ceo", "Retry requested by the CEO.");
    } else if (task.stage === "rejected") {
      retryFromRejected(task);
    } else {
      throw new UserError("Task này không có gì để thử lại.");
    }
    await saveTask(task);
    this.emitTask(task);
    this.pump();
  }

  async setGate(slotId: string, enabled: boolean): Promise<void> {
    this.requireSlot(slotId);
    await this.mutateState((s) => (s.gates[slotId] = enabled));
    this.emit("slot", slotId);
  }

  /**
   * A CEO instruction for one slot (or the whole company when slotId is
   * null). It reaches every agent call of those tasks from the next stage
   * on. With redo, tasks already past architecture go back to it with the
   * instruction as feedback (a task mid-stage does so when that stage ends).
   */
  async steer(slotId: string | null, text: string, redo = false): Promise<Directive> {
    if (slotId) this.requireSlot(slotId);
    const clean = text.trim();
    if (!clean) throw new UserError("Chỉ thị đang trống.");
    const directive: Directive = {
      id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      slotId,
      text: clean,
      at: nowIso(),
      ...(this.state.activePlanId ? { planId: this.state.activePlanId } : {}),
    };
    await this.mutateState((s) => s.directives.push(directive));
    const scope = slotId ? [slotId] : SLOTS.map((s) => s.id);
    for (const sid of scope) {
      for (const id of this.state.slots[sid] ?? []) {
        const task = await this.load(id);
        if (!task || isTerminal(task) || !directiveApplies(directive, task)) continue;
        trace(task, "CEO", "directive", `${slotId ? "" : "Company-wide: "}${clean}${redo ? " (redo requested)" : ""}`);
        if (redo) {
          if (this.workers.has(id)) task.redoRequested = clean;
          else await this.redo(task, clean);
        }
        if (!this.workers.has(id)) await saveTask(task);
      }
      this.emit("slot", sid);
    }
    this.emitControl();
    this.pump();
    return directive;
  }

  async removeDirective(id: string): Promise<void> {
    const d = this.state.directives.find((x) => x.id === id);
    await this.mutateState((s) => (s.directives = s.directives.filter((x) => x.id !== id)));
    if (d?.slotId) this.emit("slot", d.slotId);
    else for (const s of SLOTS) this.emit("slot", s.id);
    this.emitControl();
  }

  /** Reassign a task to another slot and/or move it to the top or bottom of that slot's queue. */
  async moveTask(taskId: string, toSlot: string, position: "top" | "bottom" = "bottom", decided?: { by: string; reason: string }): Promise<void> {
    this.requireSlot(toSlot);
    if (this.workers.has(taskId)) throw new UserError("Task đang chạy — chờ xong bước hiện tại (hoặc bấm Pause) rồi gán lại.");
    const task = await this.load(taskId);
    if (!task) throw new UserError(`Không tìm thấy task ${taskId}.`);
    if (task.stage === "done") throw new UserError("Task đã xong, không cần gán lại.");
    const from = this.slotOf(taskId) ?? task.slotId;
    await this.mutateState((s) => {
      for (const ids of Object.values(s.slots)) {
        const i = ids.indexOf(taskId);
        if (i !== -1) ids.splice(i, 1);
      }
      if (position === "top") s.slots[toSlot].unshift(taskId);
      else s.slots[toSlot].push(taskId);
    });
    task.slotId = toSlot;
    if (from === toSlot) {
      trace(task, decided?.by ?? "CEO", "priority", `${position === "top" ? "Moved to the front of the queue." : "Moved to the back of the queue."}${decided ? ` Reason: ${decided.reason}` : ""}`);
    } else {
      trace(task, decided?.by ?? "CEO", "reassign", `Reassigned from ${from ?? "?"} to ${toSlot}.${decided ? ` Reason: ${decided.reason}` : ""}`);
      log(task, task.stage, "ceo", `Reassigned from ${from ?? "?"} to ${toSlot}.`);
      await this.updatePlanOwner(task, toSlot);
    }
    await saveTask(task);
    if (from) this.emit("slot", from);
    this.emit("slot", toSlot);
    this.pump();
  }

  /** Forward one agent's output to another slot as input material. Creates a task there if it has nothing unfinished. */
  async sendArtifact(src: { taskId: string; kind: ArtifactInfo["kind"]; path?: string }, toSlot: string, note?: string): Promise<{ taskId: string; created: boolean }> {
    this.requireSlot(toSlot);
    const art = await this.artifactContent(src.taskId, src.kind, src.path);
    const source = await this.load(src.taskId);
    const fromSlot = source?.slotId ?? this.slotOf(src.taskId) ?? "?";
    let target: TaskRecord | undefined;
    for (const id of this.state.slots[toSlot]) {
      const t = await this.load(id);
      if (t && !isTerminal(t)) {
        target = t;
        break;
      }
    }
    let created = false;
    if (!target) {
      target = createTask(note?.trim() || `Tiếp nhận "${art.title}" từ ${fromSlot} và xử lý tiếp`, this.projectConfig());
      target.slotId = toSlot;
      created = true;
      await this.mutateState((s) => s.slots[toSlot].push(target!.id));
    }
    const content = `${note?.trim() ? `CEO note: ${note.trim()}\n\n` : ""}${art.content}`.slice(0, ATTACHMENT_CHARS);
    (target.context.attachments ??= []).push({ title: art.title, from: `${fromSlot} · ${source?.context.title ?? src.taskId}`, content });
    trace(target, "CEO", "input", `Forwarded "${art.title}" from ${fromSlot}${note?.trim() ? `: ${note.trim()}` : ""}.`);
    if (!this.workers.has(target.id)) await saveTask(target);
    this.emit("slot", toSlot);
    this.pump();
    return { taskId: target.id, created };
  }

  async startPlan(
    goal: string,
    projectDir?: string,
    options: { autoApprove?: boolean; skipClaudeReviewWhenGreen?: boolean; githubRepo?: boolean } = {},
  ): Promise<WorkPlanRecord> {
    const current = await this.activePlan();
    if (current && (current.status === "drafting" || current.status === "awaiting_approval")) {
      throw new UserError("Đang có một kế hoạch đang lập hoặc chờ duyệt — hãy quyết kế hoạch đó trước.");
    }
    // No directory given: with PROJECTS_ROOT set, every plan gets a folder of
    // its own (never an existing one); otherwise the configured default.
    const dir = projectDir?.trim() || (this.projectsRoot ? await newProjectDir(this.projectsRoot, goal) : this.defaultProjectDir());
    if (dir && !path.isAbsolute(dir)) throw new UserError(`Thư mục dự án phải là đường dẫn tuyệt đối (bắt đầu bằng /): "${dir}".`);
    const now = nowIso();
    const plan: WorkPlanRecord = {
      id: newPlanId(),
      goal: goal.trim(),
      status: "drafting",
      createdAt: now,
      updatedAt: now,
      project: { dir, verifyCommands: [], warnings: dir ? await projectDirWarnings(dir) : ["Chưa chọn thư mục dự án."] },
    };
    plan.project!.handoffOn = await this.defaultHandoffFor(dir);
    plan.project!.autoApprove = options.autoApprove === true;
    plan.project!.skipClaudeReviewWhenGreen = options.skipClaudeReviewWhenGreen === true;
    plan.project!.githubRepo = options.githubRepo === true && Boolean(this.github);
    await savePlan(plan);
    await this.mutateState((s) => (s.activePlanId = plan.id));
    this.emitPlan();
    void this.generatePlan(plan);
    return plan;
  }

  /** What's already in the plan's project directory, for the planner — undefined for a new/empty one. */
  private async projectSurvey(plan: WorkPlanRecord): Promise<string | undefined> {
    const dir = plan.project?.dir;
    if (!dir) return undefined;
    try {
      const survey = await surveyProject(dir);
      return survey && formatSurvey(survey);
    } catch {
      return undefined;
    }
  }

  private environmentCache: Promise<string | undefined> | null = null;

  /** Installed iOS simulators, so the plan can name a real one in its build commands (undefined off macOS). */
  private machineEnvironment(): Promise<string | undefined> {
    this.environmentCache ??= new Promise((resolve) => {
      execFile("xcrun", ["simctl", "list", "devices", "available", "-j"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(undefined);
        try {
          const devices = Object.entries(JSON.parse(stdout).devices as Record<string, { name: string }[]>)
            .filter(([runtime]) => /iOS/.test(runtime))
            .flatMap(([, list]) => list.map((d) => d.name))
            .filter((n) => /^iPhone/.test(n));
          resolve(devices.length ? `installed iOS simulators: ${[...new Set(devices)].join(", ")}.` : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    return this.environmentCache;
  }

  /** "done" when the directory already holds a project (a repair), else the company setting. */
  private async defaultHandoffFor(dir: string): Promise<"checkpoint_final" | "done"> {
    const warnings = dir ? await projectDirWarnings(dir) : [];
    return warnings.some((w) => /đã có \d+ mục/.test(w)) ? "done" : this.settings.handoffOn;
  }

  private defaultProjectDir(): string {
    return this.projectConfig()?.verifyCwd || this.pipeline.verify.cwd || "";
  }

  /** The CEO sets or corrects where the plan's code lives and how it's verified, before approving. */
  async updatePlanProject(
    planId: string,
    update: {
      dir?: string;
      verifyCommands?: string[];
      handoffOn?: "checkpoint_final" | "done";
      autoApprove?: boolean;
      skipClaudeReviewWhenGreen?: boolean;
      githubRepo?: boolean;
    },
  ): Promise<WorkPlanRecord> {
    const plan = await loadPlan(planId);
    if (!plan || (plan.status !== "awaiting_approval" && plan.status !== "drafting")) {
      throw new UserError("Chỉ sửa được thư mục / lệnh kiểm tra khi kế hoạch đang lập hoặc chờ duyệt.");
    }
    const project = plan.project ?? { dir: "", verifyCommands: [], warnings: [] };
    if (update.dir !== undefined) {
      const dir = update.dir.trim();
      if (!path.isAbsolute(dir)) throw new UserError(`Thư mục dự án phải là đường dẫn tuyệt đối (bắt đầu bằng /): "${dir}".`);
      project.dir = dir;
      project.warnings = await projectDirWarnings(dir);
    }
    if (update.verifyCommands !== undefined) {
      project.verifyCommands = update.verifyCommands.map((c) => c.trim()).filter(Boolean);
      project.commandsByCeo = true;
    }
    if (update.handoffOn === "done" || update.handoffOn === "checkpoint_final") project.handoffOn = update.handoffOn;
    if (typeof update.autoApprove === "boolean") project.autoApprove = update.autoApprove;
    if (typeof update.skipClaudeReviewWhenGreen === "boolean") project.skipClaudeReviewWhenGreen = update.skipClaudeReviewWhenGreen;
    if (typeof update.githubRepo === "boolean") project.githubRepo = update.githubRepo && Boolean(this.github);
    project.commandWarnings = commandWarnings(allPlanCommands(project.verifyCommands, plan.epics));
    plan.project = project;
    plan.updatedAt = nowIso();
    await savePlan(plan);
    this.emitPlan();
    return plan;
  }

  async decidePlan(
    planId: string,
    approved: boolean,
    feedback?: string,
    project?: {
      dir?: string;
      verifyCommands?: string[];
      handoffOn?: "checkpoint_final" | "done";
      autoApprove?: boolean;
      skipClaudeReviewWhenGreen?: boolean;
      githubRepo?: boolean;
    },
  ): Promise<void> {
    if (project && Object.values(project).some((v) => v !== undefined)) {
      await this.updatePlanProject(planId, project);
    }
    const plan = await loadPlan(planId);
    if (!plan || plan.status !== "awaiting_approval") throw new UserError("Kế hoạch không ở trạng thái chờ duyệt.");
    if (approved) {
      const dir = plan.project?.dir ?? "";
      const commands = plan.project?.verifyCommands ?? [];
      if (!dir) throw new UserError("Kế hoạch chưa có thư mục dự án — điền thư mục rồi mới duyệt.");
      if (!commands.length) {
        throw new UserError("Kế hoạch chưa có lệnh kiểm tra (build/test) — điền lệnh rồi mới duyệt, nếu không sẽ không có gì chứng minh code chạy được.");
      }
      // Every project is a git repository before work starts, so each task
      // the CEO approves is its own commit and a rejected one can be undone.
      try {
        const repo = await ensureProjectRepo(dir);
        if (repo) {
          (plan.notes ??= []).push(
            `Project: ${repo.created ? "created" : "existing folder put under git"} at ${dir} (git init, first commit ${repo.commit}).`,
          );
        }
      } catch (err) {
        (plan.notes ??= []).push(`Project: could not set up git in ${dir} (${(err as Error).message.slice(0, 200)}) — tasks run without per-task commits.`);
      }
      await this.connectGithub(plan, dir);
      const base = this.projectConfig();
      const tasks = materializePlan(plan, { ...base, verifyCwd: dir, verifyCommands: commands, handoffOn: plan.project?.handoffOn, autoApprove: plan.project?.autoApprove === true,
        skipClaudeReviewWhenGreen: plan.project?.skipClaudeReviewWhenGreen === true,
        githubPush: Boolean(plan.project?.githubUrl),
      });
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
    if (!plan || plan.status !== "failed") throw new UserError("Kế hoạch này không ở trạng thái lỗi.");
    plan.status = "drafting";
    plan.error = undefined;
    await savePlan(plan);
    this.emitPlan();
    void this.generatePlan(plan, plan.revisionFeedback ? { feedback: plan.revisionFeedback } : undefined);
  }

  /**
   * The boss (Claude) looks at every slot's load and unfinished tasks and
   * proposes reassignments / reprioritizations, each with a reason. Nothing
   * moves until the CEO applies (some of) them.
   */
  async proposeRebalance(): Promise<RebalanceProposal> {
    if (this.rebalance?.status === "drafting") throw new UserError("Sếp đang soạn đề xuất cân tải — chờ xong đã.");
    const load = await this.loadSnapshot();
    const proposal: RebalanceProposal = { id: `rb-${Date.now()}`, status: "drafting", createdAt: nowIso(), summary: "", moves: [], notes: [] };
    this.rebalance = proposal;
    if (!load.some((s) => s.tasks.some((t) => t.movable))) {
      Object.assign(proposal, { status: "ready", summary: "Không có task nào đang chờ trong hàng đợi để gán lại." });
      this.emitRebalance();
      return proposal;
    }
    this.emitRebalance();
    void this.draftRebalance(proposal, load);
    return proposal;
  }

  private async draftRebalance(proposal: RebalanceProposal, load: LoadSlot[]): Promise<void> {
    const key = "rebalance";
    this.resetLive(key);
    this.rebalanceController = new AbortController();
    try {
      const res = await this.agents.claude.send(buildRebalancePrompt(load), { title: "Cân tải công việc giữa các nhân sự" }, {
        taskId: key,
        onChunk: (t) => this.onChunk(key, t),
        signal: this.rebalanceController.signal,
        model: this.settings.planModel,
      });
      const parsed = parseRebalance(res.content, load);
      Object.assign(proposal, { status: "ready", summary: parsed.summary, moves: parsed.moves, notes: parsed.notes });
    } catch (err) {
      Object.assign(proposal, {
        status: "failed",
        error: this.rebalanceController.signal.aborted ? "Đã dừng theo lệnh Stop." : (err as Error).message,
      });
    }
    this.rebalanceController = null;
    this.resetLive(key);
    this.emitRebalance();
  }

  /** Applies the chosen moves (indexes into the proposal); a move that no longer applies is skipped and noted. */
  async applyRebalance(proposalId: string, indexes?: number[]): Promise<{ applied: number; skipped: number }> {
    const p = this.rebalance;
    if (!p || p.id !== proposalId || p.status !== "ready") throw new UserError("Đề xuất này không còn hiệu lực.");
    const chosen = (indexes ?? p.moves.map((_, i) => i)).filter((i) => Number.isInteger(i) && p.moves[i]);
    let applied = 0;
    for (const i of chosen) {
      const m = p.moves[i];
      try {
        await this.moveTask(m.taskId, m.to, m.position, { by: "AG-01 (Claude) · CEO duyệt", reason: m.reason });
        applied++;
      } catch (err) {
        p.notes.push(`Không áp dụng được "${m.title}": ${(err as Error).message}`);
      }
    }
    Object.assign(p, { status: "applied", applied });
    this.emitRebalance();
    return { applied, skipped: chosen.length - applied };
  }

  dismissRebalance(): void {
    if (this.rebalance) this.rebalance.status = "dismissed";
    this.emitRebalance();
  }

  rebalanceSnapshot() {
    const p = this.rebalance;
    if (!p || p.status === "dismissed") return null;
    return { ...p, activity: this.currentActivity("rebalance"), liveTail: this.liveTail.get("rebalance") ?? "", liveTotal: this.liveTotal.get("rebalance") ?? 0 };
  }

  /** Every slot's load and unfinished tasks, as the boss sees them when rebalancing. */
  private async loadSnapshot(): Promise<LoadSlot[]> {
    const idx = await this.index();
    const dependents = this.dependentsIndex(idx);
    const out: LoadSlot[] = [];
    for (const slot of SLOTS) {
      const snap = await this.slotSnapshot(slot.id, idx);
      out.push({
        id: slot.id,
        name: slot.name,
        tier: slot.tier,
        team: teamById(slot.team)?.name,
        parallel: snap.parallel,
        running: snap.counts.running,
        queued: snap.counts.queued,
        waitingYou: snap.counts.waitingYou,
        tasks: snap.tasks
          .filter((t) => t.queueState !== "done")
          .map((t) => {
            const task = idx.get(t.id);
            return {
              id: t.id,
              title: t.title,
              stage: t.stage,
              queueState: t.queueState,
              brief: (task?.context.ideaBrief ?? "").slice(0, 400),
              waitingOn: t.inputsFrom.filter((i) => !i.handedOff).map((i) => i.slotId),
              unblocks: [...new Set((dependents.get(t.id) ?? []).map((d) => d.slotId ?? "?"))],
              movable: t.queueState !== "running" && t.queueState !== "waiting_you",
            };
          }),
      });
    }
    return out;
  }

  private emitRebalance(): void {
    this.emit("rebalance");
  }

  /** Un-assigns every task (task files stay in data/tasks) and stops running workers after their current stage. */
  async reset(): Promise<void> {
    for (const w of this.workers.values()) w.cancelled = true;
    this.releasePauseWaiters();
    const plan = await this.activePlan();
    if (plan && (plan.status === "drafting" || plan.status === "awaiting_approval")) {
      plan.status = "discarded";
      await savePlan(plan);
    }
    await this.mutateState((s) => {
      for (const slot of SLOTS) s.slots[slot.id] = [];
      s.activePlanId = null;
      s.directives = [];
    });
    for (const slot of SLOTS) this.emit("slot", slot.id);
    this.emitPlan();
    this.emitControl();
  }

  // ---------- read models ----------

  engineSnapshot(): EngineSnapshot {
    const snap = {} as EngineSnapshot;
    for (const [name, sem] of Object.entries(this.engines) as [EngineName, Semaphore][]) {
      const entry = (id: string, state: Activity["state"]): EngineQueueEntry => {
        const act = this.activity.get(id)?.find((a) => a.engine === name && a.state === state);
        if (id.startsWith("plan:")) return { id, label: "Kế hoạch của Sếp", slotId: BOSS_ID, since: act?.since };
        if (id === "rebalance") return { id, label: "Đề xuất cân tải", slotId: BOSS_ID, since: act?.since };
        const t = this.running.get(id);
        return { id, label: t?.context.title ?? id, slotId: t?.slotId ?? this.slotOf(id), since: act?.since };
      };
      snap[name] = {
        limit: sem.limit,
        running: sem.running,
        waiting: sem.waiting,
        queue: { running: sem.runningKeys().map((k) => entry(k, "running")), waiting: sem.waitingKeys().map((k) => entry(k, "waiting")) },
      };
    }
    return snap;
  }

  /** Moves a task's pending call to the front of an engine's queue. */
  async promote(engine: EngineName, id: string): Promise<void> {
    const sem = this.engines[engine];
    if (!sem) throw new UserError(`Không có engine ${engine}.`);
    if (!sem.promote(id)) throw new UserError("Lượt này không còn trong hàng đợi (có thể đã được chạy).");
    const task = this.running.get(id);
    if (task) trace(task, "CEO", "priority", `Moved to the front of the ${engine} queue.`);
    this.emit("engines");
    if (task) this.emitTask(task);
  }

  control() {
    return { paused: this.state.paused, directives: this.withStale(this.state.directives.filter((d) => !d.slotId)), gates: this.state.gates };
  }

  async slotSnapshot(slotId: string, index?: Index): Promise<SlotSnapshot> {
    const slot = SLOTS.find((s) => s.id === slotId);
    if (!slot) throw new UserError(`unknown slot ${slotId}`);
    const idx = index ?? (await this.index());
    const all: TaskSnapshot[] = [];
    for (const id of this.state.slots[slotId] ?? []) {
      const task = idx.get(id);
      if (task) all.push(await this.taskSnapshot(task, idx));
    }
    // Stable: keeps the slot's own queue order (priority) within each state.
    all.sort((a, b) => QUEUE_ORDER.indexOf(a.queueState) - QUEUE_ORDER.indexOf(b.queueState));
    const done = all.filter((t) => t.queueState === "done");
    const shown = [...all.filter((t) => t.queueState !== "done"), ...done.slice(-DONE_SHOWN_PER_SLOT).reverse()];
    const count = (...states: QueueState[]) => all.filter((t) => states.includes(t.queueState)).length;
    const unfinished = all.filter((t) => t.queueState !== "done").length;
    return {
      id: slot.id,
      name: slot.name,
      icon: slot.icon,
      tier: slot.tier,
      tierLabel: TIER_LABELS[slot.tier],
      team: slot.team,
      teamName: teamById(slot.team)?.name ?? slot.team,
      summary: roleById(slot.id)?.summary ?? "",
      modelTier: roleById(slot.id)?.modelTier ?? "standard",
      checks: roleById(slot.id)?.checks ?? [],
      isBoss: slot.tier === 1,
      parallel: this.parallelFor(slot.id),
      gated: Boolean(this.state.gates[slot.id]),
      state: this.slotState(all),
      counts: {
        running: count("running"),
        queued: count("queued", "waiting_deps", "blocked"),
        waitingYou: count("waiting_you"),
        done: done.length,
        problems: count("error", "rejected"),
      },
      queueRemaining: Math.max(0, unfinished - 1),
      directives: this.withStale(this.state.directives.filter((d) => d.slotId === slot.id)),
      inFrom: [...new Set(all.flatMap((t) => t.inputsFrom.map((i) => i.slotId)))].filter((s) => s !== slot.id),
      outTo: [...new Set(all.flatMap((t) => t.outputsTo.map((o) => o.slotId)))].filter((s) => s !== slot.id),
      tasks: shown,
    };
  }

  async planSnapshot() {
    const plan = await this.activePlan();
    if (!plan) return null;
    const idx = await this.index();
    const taskStages: Record<string, { stage: string; queueState: QueueState }> = {};
    for (const epic of plan.epics ?? []) {
      for (const id of [epic.taskId, ...epic.subtasks.map((s) => s.taskId)]) {
        const t = id ? idx.get(id) : undefined;
        if (t) taskStages[t.id] = { stage: t.stage, queueState: this.queueStateOf(t, await this.dependencyState(t, idx)) };
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

  async telemetry(index?: Index): Promise<Telemetry> {
    const idx = index ?? (await this.index());
    const tasks = [...idx.values()];
    const t: Telemetry = {
      paused: this.state.paused,
      runStartedAt: null,
      runEndedAt: null,
      percent: 0,
      counts: { total: tasks.length, running: 0, queued: 0, waitingYou: 0, errors: 0, done: 0 },
      tokens: { input: 0, output: 0 },
      byEngine: {},
      costUsd: 0,
      costPartial: false,
      tokensEstimated: false,
    };
    let progress = 0;
    const plan = await this.activePlan();
    const starts = tasks.map((x) => x.createdAt);
    if (plan) starts.push(plan.createdAt);
    t.runStartedAt = starts.length ? starts.sort()[0] : null;
    for (const task of tasks) {
      const qs = this.queueStateOf(task, await this.dependencyState(task, idx));
      if (qs === "running") t.counts.running++;
      else if (qs === "waiting_you") t.counts.waitingYou++;
      else if (qs === "error" || qs === "rejected" || qs === "blocked") t.counts.errors++;
      else if (qs === "done") t.counts.done++;
      else t.counts.queued++;
      progress += isTerminal(task) ? 100 : deriveStatus(task.stage).progress;
      for (const run of task.runs ?? []) this.addUsage(t, run);
    }
    for (const [id, u] of this.planUsage) {
      if (id !== "rebalance" && (!plan || `plan:${plan.id}` !== id)) continue;
      this.addEngineUsage(t, "claude", u.input, u.output, u.costUsd);
    }
    if (plan?.usage && !this.planUsage.has(`plan:${plan.id}`)) this.addEngineUsage(t, "claude", plan.usage.input, plan.usage.output, plan.usage.costUsd);
    t.percent = tasks.length ? Math.round(progress / tasks.length) : 0;
    if (tasks.length && tasks.every(isTerminal)) t.runEndedAt = tasks.map((x) => x.updatedAt).sort().at(-1) ?? null;
    return t;
  }

  async insights(index?: Index): Promise<Insights> {
    const idx = index ?? (await this.index());
    const out: Insights = { handoffs: [], waits: [], alerts: [] };
    const dependents = this.dependentsIndex(idx);
    let waitingYou: TaskRecord[] = [];
    const phaseQueue: Record<string, number> = {};
    for (const task of idx.values()) {
      const deps = await this.dependencyState(task, idx);
      const qs = this.queueStateOf(task, deps);
      const slot = task.slotId ?? this.slotOf(task.id) ?? "?";
      if (task.handoff) {
        out.handoffs.push({
          at: task.handoff.at,
          from: slot,
          to: [...new Set((dependents.get(task.id) ?? []).map((d) => d.slotId ?? "?"))],
          title: task.context.title,
        });
      }
      if (qs === "waiting_deps") out.waits.push({ slotId: slot, title: task.context.title, waitingOn: deps.waitingOnSlots, sinceMs: ms(task.createdAt) });
      if (qs === "waiting_you") waitingYou.push(task);
      if (qs === "error") out.alerts.push({ level: "error", text: `${slot} · ${task.context.title}: lỗi — ${task.lastError?.message.slice(0, 140)}` });
      if (qs === "rejected") out.alerts.push({ level: "error", text: `${slot} · ${task.context.title}: bị từ chối sau khi hết lượt thử` });
      if (qs === "blocked") out.alerts.push({ level: "error", text: `${slot} · ${task.context.title}: bị chặn — ${deps.blockedBy}` });
      if (qs === "running" && ms(task.stageStartedAt) > LONG_STAGE_MS) {
        out.alerts.push({ level: "warn", text: `${slot} chạy ${task.stage} đã ${minutes(ms(task.stageStartedAt))} phút` });
      }
      if (qs === "queued" || qs === "waiting_deps") phaseQueue[workflowPhase(task.stage)] = (phaseQueue[workflowPhase(task.stage)] ?? 0) + 1;
    }
    for (const [name, e] of Object.entries(this.engineSnapshot())) {
      if (e.waiting >= 2) out.alerts.push({ level: "warn", text: `Nghẽn ở ${ENGINE_PHASE[name] ?? name}: ${e.waiting} lượt đang chờ (${e.running}/${e.limit} đang chạy)` });
    }
    if (waitingYou.length) {
      waitingYou = waitingYou.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const oldest = ms(waitingYou[0].updatedAt);
      if (waitingYou.length >= 2 || oldest > LONG_REVIEW_WAIT_MS) {
        out.alerts.push({ level: "warn", text: `Nghẽn ở bạn: ${waitingYou.length} task chờ duyệt (lâu nhất ${minutes(oldest)} phút)` });
      }
    }
    const [busiest] = Object.entries(phaseQueue).sort((a, b) => b[1] - a[1]);
    if (busiest && busiest[1] >= 3) out.alerts.push({ level: "info", text: `Dồn ở khâu ${busiest[0]}: ${busiest[1]} task đang chờ` });
    if (this.state.paused) out.alerts.unshift({ level: "info", text: "Cả công ty đang tạm dừng — bấm Resume để chạy tiếp." });
    out.handoffs.sort((a, b) => b.at.localeCompare(a.at)).splice(8);
    out.waits.sort((a, b) => b.sinceMs - a.sinceMs).splice(8);
    return out;
  }

  /** Every stage attempt on a time axis, one row per slot, plus the dependency chain that determined the finish time. */
  async timeline() {
    const idx = await this.index();
    const rows = SLOTS.map((s) => ({ slotId: s.id, name: s.name, tier: s.tier, tierLabel: TIER_LABELS[s.tier], spans: [] as any[] }));
    let start: string | null = null;
    const finishOf = (t: TaskRecord): number => {
      if (t.handoff) return Date.parse(t.handoff.at);
      const runs = t.runs ?? [];
      if (this.workers.has(t.id) || runs.some((r) => !r.endedAt)) return Date.now();
      const last = runs.at(-1)?.endedAt;
      return last ? Date.parse(last) : 0;
    };
    const startOf = (t: TaskRecord): number => (t.runs?.[0] ? Date.parse(t.runs[0].startedAt) : 0);

    // Critical path: walk back from the task that finished last through the dependency that finished last.
    const withRuns = [...idx.values()].filter((t) => t.runs?.length);
    const chain: TaskRecord[] = [];
    let cur = withRuns.sort((a, b) => finishOf(b) - finishOf(a))[0];
    while (cur) {
      chain.unshift(cur);
      const deps = (cur.dependsOn ?? []).map((id) => idx.get(id)).filter((t): t is TaskRecord => Boolean(t?.runs?.length));
      cur = deps.sort((a, b) => finishOf(b) - finishOf(a))[0];
    }
    const critical = new Set(chain.map((t) => t.id));

    for (const task of idx.values()) {
      const row = rows.find((r) => r.slotId === (task.slotId ?? this.slotOf(task.id)));
      if (!row) continue;
      for (const run of task.runs ?? []) {
        if (!start || run.startedAt < start) start = run.startedAt;
        row.spans.push({
          taskId: task.id,
          title: task.context.title,
          stage: run.stage,
          startedAt: run.startedAt,
          endedAt: run.endedAt ?? null,
          outcome: run.outcome ?? null,
          waitMs: run.waitMs,
          tokens: run.inputTokens + run.outputTokens,
          costUsd: run.costUsd,
          engines: run.engines,
          human: Boolean(run.human),
          decision: run.decision ?? null,
          status: run.human ? "review" : !run.endedAt ? "running" : run.outcome === "error" ? "error" : run.outcome === "cancelled" ? "stopped" : "done",
          critical: critical.has(task.id),
        });
      }
    }
    for (const r of rows) r.spans.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return {
      start,
      now: nowIso(),
      rows,
      criticalPath: chain.length
        ? {
            tasks: chain.map((t) => ({ id: t.id, slotId: t.slotId, title: t.context.title })),
            totalMs: finishOf(chain.at(-1)!) - startOf(chain[0]),
          }
        : null,
    };
  }

  async listArtifacts(onlyTaskId?: string): Promise<ArtifactInfo[]> {
    const out: ArtifactInfo[] = [];
    const idx = await this.index();
    for (const task of idx.values()) {
      if (onlyTaskId && task.id !== onlyTaskId) continue;
      const base = { taskId: task.id, slotId: task.slotId ?? this.slotOf(task.id), taskTitle: task.context.title, updatedAt: task.updatedAt };
      const c = task.context;
      if (c.ideaBrief) out.push({ ...base, id: `${task.id}::brief`, kind: "brief", title: "Idea brief", size: c.ideaBrief.length });
      if (c.architectureSpec) out.push({ ...base, id: `${task.id}::spec`, kind: "spec", title: "Architecture guide", size: c.architectureSpec.length });
      for (const f of c.implementationDiff ? parseFileBlocks(c.implementationDiff) : []) {
        out.push({ ...base, id: `${task.id}::file::${f.path}`, kind: "file", path: f.path, title: f.path, size: f.content.length });
      }
      if (c.verificationLog) out.push({ ...base, id: `${task.id}::verification`, kind: "verification", title: "Verification log", size: c.verificationLog.length });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** A task's own version of an artifact (files come from its own implementation reply, not whatever is on disk now). */
  async artifactContent(taskId: string, kind: ArtifactInfo["kind"], filePath?: string): Promise<{ title: string; content: string; filename: string }> {
    const task = await this.load(taskId);
    if (!task) throw new UserError(`Không tìm thấy task ${taskId}.`);
    const c = task.context;
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
    switch (kind) {
      case "brief":
        if (c.ideaBrief) return { title: "Idea brief", content: c.ideaBrief, filename: `${safe(c.title)}-brief.md` };
        break;
      case "spec":
        if (c.architectureSpec) return { title: "Architecture guide", content: c.architectureSpec, filename: `${safe(c.title)}-architecture.md` };
        break;
      case "verification":
        if (c.verificationLog) return { title: "Verification log", content: c.verificationLog, filename: `${safe(c.title)}-verification.log` };
        break;
      case "file": {
        const f = c.implementationDiff ? parseFileBlocks(c.implementationDiff).find((x) => x.path === filePath) : undefined;
        if (f) return { title: f.path, content: f.content, filename: f.path.split("/").pop() || "file.txt" };
        break;
      }
    }
    throw new UserError("Không tìm thấy artifact này.");
  }

  async taskDetail(taskId: string) {
    const task = await this.load(taskId);
    if (!task) throw new UserError(`Không tìm thấy task ${taskId}.`);
    const idx = await this.index();
    return {
      task,
      snapshot: await this.taskSnapshot(task, idx),
      calls: await readCalls(taskId),
      artifacts: await this.listArtifacts(taskId),
      slotDirectives: this.withStale(this.state.directives.filter((d) => d.slotId === (task.slotId ?? this.slotOf(taskId))), task),
      companyDirectives: this.withStale(this.state.directives.filter((d) => !d.slotId), task),
    };
  }

  async statusSnapshot() {
    const idx = await this.index();
    return {
      slots: await Promise.all(SLOTS.map((s) => this.slotSnapshot(s.id, idx))),
      engines: this.engineSnapshot(),
      plan: await this.planSnapshot(),
      telemetry: await this.telemetry(idx),
      insights: await this.insights(idx),
      control: this.control(),
      rebalance: this.rebalanceSnapshot(),
      teams: TEAMS,
      lessons: await this.lessonsSummary(),
      settings: { githubAvailable: this.githubAvailable, projectsRoot: this.projectsRoot ?? null, defaultProjectDir: this.projectsRoot ? "" : this.defaultProjectDir(), handoffOn: this.settings.handoffOn, stageErrorRetries: this.settings.stageErrorRetries, maxAutoRecoveries: this.pipeline.maxAutoRecoveries ?? 0 },
    };
  }

  // ---------- roles: lessons, playbooks, scoreboard ----------

  /** Pending and accepted lesson counts per role, for the chart's badges and the scoreboard. */
  async lessonsSummary(): Promise<{ pending: Record<string, number>; accepted: Record<string, number> }> {
    const pending: Record<string, number> = {};
    const accepted: Record<string, number> = {};
    for (const l of await loadLessons()) {
      if (l.status === "pending") pending[l.slotId] = (pending[l.slotId] ?? 0) + 1;
      if (l.status === "accepted") accepted[l.slotId] = (accepted[l.slotId] ?? 0) + 1;
    }
    return { pending, accepted };
  }

  /** A role's playbook file and its lessons, for the dashboard's role panel. */
  async roleDetail(slotId: string): Promise<{ role: SlotSnapshot; playbook: string; playbookPath: string; lessons: Lesson[] }> {
    if (!roleById(slotId)) throw new UserError(`Không có vị trí ${slotId}.`);
    const pb = await loadPlaybook(slotId);
    return {
      role: await this.slotSnapshot(slotId),
      playbook: pb?.raw ?? "",
      playbookPath: `playbooks/${slotId}.md`,
      lessons: (await loadLessons()).filter((l) => l.slotId === slotId && l.status !== "dismissed").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  async addRoleLesson(slotId: string, text: string): Promise<Lesson | undefined> {
    if (!roleById(slotId)) throw new UserError(`Không có vị trí ${slotId}.`);
    if (!text.trim()) throw new UserError("Nhập nội dung bài học.");
    const lesson = await addLesson(slotId, text, "accepted");
    this.emit("lessons");
    return lesson;
  }

  async decideRoleLesson(id: string, decision: "accept" | "dismiss" | "remove", text?: string): Promise<Lesson | undefined> {
    try {
      const lesson = await decideLesson(id, decision, text);
      this.emit("lessons");
      return lesson;
    } catch (err) {
      throw new UserError((err as Error).message);
    }
  }

  /**
   * How each role has performed over every task it ever owned (not just the
   * ones still in a queue): how often its work passed first time, how many
   * send-backs it needed, and what it cost. Read from each task's history, so
   * tasks from before roles had playbooks count too.
   */
  async scoreboard(): Promise<{ roles: RoleScore[]; since: string | null; taskCount: number }> {
    const tasks = (await listAllTasks()).filter((t) => t.slotId);
    const rows = new Map<string, RoleScore>(ROLES.map((r) => [r.id, emptyScore(r.id)]));
    for (const t of tasks) {
      const row = rows.get(t.slotId!) ?? rows.set(t.slotId!, emptyScore(t.slotId!)).get(t.slotId!)!;
      const rejects = (stages: Stage[]) => t.history.filter((h) => stages.includes(h.stage) && /^Verdict: reject/i.test(h.summary)).length;
      const archRejects = rejects(["architecture_review"]);
      const reviewRejects = rejects(["review_gemini", "review_claude"]);
      const verifyFails = t.history.filter((h) => h.summary === "Verification FAILED.").length;
      const ceoSendBacks = t.history.filter((h) => h.by === "ceo" && /^(Revision requested|Sent back)/.test(h.summary)).length;
      const runs = t.runs ?? [];
      row.tasks++;
      if (t.stage === "done") row.done++;
      else if (t.stage === "rejected") row.rejected++;
      if (t.stage === "done" && !reviewRejects && !verifyFails && !ceoSendBacks) row.firstPass++;
      row.archRejects += archRejects;
      row.reviewRejects += reviewRejects;
      row.verifyFails += verifyFails;
      row.ceoSendBacks += ceoSendBacks;
      row.roleCheckFails += (t.feedbackLog ?? []).filter((f) => f.kind === "role_check").length;
      row.tokens += runs.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
      row.costUsd += runs.reduce((n, r) => n + r.costUsd, 0);
      row.activeMs += runs.reduce((n, r) => n + Math.max(0, ms(r.startedAt, r.endedAt) - r.waitMs), 0);
    }
    const since = tasks.map((t) => t.createdAt).sort()[0] ?? null;
    return { roles: [...rows.values()], since, taskCount: tasks.length };
  }

  // ---------- scheduling ----------

  private parallelFor(slotId: string): number {
    return this.settings.slotParallel[slotId] ?? this.settings.defaultSlotParallel;
  }

  private isGated(task: TaskRecord): boolean {
    const slot = task.slotId ?? this.slotOf(task.id);
    return Boolean(slot && this.state.gates[slot]);
  }

  /** A gated slot's results only hand off once the CEO approves them. */
  private handoffPointFor(task: TaskRecord): HandoffPoint {
    return this.isGated(task) ? "done" : (task.projectConfig?.handoffOn ?? this.settings.handoffOn);
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
        if (this.state.paused) break;
        for (const slot of SLOTS) {
          const limit = this.parallelFor(slot.id);
          let active = [...this.workers.values()].filter((w) => w.slotId === slot.id).length;
          for (const id of [...(this.state.slots[slot.id] ?? [])]) {
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
      task.lastError = { at: nowIso(), stage: task.stage, message: (err as Error).message, attempts: 1 };
      await saveTask(task).catch(() => {});
    } finally {
      this.workers.delete(task.id);
      this.running.delete(task.id);
      this.resetLive(task.id);
      this.emit("slot", w.slotId);
      if (task.planRef) this.emitPlan();
      this.emit("engines");
      this.pump();
      void this.afterWorker(task.id, w.slotId).catch((err) => console.error(`afterWorker ${task.id}: ${(err as Error).message}`));
    }
  }

  private startRun(task: TaskRecord): StageRun {
    const run: StageRun = {
      stage: task.stage,
      startedAt: nowIso(),
      waitMs: 0,
      engines: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      estimated: false,
    };
    (task.runs ??= []).push(run);
    this.currentRun.set(task.id, run);
    task.stageStartedAt = run.startedAt;
    this.resetLive(task.id);
    return run;
  }

  private finishRun(task: TaskRecord, outcome: NonNullable<StageRun["outcome"]>, error?: string): void {
    const run = this.currentRun.get(task.id);
    if (run && !run.endedAt) Object.assign(run, { endedAt: nowIso(), outcome, error });
  }

  /** Runs the current stage with automatic retries on runtime errors. False means stop this worker. */
  private async runStage(task: TaskRecord, w: Worker): Promise<boolean> {
    const retries = this.settings.stageErrorRetries;
    for (let attempt = 0; ; attempt++) {
      await this.waitIfPaused(w);
      if (w.cancelled) return false;
      // Registered before any await, so a Stop that lands while this stage
      // is still being set up aborts it too.
      const ctrl = new AbortController();
      this.controllers.set(task.id, ctrl);
      task.context.directives = this.directivesFor(task);
      this.startRun(task);
      try {
        await saveTask(task);
        this.emitTask(task);
        await this.executeStage(task, ctrl.signal);
        this.finishRun(task, "ok");
        task.lastError = undefined;
        if (task.redoRequested) await this.redo(task, task.redoRequested);
        await this.afterStage(task);
        return true;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (ctrl.signal.aborted || w.cancelled) {
          this.finishRun(task, "cancelled");
          log(task, task.stage, "ceo", `Stopped by the CEO during ${task.stage} — it restarts from this stage on Resume.`);
          await saveTask(task);
          this.emitTask(task);
          return false;
        }
        this.finishRun(task, "error", message);
        // A usage limit that names its reset time won't clear in seconds:
        // pause until then and resume automatically instead of burning the
        // retries and leaving the task stuck until someone clicks Retry.
        const resumeAt = quotaResumeAt(message, new Date());
        if (resumeAt) {
          task.lastError = { at: nowIso(), stage: task.stage, message, attempts: attempt + 1, resumeAt: resumeAt.toISOString() };
          log(task, task.stage, "system", `Usage limit at ${task.stage}: ${message} — paused, resumes automatically at ${clockTime(resumeAt)}.`);
          await saveTask(task);
          this.emitTask(task);
          this.scheduleQuotaResume(task.id, resumeAt);
          return false;
        }
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
        task.lastError = { at: nowIso(), stage: task.stage, message, attempts: attempt + 1 };
        log(task, task.stage, "system", `Paused after ${attempt + 1} failed attempt(s) at ${task.stage}: ${message}`);
        await saveTask(task);
        this.emitTask(task);
        return false;
      } finally {
        this.controllers.delete(task.id);
        this.currentRun.delete(task.id);
      }
    }
  }

  private async executeStage(task: TaskRecord, signal: AbortSignal): Promise<void> {
    const hooks = { onChunk: (text: string) => this.onChunk(task.id, text), signal };

    if (task.stage === "implementation") {
      // Ask Muse for the diff first, without holding the workspace lock —
      // only the disk write and the build/test that follows need it
      // exclusive, not the (potentially long) chat call itself.
      await draftImplementation(task, this.agents, hooks, this.pipeline);
      await this.withEngine("workspace", task.id, async () => {
        await applyImplementation(task, this.pipeline);
        // A refused attempt (no files, or files that failed the pre-write
        // checks) stays at implementation or is out of budget — nothing was
        // written, so there is nothing to verify.
        if (task.stage !== "verification") return;
        // Verify while still holding the workspace, so no other task's
        // files land between this task's write and its build.
        this.finishRun(task, "ok");
        this.startRun(task);
        await saveTask(task);
        this.emitTask(task);
        if (signal.aborted) throw Object.assign(new Error("stopped by the CEO"), { name: "AbortError" });
        await advance(task, this.agents, this.pipeline, hooks);
      });
      return;
    }

    if (task.stage !== "verification") {
      await advance(task, this.agents, this.pipeline, hooks);
      return;
    }
    await this.withEngine("workspace", task.id, () => advance(task, this.agents, this.pipeline, hooks));
  }

  /**
   * Where a task's run stopped, once its worker is gone: auto-ship it if the
   * plan allows that and everything is green, otherwise tell the CEO what
   * needs them.
   */
  private async afterWorker(taskId: string, slotId: string): Promise<void> {
    const task = await this.load(taskId);
    if (!task || this.workers.has(taskId)) return;
    const who = `${slotId} ${task.context.title}`;
    if (task.stage === "checkpoint_final" && task.projectConfig?.autoApprove && !shipWarnings(task).length && !task.lastError) {
      trace(task, "System", "gate", "Auto-approved: verification passed, the reviewers approved, and there is no red warning.");
      await saveTask(task);
      await this.decide(taskId, "approve");
      this.notify("Đã tự duyệt", who);
      await this.notifyIfPlanFinished(task);
      return;
    }
    if (task.lastError) {
      this.notify(task.lastError.resumeAt ? "Tạm dừng vì hết hạn mức" : "Task bị dừng vì lỗi", `${who} — ${task.lastError.message.slice(0, 120)}`);
    } else if (task.stage === "rejected") {
      this.notify("Task bị từ chối", `${who} — đã hết lượt thử`);
    } else if (isWaitingForHuman(task)) {
      const red = shipWarnings(task).length;
      this.notify(red ? `Chờ bạn duyệt · ${red} cảnh báo đỏ` : "Chờ bạn duyệt", who);
    }
  }

  /** One notification when the last task of a plan is done. */
  private async notifyIfPlanFinished(task: TaskRecord): Promise<void> {
    const planId = task.planRef?.planId;
    if (!planId) return;
    const plan = await loadPlan(planId);
    const ids = (plan?.epics ?? []).flatMap((e) => [e.taskId, ...e.subtasks.map((s) => s.taskId)]).filter(Boolean) as string[];
    for (const id of ids) if ((await this.load(id))?.stage !== "done") return;
    this.notify("Kế hoạch hoàn tất", plan!.goal.slice(0, 160));
  }

  private async afterStage(task: TaskRecord): Promise<void> {
    if (isWaitingForHuman(task) && !task.runs?.some((r) => r.human && !r.endedAt)) {
      (task.runs ??= []).push({
        stage: task.stage,
        startedAt: nowIso(),
        waitMs: 0,
        engines: [],
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        estimated: false,
        human: true,
      });
    }
    if (!task.handoff && reachedHandoffPoint(task.stage, this.handoffPointFor(task))) {
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

  private async warnDependents(task: TaskRecord, what: string): Promise<void> {
    for (const dep of await this.findDependents(task.id)) {
      log(dep, dep.stage, "system", `Warning: upstream "${task.context.title}" was ${what} by the CEO after handing off — this task built on a version that may still change.`);
      if (!this.workers.has(dep.id)) await saveTask(dep);
      this.emitTask(dep);
    }
  }

  /** Applies a "redo" directive: work already past architecture goes back to it with the directive as feedback. */
  private async redo(task: TaskRecord, text: string): Promise<void> {
    task.redoRequested = undefined;
    if (!LATE_STAGES.includes(task.stage)) return; // not designed yet — the directive simply shapes what comes next
    task.stage = "architecture";
    task.implementationAttempts = 0;
    task.reviewRejections = 0;
    task.architectureRounds = 0;
    task.lastError = undefined;
    task.context.reviewFeedback = [`CEO directive — rework the design with this in mind:\n${text}`];
    log(task, task.stage, "ceo", `Redo from architecture requested: ${text}`);
    trace(task, "CEO", "directive", `Sent back to architecture to apply: ${text}`);
    if (task.handoff) {
      task.handoff = undefined;
      await this.warnDependents(task, "sent back for rework");
    }
  }

  /** Marks the directives that no longer reach anything: given for another plan than the task's (or the active one). */
  private withStale(list: Directive[], task?: TaskRecord): (Directive & { stale: boolean })[] {
    return list.map((d) => ({
      ...d,
      stale: task ? !directiveApplies(d, task) : Boolean(d.planId && d.planId !== this.state.activePlanId),
    }));
  }

  private directivesFor(task: TaskRecord): string[] | undefined {
    const slot = task.slotId ?? this.slotOf(task.id);
    const list = this.state.directives.filter((d) => (!d.slotId || d.slotId === slot) && directiveApplies(d, task)).map((d) => d.text);
    return list.length ? list : undefined;
  }

  private async updatePlanOwner(task: TaskRecord, owner: string): Promise<void> {
    if (!task.planRef) return;
    const plan = await loadPlan(task.planRef.planId);
    const epic = plan?.epics?.find((e) => e.id === task.planRef!.epicId);
    if (!plan || !epic) return;
    if (task.planRef.subtaskId) {
      const sub = epic.subtasks.find((s) => s.id === task.planRef!.subtaskId);
      if (sub) sub.owner = owner;
    } else {
      epic.owner = owner;
    }
    await savePlan(plan);
    this.emitPlan();
  }

  private queueStateOf(task: TaskRecord, deps: DependencyState): QueueState {
    if (this.workers.has(task.id)) return "running";
    if (task.lastError) return "error";
    if (isWaitingForHuman(task)) return "waiting_you";
    if (task.stage === "done") return "done";
    if (task.stage === "rejected") return "rejected";
    if (deps.state === "blocked") return "blocked";
    if (deps.state === "waiting") return "waiting_deps";
    return "queued";
  }

  private slotState(tasks: TaskSnapshot[]): SlotSnapshot["state"] {
    const has = (q: QueueState) => tasks.find((t) => t.queueState === q);
    let t: TaskSnapshot | undefined;
    if ((t = has("running"))) {
      const a = t.activity;
      return { kind: "running", label: "Running", detail: a ? `${a.engine} ${a.state === "waiting" ? "· chờ lượt" : ""}`.trim() : t.stage };
    }
    if ((t = has("waiting_you"))) return { kind: "needs_review", label: "Needs Review", detail: t.stage === "checkpoint_idea" ? "duyệt ý tưởng" : "duyệt kết quả" };
    if ((t = has("error") ?? has("rejected") ?? has("blocked"))) {
      return { kind: "blocked", label: "Blocked", detail: t.lastError ?? t.deps.blockedBy ?? "bị từ chối" };
    }
    if ((t = has("waiting_deps"))) {
      const slots = [...new Set(t.inputsFrom.filter((i) => !i.handedOff).map((i) => i.slotId))];
      return { kind: "waiting_input", label: `Waiting on ${slots.join(", ") || "đầu vào"}`, detail: "đang chờ đầu vào" };
    }
    if (has("queued")) return this.state.paused ? { kind: "paused", label: "Paused" } : { kind: "ready", label: "Ready", detail: "trong hàng đợi" };
    if (has("done")) return { kind: "done", label: "Done" };
    return { kind: "idle", label: "Idle (Ready)" };
  }

  private async dependencyState(task: TaskRecord, index?: Index): Promise<DependencyState> {
    const ids = task.dependsOn ?? [];
    const result: DependencyState = { state: "ready", handoffs: [], waitingOn: [], waitingOnSlots: [], total: ids.length };
    for (const id of ids) {
      const dep = index?.get(id) ?? (await this.load(id));
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
        const slot = dep.slotId ?? this.slotOf(dep.id) ?? "?";
        result.waitingOn.push(`${slot} ${dep.context.title}`);
        result.waitingOnSlots.push(slot);
      }
    }
    return result;
  }

  private async findDependents(taskId: string): Promise<TaskRecord[]> {
    const idx = await this.index();
    return this.dependentsIndex(idx).get(taskId) ?? [];
  }

  private dependentsIndex(idx: Index): Map<string, TaskRecord[]> {
    const map = new Map<string, TaskRecord[]>();
    for (const t of idx.values()) for (const d of t.dependsOn ?? []) map.set(d, [...(map.get(d) ?? []), t]);
    return map;
  }

  /** The boss's planning playbook plus its accepted lessons; planning goes on without it if the file is missing. */
  private async bossPlaybook(): Promise<string | undefined> {
    try {
      const [pb, lessons] = await Promise.all([loadPlaybook(BOSS_ID), acceptedLessons(BOSS_ID)]);
      return formatGuidance(BOSS_ID, pb, "architecture", lessons);
    } catch {
      return undefined;
    }
  }

  private async generatePlan(plan: WorkPlanRecord, revision?: { feedback: string; previous?: WorkPlan }): Promise<void> {
    const key = `plan:${plan.id}`;
    this.planPhase = "Claude is drafting";
    this.planController = new AbortController();
    try {
      const res = await draftAndReviewPlan({ claude: this.agents.claude, gemini: this.agents.gemini }, plan.goal, DEPARTMENTS, {
        maxRounds: this.settings.planMaxRounds,
        limits: this.settings.planLimits,
        revisionFeedback: revision?.feedback,
        previous: revision?.previous,
        environment: await this.machineEnvironment(),
        survey: await this.projectSurvey(plan),
        playbook: await this.bossPlaybook(),
        send: { taskId: key, onChunk: (t) => this.onChunk(key, t), signal: this.planController.signal, model: this.settings.planModel },
        onRound: (round, phase) => {
          this.planPhase = phase === "draft" ? `Round ${round}: Claude is drafting` : `Round ${round}: Gemini is reviewing`;
          this.resetLive(key);
          this.emitPlan();
        },
      });
      const project = plan.project ?? { dir: this.defaultProjectDir(), verifyCommands: [], warnings: [] };
      if (!project.commandsByCeo) project.verifyCommands = res.plan.verifyCommands ?? [];
      project.commandWarnings = commandWarnings(allPlanCommands(project.verifyCommands, res.plan.epics));
      Object.assign(plan, {
        project,
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
      plan.error = this.planController.signal.aborted ? "Stopped by the CEO — retry to draft it again." : (err as Error).message;
    }
    this.planController = null;
    this.planPhase = null;
    this.resetLive(key);
    const usage = this.planUsage.get(key);
    if (usage) plan.usage = { ...usage };
    if (this.state.activePlanId !== plan.id) plan.status = "discarded"; // reset while drafting
    await savePlan(plan);
    if (plan.status === "awaiting_approval") this.notify("Kế hoạch chờ duyệt", plan.goal.slice(0, 160));
    else if (plan.status === "failed") this.notify("Lập kế hoạch thất bại", (plan.error ?? plan.goal).slice(0, 160));
    this.emitPlan();
  }

  // ---------- usage & activity ----------

  private recordCall(rec: CallRecord): void {
    void appendCall(rec).catch((err) => console.error(`Could not log call for ${rec.taskId}: ${err.message}`));
    const cost = rec.usage.costUsd ?? 0;
    if (rec.taskId.startsWith("plan:") || rec.taskId === "rebalance") {
      const u = this.planUsage.get(rec.taskId) ?? { input: 0, output: 0, costUsd: 0 };
      u.input += rec.usage.inputTokens;
      u.output += rec.usage.outputTokens;
      u.costUsd += cost;
      this.planUsage.set(rec.taskId, u);
      this.emitControl();
      return;
    }
    const run = this.currentRun.get(rec.taskId);
    if (!run) return;
    run.inputTokens += rec.usage.inputTokens;
    run.outputTokens += rec.usage.outputTokens;
    run.costUsd += cost;
    run.waitMs += rec.waitMs;
    run.estimated ||= Boolean(rec.usage.estimated) || rec.usage.costUsd === undefined;
    if (!run.engines.includes(rec.engine)) run.engines.push(rec.engine);
    const by = (run.usageByEngine ??= {});
    const e = (by[rec.engine] ??= { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    e.inputTokens += rec.usage.inputTokens;
    e.outputTokens += rec.usage.outputTokens;
    e.costUsd += cost;
  }

  private addUsage(t: Telemetry, run: StageRun): void {
    t.tokensEstimated ||= run.estimated && run.inputTokens + run.outputTokens > 0;
    for (const [engine, u] of Object.entries(run.usageByEngine ?? {})) {
      this.addEngineUsage(t, engine, u.inputTokens, u.outputTokens, u.costUsd);
      if (engine === "muse" || u.costUsd === 0) t.costPartial = true;
    }
  }

  private addEngineUsage(t: Telemetry, engine: string, input: number, output: number, costUsd: number): void {
    t.tokens.input += input;
    t.tokens.output += output;
    t.costUsd += costUsd;
    const e = (t.byEngine[engine] ??= { input: 0, output: 0, costUsd: 0 });
    e.input += input;
    e.output += output;
    e.costUsd += costUsd;
  }

  // ---------- helpers ----------

  private requireSlot(slotId: string): void {
    if (!SLOTS.some((s) => s.id === slotId)) throw new UserError(`Không có nhân sự ${slotId}.`);
  }

  private async activePlan(): Promise<(WorkPlanRecord & { usage?: { input: number; output: number; costUsd: number } }) | undefined> {
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

  /** Every assigned task, loaded once — snapshots use this instead of re-reading files per lookup. */
  private async index(): Promise<Index> {
    const idx: Index = new Map();
    for (const ids of Object.values(this.state.slots)) {
      for (const id of ids) {
        const t = await this.load(id);
        if (t) idx.set(id, t);
      }
    }
    return idx;
  }

  private async mutateState(fn: (s: DashboardState) => void): Promise<void> {
    fn(this.state);
    const snapshot = JSON.parse(JSON.stringify(this.state)) as DashboardState;
    this.stateWrite = this.stateWrite.then(() => saveDashboardState(snapshot)).catch((err) => console.error(`Could not save dashboard state: ${err.message}`));
    await this.stateWrite;
  }

  private async withEngine<T>(engine: EngineName, id: string, fn: () => Promise<T>): Promise<T> {
    const waitStart = Date.now();
    this.pushActivity(id, engine, "waiting");
    const release = await this.engines[engine].acquire(id);
    const run = this.currentRun.get(id);
    if (run) run.waitMs += Date.now() - waitStart;
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
    stack.push({ engine, state, since: nowIso() });
    this.activity.set(id, stack);
    this.emitActivity(id);
  }

  private markRunning(id: string, engine: EngineName): void {
    const stack = this.activity.get(id) ?? [];
    const entry = [...stack].reverse().find((a) => a.engine === engine && a.state === "waiting");
    if (entry) {
      entry.state = "running";
      entry.since = nowIso();
    } else {
      stack.push({ engine, state: "running", since: nowIso() });
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
    else if (id === "rebalance") this.emitRebalance();
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

  private emitControl(): void {
    this.emit("control");
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

  private async taskSnapshot(task: TaskRecord, idx: Index): Promise<TaskSnapshot> {
    const status = deriveStatus(task.stage);
    const isRunning = this.workers.has(task.id);
    const deps = await this.dependencyState(task, idx);
    const queueState = this.queueStateOf(task, deps);
    const runs = (task.runs ?? []).filter((r) => !r.human);
    const last = runs.at(-1);
    const act = this.currentActivity(task.id);
    let engineQueue: TaskSnapshot["engineQueue"] = null;
    if (act) {
      const sem = this.engines[act.engine];
      const keys = act.state === "waiting" ? sem.waitingKeys() : sem.runningKeys();
      engineQueue = { engine: act.engine, state: act.state, position: keys.indexOf(task.id) + 1, of: keys.length };
    }
    const lastEntry = (stage: Stage, by?: string) => [...task.history].reverse().find((h) => h.stage === stage && (!by || h.by === by) && /Verdict|Verification/.test(h.summary));
    const gem = lastEntry("review_gemini");
    const cla = lastEntry("review_claude", "claude");
    const ver = lastEntry("verification");
    const verdictOf = (h?: { summary: string }) => (h ? (/approve/i.test(h.summary) ? "approve" : /reject/i.test(h.summary) ? "reject" : "unknown") : null);
    const dependents = this.dependentsIndex(idx).get(task.id) ?? [];
    const assign = task.trace?.find((t) => t.kind === "assign");

    return {
      id: task.id,
      title: task.context.title,
      stage: task.stage,
      label: status.label,
      // A planned task "sits at" architecture before it has started; don't color it as if it were planning.
      colorClass: queueState === "queued" || queueState === "waiting_deps" || queueState === "blocked" ? "gray" : status.colorClass,
      progress: isTerminal(task) ? 100 : status.progress,
      queueState,
      waitingForYou: queueState === "waiting_you",
      checkpointBrief: task.stage === "checkpoint_idea" ? task.context.ideaBrief : undefined,
      lastFeedback: task.context.reviewFeedback?.length ? task.context.reviewFeedback.join("\n").slice(0, 1500) : undefined,
      lastError: task.lastError ? `${task.lastError.stage}: ${task.lastError.message}`.slice(0, 1500) : undefined,
      alerts: (task.alerts ?? []).map((a) => ({ level: a.level, text: a.text })),
      logs: task.history.slice(-4).map((h) => ({ at: hhmm(h.at), text: h.summary })),
      acceptanceCriteria: task.context.acceptanceCriteria ?? [],
      deps: { total: deps.total, ready: deps.handoffs.length, waitingOn: deps.waitingOn, blockedBy: deps.blockedBy },
      inputsFrom: (task.dependsOn ?? [])
        .map((id) => idx.get(id))
        .filter((d): d is TaskRecord => Boolean(d))
        .map((d) => ({ slotId: d.slotId ?? this.slotOf(d.id) ?? "?", title: d.context.title, handedOff: Boolean(d.handoff) })),
      outputsTo: dependents.map((d) => ({ slotId: d.slotId ?? this.slotOf(d.id) ?? "?", title: d.context.title })),
      activity: this.currentActivity(task.id),
      stageStartedAt: isRunning ? task.stageStartedAt : undefined,
      liveTail: this.liveTail.get(task.id) ?? "",
      liveTotal: this.liveTotal.get(task.id) ?? 0,
      planRef: task.planRef,
      handedOff: Boolean(task.handoff),
      gated: this.isGated(task),
      lastRun: last
        ? {
            stage: last.stage,
            durationMs: ms(last.startedAt, last.endedAt),
            waitMs: last.waitMs,
            tokens: last.inputTokens + last.outputTokens,
            costUsd: last.costUsd,
            estimated: last.estimated,
            outcome: last.outcome,
          }
        : null,
      totals: {
        tokens: runs.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
        costUsd: runs.reduce((s, r) => s + r.costUsd, 0),
        activeMs: runs.reduce((s, r) => s + Math.max(0, ms(r.startedAt, r.endedAt) - r.waitMs), 0),
        runs: runs.length,
      },
      redoPending: Boolean(task.redoRequested),
      engineQueue,
      review: {
        verification: ver ? (/passed/i.test(ver.summary) ? "passed" : "failed") : null,
        gemini: verdictOf(gem),
        geminiStandIn: gem?.by === "claude",
        claude: verdictOf(cla),
      },
      waitingSince: queueState === "waiting_you" ? ([...(task.runs ?? [])].reverse().find((r) => r.human && !r.endedAt)?.startedAt ?? task.updatedAt) : undefined,
      assignedBy: assign?.by,
      architectureRounds: task.architectureRounds ?? 0,
      reviewRejections: task.reviewRejections ?? 0,
    };
  }
}

const ENGINE_PHASE: Record<string, string> = {
  claude: "Claude (phân tích/duyệt)",
  gemini: "Gemini (thẩm định)",
  muse: "khâu Kỹ thuật (Muse)",
  workspace: "khâu Kỹ thuật/Kiểm thử (thư mục dự án)",
};

/** The dashboard's workflow columns. */
export function workflowPhase(stage: Stage): string {
  switch (stage) {
    case "ideation":
    case "checkpoint_idea":
    case "architecture":
    case "architecture_review":
      return "Phân tích";
    case "implementation":
      return "Kỹ thuật";
    case "verification":
    case "review_gemini":
    case "review_claude":
      return "Kiểm thử";
    case "checkpoint_final":
      return "Chờ duyệt";
    default:
      return "Xuất bản";
  }
}

export function isUserError(err: unknown): boolean {
  return err instanceof UserError;
}
