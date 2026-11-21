import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { TaskRecord } from "../types.js";

const DATA_DIR = path.resolve(process.cwd(), "data/tasks");

export function newTaskId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return `${Date.now()}-${slug || "task"}`;
}

export async function saveTask(task: TaskRecord): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  task.updatedAt = new Date().toISOString();
  await writeFile(path.join(DATA_DIR, `${task.id}.json`), JSON.stringify(task, null, 2), "utf8");
}

export async function loadTask(id: string): Promise<TaskRecord> {
  const raw = await readFile(path.join(DATA_DIR, `${id}.json`), "utf8");
  return JSON.parse(raw) as TaskRecord;
}

export function taskExists(id: string): boolean {
  return existsSync(path.join(DATA_DIR, `${id}.json`));
}
