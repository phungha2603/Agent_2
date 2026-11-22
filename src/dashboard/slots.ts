import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Stage } from "../types.js";

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

/** Where each slot's assigned task lives, persisted across server restarts. */
export type DashboardState = Record<string, string | null>; // slotId -> taskId | null

const STATE_PATH = path.resolve(process.cwd(), "data/dashboard.json");

export async function loadDashboardState(): Promise<DashboardState> {
  if (!existsSync(STATE_PATH)) {
    const empty: DashboardState = Object.fromEntries(SLOTS.map((s) => [s.id, null]));
    return empty;
  }
  const raw = await readFile(STATE_PATH, "utf8");
  const parsed = JSON.parse(raw) as DashboardState;
  for (const s of SLOTS) if (!(s.id in parsed)) parsed[s.id] = null;
  return parsed;
}

export async function saveDashboardState(state: DashboardState): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
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
