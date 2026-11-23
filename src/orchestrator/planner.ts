import type { Agent, ProjectConfig, SendOptions, TaskRecord } from "../types.js";
import { createPlannedTask } from "./pipeline.js";

export interface Department {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
}

export interface PlanSubtask {
  id: string;
  title: string;
  owner: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  taskId?: string;
}

export interface PlanEpic {
  id: string;
  title: string;
  owner: string;
  goal: string;
  acceptanceCriteria: string[];
  subtasks: PlanSubtask[];
  /** The lead's integration task, depending on all of this epic's subtasks. */
  taskId?: string;
}

export interface WorkPlan {
  summary: string;
  epics: PlanEpic[];
}

export type PlanStatus = "drafting" | "awaiting_approval" | "approved" | "failed" | "discarded";

export interface WorkPlanRecord extends Partial<WorkPlan> {
  id: string;
  goal: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  /** Owner reassignments, dropped dependencies and similar fixes made while validating the draft. */
  notes?: string[];
  reviewRounds?: number;
  /** Gemini's last objection, if the round limit ran out before it approved — shown to the CEO. */
  unresolvedReview?: string;
  revisionFeedback?: string;
  error?: string;
}

export interface PlanLimits {
  maxEpics: number;
  maxSubtasks: number;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = { maxEpics: 3, maxSubtasks: 8 };

export function newPlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function buildPlanPrompt(goal: string, departments: Department[], limits: PlanLimits, revision?: { previous?: WorkPlan; feedback: string }): string {
  const leads = departments.filter((d) => d.tier === 2).map((d) => `${d.id} (${d.name})`).join(", ");
  const staff = departments.filter((d) => d.tier === 3).map((d) => `${d.id} (${d.name})`).join(", ");
  const parts = [
    "PLAN: You are the boss (AG-01) of an AI software company. Break the company-wide goal below into a structured work tree BEFORE anyone starts work, so every task traces back to the goal instead of departments working on disconnected things.",
    "Rules:",
    `- 1 to ${limits.maxEpics} epics. Each epic is owned by exactly one team lead: ${leads}. The lead later integrates and verifies the epic as a whole.`,
    `- Each epic has 1-4 subtasks, at most ${limits.maxSubtasks} subtasks in total. Each subtask is owned by one staff member whose specialty fits: ${staff}. A staff member may own more than one subtask.`,
    "- Every subtask must be concrete, implementable and verifiable in code, and contribute directly to the goal. No vague research or documentation subtasks unless the goal itself needs them.",
    "- acceptanceCriteria: 2-5 specific, testable statements per epic and per subtask — things a reviewer can check by running the code or its tests.",
    "- dependsOn: ids of subtasks (in any epic) that must finish first because this one consumes their output. No cycles. Leave it empty whenever work can proceed in parallel.",
    "- Write titles, descriptions and criteria in the same language as the goal.",
    "Reply with ONLY one JSON object, no prose before or after, in exactly this shape:",
    '{"summary": "...", "epics": [{"id": "E1", "title": "...", "owner": "AG-05", "goal": "...", "acceptanceCriteria": ["..."], "subtasks": [{"id": "E1.S1", "title": "...", "owner": "AG-03", "description": "...", "acceptanceCriteria": ["..."], "dependsOn": []}]}]}',
    "",
    `Company-wide goal: ${goal}`,
  ];
  if (revision) {
    if (revision.previous) parts.push("", `Your previous plan:\n${JSON.stringify(revision.previous)}`);
    parts.push("", `Revise it to address this feedback (keep what wasn't criticized):\n${revision.feedback}`);
  }
  return parts.join("\n");
}

const PLAN_REVIEW_PROMPT =
  "REVIEW: You are reviewing the boss's work plan before the CEO sees it and before any team starts. Check that: the epics and subtasks together actually achieve the goal (nothing important missing, nothing off-goal); each subtask is concrete and owned by a fitting specialist; acceptance criteria are specific and testable; dependencies are real and don't serialize work that could run in parallel. " +
  "Approve if it's sound. Otherwise reject and list exactly what to change (which epic/subtask, what to add/remove/reword).";

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in the reply");
  return text.slice(start, end + 1);
}

