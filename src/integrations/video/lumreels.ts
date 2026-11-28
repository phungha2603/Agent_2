import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Script } from "./types.js";

/**
 * LumReels (github.com/lumtekvn/lumreels, MIT) as a second way to build an
 * explainer: Claude writes each scene as HTML/SVG/WebGL motion graphics in
 * one of ~100 styles, HyperFrames renders a 9:16 MP4 with music, sound
 * effects and a VieNeu voice. It runs as its own local server; with `dir`
 * set the dashboard starts it on demand, with self-update switched off so
 * no code arrives that nobody looked at.
 *
 * The approved script goes in as a numbered "read verbatim" block, and
 * after the render the narration LumReels actually wrote is compared with
 * it, so the CEO sees any drift before approving the video.
 */

export interface LumreelsTemplate {
  id: string;
  name: string;
  blurb: string;
  category: string;
  genre: string;
  technique: string[];
  narration: boolean;
}

export interface LumreelsJob {
  id: string;
  status: string;
  error?: string | null;
}

export interface LumreelsClient {
  readonly baseUrl: string;
  templates(): Promise<LumreelsTemplate[]>;
  voices(): Promise<string[]>;
  createJob(input: { templateId: string; content: string; durationS: number; voice: string; model: string }): Promise<LumreelsJob>;
  job(id: string): Promise<LumreelsJob>;
  download(id: string, outPath: string): Promise<void>;
  thumb(templateId: string): Promise<Response>;
  /** The narration lines LumReels wrote for a job, when its folder is on this machine. */
  narration(id: string): Promise<string[] | undefined>;
  close(): void;
}

export function createLumreels(opts: { baseUrl?: string; dir?: string; python?: string; fetchImpl?: typeof fetch; startTimeoutSec?: number }): LumreelsClient {
  const base = (opts.baseUrl ?? "http://127.0.0.1:4400").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  let child: ChildProcess | null = null;
  let starting: Promise<void> | null = null;
  let cachedTemplates: LumreelsTemplate[] | undefined;

  const healthy = () => f(`${base}/api/config`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

  async function ensureServer(): Promise<void> {
    if (await healthy()) return;
    if (!opts.dir) throw new Error(`LumReels không chạy ở ${base}. Đặt LUMREELS_DIR để dashboard tự bật, hoặc chạy: cd <lumreels> && LUMREELS_SKIP_UPDATE=1 node server/server.mjs`);
    starting ??= (async () => {
      const url = new URL(base);
      child = spawn(process.execPath, ["server/server.mjs"], {
        cwd: opts.dir,
        env: {
          ...process.env,
          PORT: url.port || "4400",
          LUMREELS_SKIP_UPDATE: "1",
          ...(opts.python ? { LUMREELS_PYTHON: opts.python } : {}),
        },
        stdio: "ignore",
      });
      child.on("exit", () => (child = null));
      const until = Date.now() + (opts.startTimeoutSec ?? 60) * 1000;
      while (Date.now() < until) {
        if (await healthy()) return;
        if (!child) throw new Error("LumReels thoát ngay khi khởi động — chạy tay `node server/server.mjs` trong thư mục lumreels để xem lỗi.");
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("LumReels không sẵn sàng sau thời gian chờ.");
    })().finally(() => (starting = null));
    await starting;
  }

  async function json<T>(p: string, init?: RequestInit): Promise<T> {
    await ensureServer();
    const res = await f(`${base}${p}`, init);
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`LumReels ${res.status}: ${body.error ?? "lỗi không rõ"}`);
    return body;
  }

  return {
    baseUrl: base,
    async templates() {
      cachedTemplates ??= (await json<any[]>("/api/templates"))
        .filter((t) => t.hasGuidance !== false)
        .map((t) => ({ id: t.id, name: t.name, blurb: t.blurb ?? "", category: t.category ?? "", genre: t.genre ?? "", technique: t.technique ?? [], narration: Boolean(t.narration) }));
      return cachedTemplates;
    },
    async voices() {
      const o = await json<{ voices?: { id: string; engine?: string }[] }>("/api/audio/options");
      return (o.voices ?? []).filter((v) => v.engine === "vieneu").map((v) => v.id);
    },
    async createJob(input) {
      return json<LumreelsJob>("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: input.templateId,
          content: input.content,
          durationS: input.durationS,
          model: input.model,
          source: "agent2",
          audio: { music: "auto", voice: input.voice, sfx: true },
        }),
      });
    },
    job(id) {
      return json<LumreelsJob>(`/api/jobs/${encodeURIComponent(id)}`);
    },
    async download(id, outPath) {
      await ensureServer();
      const res = await f(`${base}/jobs/${encodeURIComponent(id)}/out.mp4`);
      if (!res.ok) throw new Error(`Không tải được video từ LumReels (${res.status})`);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    },
    async thumb(templateId) {
      await ensureServer();
      return f(`${base}/thumbs/${encodeURIComponent(templateId)}.webp`);
    },
    async narration(id) {
      if (!opts.dir || !/^[\w-]+$/.test(id)) return undefined;
      try {
        const a = JSON.parse(await readFile(path.join(opts.dir, "jobs", id, "scene", "audio.json"), "utf8"));
        return (a?.voice?.lines ?? []).map((l: { text?: string }) => String(l.text ?? ""));
      } catch {
        return undefined;
      }
    },
    close() {
      child?.kill("SIGTERM");
    },
  };
}

/** What LumReels gets: the approved lines to read verbatim, numbered, plus the on-screen words. */
export function lumreelsContent(script: Script): string {
  const lines = script.scenes.flatMap((s) => s.lines.map((l) => l.text.trim())).filter(Boolean);
  const words = script.scenes.map((s) => s.onScreenText).filter(Boolean);
  return [
    `Tiêu đề: ${script.title}`,
    "",
    "LỜI ĐỌC — đọc NGUYÊN VĂN từng câu dưới đây, đúng thứ tự, không thêm, không bớt, không đổi chữ. Mỗi câu là một dòng trong voice.lines. Chữ và hình trên màn hình minh hoạ đúng câu đang đọc:",
    ...lines.map((t, i) => `${i + 1}. ${t}`),
    ...(words.length ? ["", `Chữ nổi bật trên màn hình (tuỳ chọn): ${words.join(" · ")}`] : []),
  ]
    .join("\n")
    .slice(0, 4000); // LumReels' limit
}

/**
 * Seconds of video for the narration: VieNeu reads about 4.5 syllables a
 * second, and a Vietnamese word is one syllable; each line also needs a
 * short breath, and the end a moment to land.
 */
export function lumreelsDuration(script: Script): number {
  const lines = script.scenes.flatMap((s) => s.lines.map((l) => l.text));
  const syllables = lines.reduce((n, t) => n + t.split(/\s+/).filter(Boolean).length, 0);
  return Math.max(10, Math.min(600, Math.ceil(syllables / 4.5 + lines.length * 0.5 + 2)));
}

/** Share of approved lines LumReels read word for word (punctuation and case ignored). */
export function narrationMatch(script: Script, read: string[]): number {
  const norm = (t: string) => t.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const want = script.scenes.flatMap((s) => s.lines.map((l) => norm(l.text))).filter(Boolean);
  const got = new Set(read.map(norm));
  return want.length ? want.filter((w) => got.has(w)).length / want.length : 1;
}
