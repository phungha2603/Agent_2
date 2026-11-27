import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { TaskRecord } from "../types.js";
import { writeFileAtomic } from "./atomicWrite.js";

const DATA_DIR = path.resolve(process.cwd(), "data/tasks");

export function newTaskId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  // The random part matters when a plan creates many tasks in the same
  // millisecond whose titles slugify to the same thing (non-ASCII titles
  // mostly collapse to dashes).
  const rand = Math.random().toString(36).slice(2, 6);
  return `${Date.now()}-${rand}-${slug || "task"}`;
}

export async function saveTask(task: TaskRecord): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  task.updatedAt = new Date().toISOString();
  await writeFileAtomic(path.join(DATA_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
}

export async function loadTask(id: string): Promise<TaskRecord> {
  const raw = await readFile(path.join(DATA_DIR, `${id}.json`), "utf8");
  return JSON.parse(raw) as TaskRecord;
}

export function taskExists(id: string): boolean {
  return existsSync(path.join(DATA_DIR, `${id}.json`));
}

/** Every task ever saved (including ones no longer in any queue) — for history-wide reports. */
export async function listAllTasks(): Promise<TaskRecord[]> {
  const names = await readdir(DATA_DIR).catch(() => [] as string[]);
  const out: TaskRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(path.join(DATA_DIR, name), "utf8")) as TaskRecord);
    } catch {
      // a half-written or corrupted file is skipped, not fatal for a report
    }
  }
  return out;
}