function asStringArray(value: unknown, where: string): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) throw new Error(`${where}: acceptanceCriteria must be a list of strings`);
  const items = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  if (items.length === 0) throw new Error(`${where}: acceptanceCriteria is empty`);
  return items;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} is missing`);
  return value.trim();
}

/** Throws (with a message meant to be sent back to the planner) if `deps` has a cycle. */
function assertAcyclic(deps: Map<string, string[]>): void {
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") throw new Error(`dependency cycle: ${[...trail, id].join(" -> ")}`);
    state.set(id, "visiting");
    for (const next of deps.get(id) ?? []) visit(next, [...trail, id]);
    state.set(id, "done");
  };
  for (const id of deps.keys()) visit(id, []);
}

/**
 * Parses and validates the planner's reply. Structural problems the planner
 * should fix itself (bad JSON, missing fields, cycles, too many subtasks)
 * throw, so the caller can send the message back for another attempt.
 * Problems with an obvious safe fix (an owner from the wrong tier, a
 * dependency on an id that doesn't exist) are fixed here and listed in
 * `notes` so the CEO sees what was changed.
 */
export function parsePlan(text: string, departments: Department[], limits: PlanLimits = DEFAULT_PLAN_LIMITS): { plan: WorkPlan; notes: string[] } {
  let raw: any;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (err) {
    throw new Error(`reply was not valid JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(raw?.epics) || raw.epics.length === 0) throw new Error("plan has no epics");
  if (raw.epics.length > limits.maxEpics) throw new Error(`plan has ${raw.epics.length} epics, the limit is ${limits.maxEpics}`);

  const leads = departments.filter((d) => d.tier === 2).map((d) => d.id);
  const staff = departments.filter((d) => d.tier === 3).map((d) => d.id);
  const notes: string[] = [];
  let leadTurn = 0;
  let staffTurn = 0;
  const seen = new Set<string>();

  const epics: PlanEpic[] = raw.epics.map((e: any, ei: number) => {
    const epicId = requireString(e?.id, `epic #${ei + 1} id`);
    if (seen.has(epicId)) throw new Error(`duplicate id ${epicId}`);
    seen.add(epicId);
    let owner = typeof e?.owner === "string" ? e.owner.trim() : "";
    if (!leads.includes(owner)) {
      const fixed = leads[leadTurn++ % leads.length];
      notes.push(`Epic ${epicId}: owner "${owner || "(none)"}" is not a team lead — reassigned to ${fixed}.`);
      owner = fixed;
    }
    if (!Array.isArray(e?.subtasks) || e.subtasks.length === 0) throw new Error(`epic ${epicId} has no subtasks`);
    const subtasks: PlanSubtask[] = e.subtasks.map((s: any, si: number) => {
      const subId = requireString(s?.id, `subtask #${si + 1} of ${epicId} id`);
      if (seen.has(subId)) throw new Error(`duplicate id ${subId}`);
      seen.add(subId);
      let subOwner = typeof s?.owner === "string" ? s.owner.trim() : "";
      if (!staff.includes(subOwner)) {
        const fixed = staff[staffTurn++ % staff.length];
        notes.push(`Subtask ${subId}: owner "${subOwner || "(none)"}" is not a staff member — reassigned to ${fixed}.`);
        subOwner = fixed;
      }
      return {
        id: subId,
        title: requireString(s?.title, `subtask ${subId} title`),
        owner: subOwner,
        description: typeof s?.description === "string" && s.description.trim() ? s.description.trim() : requireString(s?.title, `subtask ${subId} title`),
        acceptanceCriteria: asStringArray(s?.acceptanceCriteria, `subtask ${subId}`),
        dependsOn: Array.isArray(s?.dependsOn) ? s.dependsOn.filter((d: unknown): d is string => typeof d === "string").map((d: string) => d.trim()) : [],
      };
    });
    return {
      id: epicId,
      title: requireString(e?.title, `epic ${epicId} title`),
      owner,
      goal: typeof e?.goal === "string" ? e.goal.trim() : "",
      acceptanceCriteria: asStringArray(e?.acceptanceCriteria, `epic ${epicId}`),
      subtasks,
    };
  });

  const allSubtasks = epics.flatMap((e) => e.subtasks);
  if (allSubtasks.length > limits.maxSubtasks) throw new Error(`plan has ${allSubtasks.length} subtasks, the limit is ${limits.maxSubtasks}`);
  const subIds = new Set(allSubtasks.map((s) => s.id));
  for (const s of allSubtasks) {
    const kept = s.dependsOn.filter((d) => d !== s.id && subIds.has(d));
    const dropped = s.dependsOn.filter((d) => !kept.includes(d));
    if (dropped.length) notes.push(`Subtask ${s.id}: dropped unknown/self dependencies ${dropped.join(", ")}.`);
    s.dependsOn = [...new Set(kept)];
  }
  assertAcyclic(new Map(allSubtasks.map((s) => [s.id, s.dependsOn])));

  return { plan: { summary: typeof raw.summary === "string" ? raw.summary.trim() : "", epics }, notes };
}

