import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkPlanRecord } from "../orchestrator/planner.js";
import { writeFileAtomic } from "./atomicWrite.js";

const PLAN_DIR = path.resolve(process.cwd(), "data/plans");

export async function savePlan(plan: WorkPlanRecord): Promise<void> {
  await mkdir(PLAN_DIR, { recursive: true });
  plan.updatedAt = new Date().toISOString();
  await writeFileAtomic(path.join(PLAN_DIR, `${plan.id}.json`), JSON.stringify(plan, null, 2));
}

export async function loadPlan(id: string): Promise<WorkPlanRecord | undefined> {
  const file = path.join(PLAN_DIR, `${id}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(await readFile(file, "utf8")) as WorkPlanRecord;
  } catch {
    return undefined;
  }
}
