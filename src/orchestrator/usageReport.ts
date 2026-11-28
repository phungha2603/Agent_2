import type { CallRecord } from "../agents/limited.js";
import type { TaskRecord } from "../types.js";

export interface UsageRow {
  calls: number;
  input: number;
  output: number;
  costUsd: number;
}

export interface BigCall {
  tokens: number;
  engine: string;
  stage: string;
  title: string;
  promptChars: number;
  outputChars: number;
}

export interface UsageSummary {
  total: UsageRow;
  byStage: Record<string, UsageRow>;
  byEngine: Record<string, UsageRow>;
  /** Tasks ranked by tokens spent, so one runaway task stands out. */
  byTask: { title: string; row: UsageRow }[];
  biggest: BigCall[];
}

const empty = (): UsageRow => ({ calls: 0, input: 0, output: 0, costUsd: 0 });
function add(row: UsageRow, c: CallRecord): void {
  row.calls++;
  row.input += c.usage.inputTokens;
  row.output += c.usage.outputTokens;
  row.costUsd += c.usage.costUsd ?? 0;
}

/** The stage a call belongs to: the task run whose time window contains it. */
function stageOf(c: CallRecord, task: TaskRecord | undefined): string {
  if (c.taskId.startsWith("plan:")) return "plan";
  if (c.taskId === "rebalance") return "rebalance";
  const at = Date.parse(c.startedAt);
  const run = (task?.runs ?? []).find((r) => !r.human && Date.parse(r.startedAt) <= at && at <= (r.endedAt ? Date.parse(r.endedAt) : Infinity));
  return run?.stage ?? "?";
}

export function summarizeUsage(calls: CallRecord[], tasks: Map<string, TaskRecord>, topN = 8): UsageSummary {
  const out: UsageSummary = { total: empty(), byStage: {}, byEngine: {}, byTask: [], biggest: [] };
  const perTask = new Map<string, { title: string; row: UsageRow }>();
  const all: BigCall[] = [];
  for (const c of calls) {
    const task = tasks.get(c.taskId);
    const stage = stageOf(c, task);
    add(out.total, c);
    add((out.byStage[stage] ??= empty()), c);
    add((out.byEngine[c.engine] ??= empty()), c);
    const title = task?.context.title ?? (c.taskId.startsWith("plan:") ? "Kế hoạch của Sếp" : c.taskId);
    add((perTask.get(c.taskId) ?? perTask.set(c.taskId, { title, row: empty() }).get(c.taskId)!).row, c);
    all.push({ tokens: c.usage.inputTokens + c.usage.outputTokens, engine: c.engine, stage, title, promptChars: c.prompt.length, outputChars: c.output.length });
  }
  out.byTask = [...perTask.values()].sort((a, b) => b.row.input + b.row.output - (a.row.input + a.row.output)).slice(0, topN);
  out.biggest = all.sort((a, b) => b.tokens - a.tokens).slice(0, topN);
  return out;
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function formatUsage(s: UsageSummary): string {
  const total = s.total.input + s.total.output || 1;
  const table = (rows: [string, UsageRow][]) =>
    rows
      .sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output))
      .map(([name, r]) => `  ${name.padEnd(22)} ${String(r.calls).padStart(5)} lượt  ${k(r.input).padStart(8)} vào  ${k(r.output).padStart(8)} ra  ${String(Math.round(((r.input + r.output) / total) * 100)).padStart(3)}%${r.costUsd ? `  $${r.costUsd.toFixed(2)}` : ""}`)
      .join("\n");
  return [
    `Tổng: ${s.total.calls} lượt gọi · ${k(s.total.input)} token vào · ${k(s.total.output)} token ra${s.total.costUsd ? ` · $${s.total.costUsd.toFixed(2)}` : ""}`,
    "",
    "Theo bước:",
    table(Object.entries(s.byStage)),
    "",
    "Theo engine:",
    table(Object.entries(s.byEngine)),
    "",
    "Task tốn nhiều nhất:",
    s.byTask.map((t) => `  ${k(t.row.input + t.row.output).padStart(8)}  ${t.row.calls} lượt  ${t.title.slice(0, 70)}`).join("\n"),
    "",
    "Lượt gọi nặng nhất:",
    s.biggest.map((b) => `  ${k(b.tokens).padStart(8)}  ${b.engine.padEnd(7)} ${b.stage.padEnd(20)} prompt ${k(b.promptChars)} ký tự · ${b.title.slice(0, 50)}`).join("\n"),
    "",
    "Ghi chú: Muse không báo số token nên được ước tính theo độ dài chữ; Claude CLI đếm cả phần bộ nhớ đệm.",
  ].join("\n");
}