/** Plain-text rendering of a plan, for the reviewer. */
export function renderPlan(plan: WorkPlan): string {
  const lines = [`Summary: ${plan.summary}`];
  for (const e of plan.epics) {
    lines.push("", `${e.id} [lead ${e.owner}] ${e.title} — ${e.goal}`, ...e.acceptanceCriteria.map((c) => `  AC: ${c}`));
    for (const s of e.subtasks) {
      lines.push(`  ${s.id} [${s.owner}] ${s.title}${s.dependsOn.length ? ` (after ${s.dependsOn.join(", ")})` : ""}`, `    ${s.description}`);
      lines.push(...s.acceptanceCriteria.map((c) => `    AC: ${c}`));
    }
  }
  return lines.join("\n");
}

export interface PlanDraftResult {
  plan: WorkPlan;
  notes: string[];
  rounds: number;
  unresolvedReview?: string;
}

/**
 * Claude drafts, Gemini reviews, Claude revises — up to maxRounds — so the
 * plan is cross-checked by another bot before the CEO sees it. If the
 * rounds run out with Gemini still objecting, the latest plan goes to the
 * CEO anyway with Gemini's objection attached, rather than blocking.
 */
export async function draftAndReviewPlan(
  agents: { claude: Agent; gemini: Agent },
  goal: string,
  departments: Department[],
  opts: { maxRounds: number; limits?: PlanLimits; revisionFeedback?: string; previous?: WorkPlan; send?: SendOptions; onRound?: (round: number, phase: "draft" | "review") => void },
): Promise<PlanDraftResult> {
  const limits = opts.limits ?? DEFAULT_PLAN_LIMITS;
  let feedback = opts.revisionFeedback;
  let previous = opts.previous;
  let last: { plan: WorkPlan; notes: string[] } | undefined;
  let lastObjection: string | undefined;

  for (let round = 1; round <= opts.maxRounds; round++) {
    opts.onRound?.(round, "draft");
    const prompt = buildPlanPrompt(goal, departments, limits, feedback ? { previous, feedback } : undefined);
    const draft = await agents.claude.send(prompt, { title: goal }, opts.send);
    try {
      last = parsePlan(draft.content, departments, limits);
    } catch (err) {
      feedback = `Your previous reply could not be used: ${(err as Error).message}. Reply with only the JSON object in the required shape.`;
      continue;
    }

    opts.onRound?.(round, "review");
    let verdict: "approve" | "reject" | undefined;
    let reviewText = "";
    try {
      const review = await agents.gemini.send(PLAN_REVIEW_PROMPT, { title: goal, ideaBrief: renderPlan(last.plan) }, opts.send);
      verdict = review.verdict;
      reviewText = review.content;
    } catch (err) {
      return { ...last, rounds: round, unresolvedReview: `Gemini could not review the plan (${(err as Error).message}).` };
    }
    if (verdict === "approve") return { ...last, rounds: round };
    lastObjection = reviewText;
    feedback = `Gemini (independent reviewer) rejected the plan:\n${reviewText}`;
    previous = last.plan;
  }

  if (!last) throw new Error(`Claude did not produce a usable plan in ${opts.maxRounds} attempt(s): ${feedback ?? ""}`);
  return { ...last, rounds: opts.maxRounds, unresolvedReview: lastObjection };
}

