/** What the boss sees about one queued/unfinished task when rebalancing. */
export interface LoadTask {
  id: string;
  title: string;
  stage: string;
  queueState: string;
  brief: string;
  /** Slots whose output this task is still waiting for. */
  waitingOn: string[];
  /** Slots that consume this task's output. */
  unblocks: string[];
  movable: boolean;
}

export interface LoadSlot {
  id: string;
  name: string;
  tier: 1 | 2 | 3;
  /** Team name, when the company has teams. */
  team?: string;
  parallel: number;
  running: number;
  queued: number;
  waitingYou: number;
  tasks: LoadTask[];
}

export interface RebalanceMove {
  taskId: string;
  title: string;
  from: string;
  to: string;
  position: "top" | "bottom";
  kind: "reassign" | "priority";
  reason: string;
}

export interface RebalanceProposal {
  id: string;
  status: "drafting" | "ready" | "failed" | "applied" | "dismissed";
  createdAt: string;
  summary: string;
  moves: RebalanceMove[];
  /** Moves the validator dropped and why, plus anything skipped at apply time. */
  notes: string[];
  error?: string;
  applied?: number;
}

export const MAX_MOVES = 6;
export const LOAD_MARKER = "LOAD_JSON:";

export function buildRebalancePrompt(slots: LoadSlot[]): string {
  return [
    "REBALANCE: You are the boss (AG-01) of this AI company. Look at each staff member's current load and unfinished tasks below, and propose reassignments or reprioritizations that get the overall goal done sooner without hurting quality.",
    "Rules:",
    "- Only move tasks marked \"movable\": true. Never move anything to AG-01.",
    "- Specialty first: give a task to someone whose role fits the work. A shorter queue alone is NOT a reason to hand data engineering to a content writer.",
    "- Each slot's \"team\" is the team it belongs to: prefer moving work to someone in the same team; cross a team only when no one in the team has the specialty, and say so in the reason.",
    "- To reprioritize inside one queue, use \"to\" = the task's current slot with \"position\": \"top\" — worth it when that task unblocks others (see \"unblocks\") or the queue ahead of it is waiting on input anyway.",
    "- A task that is waiting on input can still move; it will keep waiting for the same input in its new queue.",
    `- At most ${MAX_MOVES} moves. If the current distribution is already fine, return an empty "moves" list and say so.`,
    "- Every move needs a concrete reason: specialty fit, the load numbers, and/or what it unblocks.",
    "- Write \"summary\" and every \"reason\" in Vietnamese.",
    "Reply with ONLY one JSON object, no prose before or after:",
    '{"summary": "...", "moves": [{"taskId": "...", "to": "AG-xx", "position": "top" | "bottom", "reason": "..."}]}',
    "",
    LOAD_MARKER,
    JSON.stringify(slots, null, 1),
  ].join("\n");
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in the reply");
  return text.slice(start, end + 1);
}

/**
 * Parses the boss's reply and keeps only moves that can actually be applied.
 * Anything it drops — an unknown or running task, a target that doesn't
 * exist or is the boss, a move to where the task already sits — is listed
 * in `notes` so the CEO sees exactly what was filtered and why.
 */
export function parseRebalance(text: string, slots: LoadSlot[]): { summary: string; moves: RebalanceMove[]; notes: string[] } {
  let raw: any;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (err) {
    throw new Error(`reply was not valid JSON (${(err as Error).message})`);
  }
  const tasks = new Map<string, { task: LoadTask; slot: LoadSlot }>();
  for (const slot of slots) for (const task of slot.tasks) tasks.set(task.id, { task, slot });
  const slotIds = new Set(slots.filter((s) => s.tier !== 1).map((s) => s.id));

  const moves: RebalanceMove[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(raw?.moves) ? raw.moves : []) {
    const taskId = typeof m?.taskId === "string" ? m.taskId.trim() : "";
    const to = typeof m?.to === "string" ? m.to.trim() : "";
    const found = tasks.get(taskId);
    if (!found) {
      notes.push(`Bỏ đề xuất cho task không tồn tại (${taskId || "trống"}).`);
      continue;
    }
    const label = `"${found.task.title}"`;
    if (!found.task.movable) {
      notes.push(`Bỏ đề xuất cho ${label}: task đang chạy hoặc đã xong, không gán lại được.`);
      continue;
    }
    if (!slotIds.has(to)) {
      notes.push(`Bỏ đề xuất chuyển ${label} sang ${to || "(trống)"}: không phải nhân sự nhận việc hợp lệ.`);
      continue;
    }
    if (seen.has(taskId)) {
      notes.push(`Bỏ đề xuất trùng cho ${label}.`);
      continue;
    }
    const position = m?.position === "top" ? "top" : "bottom";
    if (to === found.slot.id && position === "bottom") {
      notes.push(`Bỏ đề xuất cho ${label}: không thay đổi gì (cùng nhân sự, cuối hàng đợi).`);
      continue;
    }
    seen.add(taskId);
    moves.push({
      taskId,
      title: found.task.title,
      from: found.slot.id,
      to,
      position,
      kind: to === found.slot.id ? "priority" : "reassign",
      reason: typeof m?.reason === "string" && m.reason.trim() ? m.reason.trim() : "(Sếp không nêu lý do)",
    });
    if (moves.length >= MAX_MOVES) break;
  }
  return { summary: typeof raw?.summary === "string" ? raw.summary.trim() : "", moves, notes };
}
