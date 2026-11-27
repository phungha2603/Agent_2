import { spawn, execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../store/atomicWrite.js";
import { UserError } from "../orchestrator/scheduler.js";

/**
 * The Auto Content SEO project (a Python Telegram bot that writes SEO
 * articles into Google Drive) as a dashboard tab: run its pipeline directly
 * from a form, and start/stop the Telegram bot. Everything runs the
 * project's own code with its own .venv and .env; this only starts
 * processes and records what they report.
 */

export type RunStatus = "running" | "done" | "partial" | "quota" | "failed" | "stopped";

export interface ContentRun {
  id: string;
  startedAt: string;
  endedAt?: string;
  domain: string;
  keyword: string;
  links: string[];
  status: RunStatus;
  /** The pipeline's progress messages, as the Telegram bot would have sent them. */
  progress: { at: string; text: string }[];
  folderUrl?: string;
  /** "12/15" from the final message, when it says. */
  result?: string;
  error?: string;
}

export interface ContentSeoCheck {
  ok: boolean;
  error?: string | null;
  model?: string;
  articles?: number;
  checkedAt: string;
}

export interface ContentSeoSnapshot {
  dir: string;
  check: ContentSeoCheck | null;
  current: ContentRun | null;
  runs: ContentRun[];
  bot: { running: boolean; pid?: number; startedAt?: string; log: string[] };
}

const MAX_RUNS = 50;
const MAX_LOG = 200;
const DRIVE_RE = /https:\/\/drive\.google\.com\/\S+/;

function nowIso(): string {
  return new Date().toISOString();
}

/** What a finished run amounted to, read from the pipeline's own last message. */
export function classifyRun(progress: string[], exitCode: number | null): { status: RunStatus; result?: string } {
  const last = [...progress].reverse();
  if (last.some((t) => t.startsWith("🛑"))) {
    const m = last.map((t) => t.match(/Đã tạo xong (\d+\/\d+)/)).find(Boolean);
    return { status: "quota", result: m?.[1] };
  }
  const partial = last.map((t) => t.match(/Hoàn tất với (\d+\/\d+)/)).find(Boolean);
  if (partial) return { status: "partial", result: partial[1] };
  const done = last.map((t) => t.match(/Đã tạo (\d+) bài/)).find(Boolean);
  if (done) return { status: "done", result: `${done[1]}/${done[1]}` };
  return { status: exitCode === 0 ? "done" : "failed" };
}

export class ContentSeoService extends EventEmitter {
  private readonly python: string;
  private readonly runsFile: string;
  private runs: ContentRun[] = [];
  private child: ChildProcess | null = null;
  private current: ContentRun | null = null;
  private bot: ChildProcess | null = null;
  private botStartedAt?: string;
  private botLog: string[] = [];
  private lastCheck: ContentSeoCheck | null = null;

  constructor(
    readonly dir: string,
    opts: { python?: string; dataDir?: string } = {},
  ) {
    super();
    this.python = opts.python ?? path.join(dir, ".venv", "bin", "python");
    this.runsFile = path.join(opts.dataDir ?? path.resolve(process.cwd(), "data", "contentseo"), "runs.json");
  }

  async init(): Promise<void> {
    try {
      this.runs = JSON.parse(await readFile(this.runsFile, "utf8"));
    } catch {
      this.runs = [];
    }
    // A run that was in progress when the dashboard stopped did not finish.
    for (const r of this.runs) {
      if (r.status === "running") Object.assign(r, { status: "stopped", endedAt: r.endedAt ?? nowIso(), error: "Dashboard đã dừng khi lượt này đang chạy." });
    }
    void this.check();
  }

  snapshot(): ContentSeoSnapshot {
    return {
      dir: this.dir,
      check: this.lastCheck,
      current: this.current,
      runs: this.runs.slice(0, MAX_RUNS),
      bot: { running: Boolean(this.bot), pid: this.bot?.pid, startedAt: this.botStartedAt, log: this.botLog.slice(-60) },
    };
  }

  /** `run_once.py --check`: .env complete, libraries installed, Google token present — no Gemini or Drive call. */
  check(): Promise<ContentSeoCheck> {
    return new Promise((resolve) => {
      execFile(this.python, ["scripts/run_once.py", "--check"], { cwd: this.dir, timeout: 60_000 }, (err, stdout) => {
        let res: ContentSeoCheck;
        try {
          const line = stdout.trim().split("\n").pop() ?? "";
          const parsed = JSON.parse(line);
          res = { ok: Boolean(parsed.ok), error: parsed.error, model: parsed.model, articles: parsed.articles, checkedAt: nowIso() };
        } catch {
          res = { ok: false, error: err ? `Không chạy được ${this.python}: ${err.message.slice(0, 200)}` : "Kết quả kiểm tra không đọc được", checkedAt: nowIso() };
        }
        this.lastCheck = res;
        this.emit("change");
        resolve(res);
      });
    });
  }

  /** Runs the pipeline once (one at a time: Gemini's free tier would throttle two). */
  async startRun(input: { domain?: string; keyword?: string; links?: string[] | string }): Promise<ContentRun> {
    if (this.current) throw new UserError("Đang có một lượt tạo bài chạy — đợi nó xong hoặc dừng nó trước.");
    const domain = (input.domain ?? "").trim();
    const keyword = (input.keyword ?? "").trim();
    const raw = Array.isArray(input.links) ? input.links : (input.links ?? "").split(/\s+/);
    const links = raw.map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
    if (!domain || !keyword || !links.length) throw new UserError("Cần domain, key và ít nhất 1 link bắt đầu bằng http.");

    const run: ContentRun = { id: `run-${Date.now()}`, startedAt: nowIso(), domain, keyword, links, status: "running", progress: [] };
    this.current = run;
    this.runs.unshift(run);
    await this.save();
    this.emit("change");

    const child = spawn(this.python, ["scripts/run_once.py", JSON.stringify({ domain, keyword, links })], { cwd: this.dir });
    this.child = child;
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onRunLine(run, line);
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr = (stderr + c).slice(-4000)));
    child.on("close", async (code) => {
      if (buf.trim()) this.onRunLine(run, buf.trim());
      const stoppedByUser = run.status === "stopped";
      if (!stoppedByUser) {
        const { status, result } = classifyRun(run.progress.map((p) => p.text), code);
        run.status = run.error ? "failed" : status;
        run.result = result;
        if (run.status === "failed" && !run.error) run.error = stderr.trim().split("\n").slice(-3).join("\n") || `Thoát với mã ${code}`;
      }
      run.endedAt = nowIso();
      this.current = null;
      this.child = null;
      await this.save().catch(() => {});
      this.emit("change");
      this.emit("finished", run);
    });
    return run;
  }

  private onRunLine(run: ContentRun, line: string): void {
    let msg: { type?: string; text?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      msg = { type: "progress", text: line }; // a stray print from the project's code
    }
    if (msg.type === "error") run.error = msg.text;
    if (msg.text) {
      run.progress.push({ at: nowIso(), text: msg.text });
      const url = msg.text.match(DRIVE_RE)?.[0];
      if (url) run.folderUrl = url;
    }
    this.emit("change");
  }

  stopRun(): void {
    if (!this.child || !this.current) throw new UserError("Không có lượt tạo bài nào đang chạy.");
    this.current.status = "stopped";
    this.current.error = "Bạn đã dừng lượt này. Chạy lại cùng domain/key/link thì chỉ tạo bù các bài còn thiếu.";
    this.child.kill("SIGTERM");
  }

  startBot(): void {
    if (this.bot) throw new UserError("Bot Telegram đang chạy rồi.");
    const bot = spawn(this.python, ["main.py"], { cwd: this.dir });
    this.bot = bot;
    this.botStartedAt = nowIso();
    this.botLog = [`[${new Date().toLocaleTimeString("vi-VN")}] Bắt đầu bot (pid ${bot.pid}).`];
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) this.botLog.push(line);
      if (this.botLog.length > MAX_LOG) this.botLog.splice(0, this.botLog.length - MAX_LOG);
      this.emit("change");
    };
    bot.stdout.on("data", onData);
    bot.stderr.on("data", onData);
    // "exit", not "close": close waits for every process sharing the bot's
    // output to end, so a bot that spawned helpers would look alive after it died.
    bot.on("exit", (code, signal) => {
      this.botLog.push(`[${new Date().toLocaleTimeString("vi-VN")}] Bot đã dừng (${signal ?? `mã ${code}`}).`);
      this.bot = null;
      this.botStartedAt = undefined;
      this.emit("change");
    });
    this.emit("change");
  }

  stopBot(): void {
    if (!this.bot) throw new UserError("Bot Telegram không chạy.");
    this.bot.kill("SIGTERM");
  }

  /** The dashboard is shutting down: its child processes go with it. */
  close(): void {
    this.child?.kill("SIGTERM");
    this.bot?.kill("SIGTERM");
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.runsFile), { recursive: true });
    await writeFileAtomic(this.runsFile, JSON.stringify(this.runs.slice(0, MAX_RUNS), null, 2));
  }
}
