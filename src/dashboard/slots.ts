import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Stage } from "../types.js";
import { writeFileAtomic } from "../store/atomicWrite.js";

export interface SlotDef {
  id: string; // "AG-01"
  name: string;
  icon: string;
  /** Org-chart rank: 1 = boss (exactly one), 2 = team lead, 3 = staff. */
  tier: 1 | 2 | 3;
}

export const TIER_LABELS: Record<1 | 2 | 3, string> = {
  1: "Sếp",
  2: "Trưởng nhóm",
  3: "Nhân viên",
};

/**
 * Ten fixed department slots, ranked into 3 tiers. AG-01 is the sole tier-1
 * "boss": when "Chạy luồng cả công ty" is used, the company-wide goal is
 * handed to it, and it (via decomposeGoalForDepartments) writes a specific
 * sub-goal for every other slot instead of everyone getting the same text.
 * Running a slot on its own (the "Chạy riêng khung này" button) is
 * unaffected by tier — any slot can still be run individually with
 * whatever goal is typed into the shared input.
 */
export const SLOTS: SlotDef[] = [
  { id: "AG-01", name: "AI Product Lead", icon: "🚀", tier: 1 },
  { id: "AG-02", name: "AI Market Researcher", icon: "🔍", tier: 2 },
  { id: "AG-05", name: "AI Backend Architect", icon: "🏗️", tier: 2 },
  { id: "AG-08", name: "AI QA & Security", icon: "🛡️", tier: 2 },
  { id: "AG-03", name: "AI Data Engineer", icon: "🗄️", tier: 3 },
  { id: "AG-04", name: "AI Data Scientist", icon: "🧠", tier: 3 },
  { id: "AG-06", name: "AI Frontend / 3D UI", icon: "🖥️", tier: 3 },
  { id: "AG-07", name: "AI Automation Ops", icon: "⚙️", tier: 3 },
  { id: "AG-09", name: "AI Content & SEO", icon: "📢", tier: 3 },
  { id: "AG-10", name: "AI Release Manager", icon: "🚩", tier: 3 },
];

/**
 * Which tasks each slot holds (oldest first) and which plan, if any, the
 * boss is currently showing — persisted across server restarts.
 */
export interface Directive {
  id: string;
  /** null = for the whole company. */
  slotId: string | null;
  text: string;
  at: string;
}

export interface DashboardState {
  slots: Record<string, string[]>;
  activePlanId: string | null;
  /** Slots whose results only hand off after the CEO approves them (approval gates). */
  gates: Record<string, boolean>;
  directives: Directive[];
  paused: boolean;
}

/** QA/security and release are the natural gates; the CEO can toggle any slot. */
export const DEFAULT_GATED_SLOTS = ["AG-08", "AG-10"];

const STATE_PATH = path.resolve(process.cwd(), "data/dashboard.json");

function emptyState(): DashboardState {
  return {
    slots: Object.fromEntries(SLOTS.map((s) => [s.id, []])),
    activePlanId: null,
    gates: Object.fromEntries(SLOTS.map((s) => [s.id, DEFAULT_GATED_SLOTS.includes(s.id)])),
    directives: [],
    paused: false,
  };
}

/**
 * Accepts both the current shape and the old one (a flat slotId -> taskId |
 * null map, one task per slot), so an existing data/dashboard.json keeps its
 * assignments after upgrading.
 */
function normalize(parsed: any): DashboardState {
  const state = emptyState();
  const isV2 = parsed && typeof parsed === "object" && parsed.slots && typeof parsed.slots === "object";
  const source: Record<string, unknown> = isV2 ? parsed.slots : (parsed ?? {});
  for (const s of SLOTS) {
    const v = source[s.id];
    state.slots[s.id] = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];
  }
  state.activePlanId = isV2 && typeof parsed.activePlanId === "string" ? parsed.activePlanId : null;
  if (isV2 && parsed.gates && typeof parsed.gates === "object") {
    for (const s of SLOTS) if (typeof parsed.gates[s.id] === "boolean") state.gates[s.id] = parsed.gates[s.id];
  }
  if (isV2 && Array.isArray(parsed.directives)) {
    state.directives = parsed.directives.filter((d: any) => d && typeof d.text === "string" && typeof d.id === "string");
  }
  state.paused = isV2 && parsed.paused === true;
  return state;
}

export async function loadDashboardState(): Promise<DashboardState> {
  if (!existsSync(STATE_PATH)) {
    return emptyState();
  }
  const raw = await readFile(STATE_PATH, "utf8");
  try {
    return normalize(JSON.parse(raw));
  } catch (err) {
    // A corrupted or empty file (e.g. the process was killed mid-write
    // before writes went through writeFileAtomic) should degrade to "no
    // slots assigned" rather than crash the whole dashboard server on
    // every single request. The next save overwrites it with valid JSON.
    console.error(`data/dashboard.json is corrupted (${(err as Error).message}) — treating it as empty.`);
    return emptyState();
  }
}

export async function saveDashboardState(state: DashboardState): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2));
}

const STAGE_ORDER: Stage[] = [
  "ideation",
  "checkpoint_idea",
  "architecture",
  "architecture_review",
  "implementation",
  "verification",
  "review_gemini",
  "review_claude",
  "checkpoint_final",
  "done",
];

export interface SlotStatus {
  label: string; // badge text, e.g. "Running"
  colorClass: "blue" | "yellow" | "green" | "purple" | "red" | "gray";
  progress: number; // 0-100
}

export function deriveStatus(stage: Stage | undefined): SlotStatus {
  if (!stage) return { label: "Idle", colorClass: "gray", progress: 0 };
  if (stage === "rejected") return { label: "Blocked", colorClass: "red", progress: 100 };
  if (stage === "done") return { label: "Done", colorClass: "green", progress: 100 };

  const index = STAGE_ORDER.indexOf(stage);
  const progress = index >= 0 ? Math.round(((index + 1) / STAGE_ORDER.length) * 100) : 0;

  switch (stage) {
    case "ideation":
    case "architecture":
      return { label: "Planning", colorClass: "blue", progress };
    case "architecture_review":
      return { label: "Design Review", colorClass: "blue", progress };
    case "checkpoint_idea":
    case "checkpoint_final":
      return { label: "Waiting", colorClass: "yellow", progress };
    case "implementation":
      return { label: "Running", colorClass: "green", progress };
    case "verification":
    case "review_gemini":
    case "review_claude":
      return { label: "Testing", colorClass: "purple", progress };
    default:
      return { label: "Idle", colorClass: "gray", progress };
  }
}
