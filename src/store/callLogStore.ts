import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CallRecord } from "../agents/limited.js";

const LOG_DIR = path.resolve(process.cwd(), "data/calls");

/** One file per task (or plan): full prompts and outputs are large, so they stay out of the task record. */
function fileFor(id: string): string {
  return path.join(LOG_DIR, `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);
}

export async function appendCall(record: CallRecord): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(fileFor(record.taskId), `${JSON.stringify(record)}\n`, "utf8");
}

export async function readCalls(id: string): Promise<CallRecord[]> {
  const file = fileFor(id);
  if (!existsSync(file)) return [];
  const out: CallRecord[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line cut off by a crash mid-append — skip it, keep the rest.
    }
  }
  return out;
}
