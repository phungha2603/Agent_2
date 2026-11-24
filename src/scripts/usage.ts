import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CallRecord } from "../agents/limited.js";
import type { TaskRecord } from "../types.js";
import { formatUsage, summarizeUsage } from "../orchestrator/usageReport.js";

/** Where the tokens went: reads data/calls/*.jsonl and data/tasks/*.json and prints a summary. */
async function readAll<T>(dir: string, parse: (text: string) => T[]): Promise<T[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const f of files) {
    try {
      out.push(...parse(await readFile(path.join(dir, f), "utf8")));
    } catch {
      // a half-written file shouldn't hide the rest
    }
  }
  return out;
}

const calls = await readAll<CallRecord>(path.resolve("data/calls"), (t) =>
  t.split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as CallRecord];
    } catch {
      return [];
    }
  }),
);
const tasks = new Map((await readAll<TaskRecord>(path.resolve("data/tasks"), (t) => [JSON.parse(t) as TaskRecord])).map((t) => [t.id, t]));

if (!calls.length) {
  console.log("Chưa có dữ liệu trong data/calls — chạy vài task trước rồi thử lại.");
} else {
  console.log(formatUsage(summarizeUsage(calls, tasks)));
}