function sharedBriefFor(record: WorkPlanRecord, plan: WorkPlan, epic: PlanEpic, ownId?: string): string {
  const others = plan.epics
    .flatMap((e) => e.subtasks.map((s) => ({ e, s })))
    .filter(({ s }) => s.id !== ownId)
    .map(({ s }) => `- ${s.id} (${s.owner}): ${s.title}`);
  return [
    `Company goal: ${record.goal}`,
    plan.summary ? `Plan summary: ${plan.summary}` : "",
    `Your epic: ${epic.id} — ${epic.title}${epic.goal ? `: ${epic.goal}` : ""}`,
    `Epic acceptance criteria:\n${epic.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
    others.length ? `Other work in this plan, owned by teammates (don't duplicate it):\n${others.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Turns an approved plan into tasks: one per subtask (owned by its staff
 * member, depending on the tasks for its dependsOn subtasks) plus one
 * integration task per epic (owned by its lead, depending on every subtask
 * in the epic). Writes the created task ids back into the plan.
 */
export function materializePlan(record: WorkPlanRecord, projectConfig?: ProjectConfig): TaskRecord[] {
  if (!record.epics) throw new Error("plan has no epics to materialize");
  const plan: WorkPlan = { summary: record.summary ?? "", epics: record.epics };
  const tasks: TaskRecord[] = [];
  const taskIdBySubtask = new Map<string, string>();
  const pending: { task: TaskRecord; deps: string[] }[] = [];

  for (const epic of plan.epics) {
    for (const s of epic.subtasks) {
      const task = createPlannedTask(
        {
          title: `${s.id} · ${s.title}`,
          slotId: s.owner,
          ideaBrief: s.description,
          acceptanceCriteria: s.acceptanceCriteria,
          sharedBrief: sharedBriefFor(record, plan, epic, s.id),
          planRef: { planId: record.id, epicId: epic.id, subtaskId: s.id },
        },
        projectConfig,
      );
      s.taskId = task.id;
      taskIdBySubtask.set(s.id, task.id);
      pending.push({ task, deps: s.dependsOn });
      tasks.push(task);
    }
  }
  for (const { task, deps } of pending) {
    task.dependsOn = deps.map((d) => taskIdBySubtask.get(d)!).filter(Boolean);
  }

  for (const epic of plan.epics) {
    const task = createPlannedTask(
      {
        title: `${epic.id} · Nghiệm thu & tích hợp: ${epic.title}`,
        slotId: epic.owner,
        ideaBrief:
          `Integrate and verify epic ${epic.id} (${epic.title}) as a whole: make the subtasks' outputs (see upstream handoffs) work together, ` +
          "fix any seams between them, and add integration tests proving the epic's acceptance criteria end to end. Do not rebuild what the subtasks already delivered.",
        acceptanceCriteria: epic.acceptanceCriteria,
        sharedBrief: sharedBriefFor(record, plan, epic),
        planRef: { planId: record.id, epicId: epic.id },
      },
      projectConfig,
    );
    task.dependsOn = epic.subtasks.map((s) => s.taskId!).filter(Boolean);
    epic.taskId = task.id;
    tasks.push(task);
  }
  return tasks;
}
