import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpStatusError, createKeyPool, withKeyRotation, withRetry } from "../../agents/retry.js";
import { encodeWav, parseWav, solidPng } from "./media.js";
import type { VideoFormat } from "./types.js";

// ---------------- voice ----------------

export interface Voice {
  name: string;
  gender: string;
  /** e.g. "Nam · Bắc · Phong cách kể chuyện"; "Giọng nhái" for a cloned voice. */
  label?: string;
}

export interface TtsProvider {
  readonly kind: "vieneu" | "mock";
  /** Synthesises one line to a WAV file (LINEAR16). */
  synthesize(text: string, voice: string, outPath: string): Promise<void>;
  voices(): Promise<Voice[]>;
  /** Registers a cloned voice from a 3–8 s reference clip (VieNeu only). */
  addVoice?(name: string, clip: Buffer, ext: string): Promise<void>;
  close?(): void;
}

/**
 * VieNeu-TTS v3 Turbo (github.com/pnnbao97/VieNeu-TTS, Apache-2.0), run on
 * this machine through its OpenAI-compatible server — no key, no fee.
 * With `dir` set, the server is started on demand from that checkout and
 * stopped with the dashboard.
 *
 * Cloned voices live only in the server's memory, so their clips are kept in
 * `voicesDir` and enrolled again whenever the server doesn't know the name
 * (first use after a restart).
 */
export function createVieneuTts(opts: { baseUrl?: string; dir?: string; voicesDir: string; apiKey?: string; startTimeoutSec?: number }): TtsProvider {
  const base = (opts.baseUrl ?? "http://127.0.0.1:8765").replace(/\/$/, "");
  const auth: Record<string, string> = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  let child: ChildProcess | null = null;
  let starting: Promise<void> | null = null;
  const enrolled = new Set<string>();

  const healthy = () => fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);

  async function ensureServer(): Promise<void> {
    if (await healthy()) return;
    if (!opts.dir) throw new Error(`VieNeu-TTS không chạy ở ${base}. Bật nó: cd <thư mục VieNeu-TTS> && PORT=${new URL(base).port} uv run python -m apps.openai_speech — hoặc đặt VIENEU_DIR để dashboard tự bật.`);
    starting ??= (async () => {
      const url = new URL(base);
      child = spawn("uv", ["run", "python", "-m", "apps.openai_speech"], {
        cwd: opts.dir,
        env: { ...process.env, HOST: url.hostname, PORT: url.port || "8765", VIENEU_BACKEND: process.env.VIENEU_BACKEND ?? "onnx" },
        stdio: "ignore",
      });
      child.on("exit", () => {
        child = null;
        enrolled.clear();
      });
      const until = Date.now() + (opts.startTimeoutSec ?? 300) * 1000;
      while (Date.now() < until) {
        if (await healthy()) return;
        if (!child) throw new Error("VieNeu-TTS thoát ngay khi khởi động — chạy tay lệnh trong thư mục VieNeu-TTS để xem lỗi.");
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error("VieNeu-TTS không sẵn sàng sau thời gian chờ.");
    })().finally(() => (starting = null));
    await starting;
  }

  const clipFor = async (name: string) => {
    for (const ext of ["wav", "mp3", "m4a", "flac", "ogg"]) {
      const p = path.join(opts.voicesDir, `${name}.${ext}`);
      if (await readFile(p).then(() => true, () => false)) return p;
    }
    return undefined;
  };

  async function enroll(name: string, clip: Buffer, ext: string): Promise<void> {
    const form = new FormData();
    form.set("name", name);
    form.set("file", new Blob([new Uint8Array(clip)]), `clip.${ext}`);
    const res = await fetch(`${base}/v1/voices`, { method: "POST", headers: auth, body: form });
    if (!res.ok) throw new Error(`VieNeu không nhận được giọng mẫu (${res.status}): ${(await res.text()).slice(0, 300)}`);
    enrolled.add(name);
  }

  async function speak(text: string, voice: string): Promise<Response> {
    return fetch(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ input: text, voice: voice || undefined, response_format: "wav", sample_rate: 48000 }),
    });
  }

  return {
    kind: "vieneu",
    async synthesize(text, voice, outPath) {
      await ensureServer();
      const clip = voice ? await clipFor(voice) : undefined;
      if (clip && !enrolled.has(voice)) await enroll(voice, await readFile(clip), path.extname(clip).slice(1));
      let res = await withRetry(async () => {
        const r = await speak(text, voice);
        if (r.status === 429) throw new HttpStatusError(429, "VieNeu đang bận");
        return r;
      });
      if (res.status === 400 && clip) {
        // The server restarted since we enrolled: enroll again, once.
        await enroll(voice, await readFile(clip), path.extname(clip).slice(1));
        res = await speak(text, voice);
      }
      if (!res.ok) throw new Error(`VieNeu lỗi ${res.status}: ${(await res.text()).slice(0, 300)}`);
      // The streamed WAV header claims an unknown length; rewrite it with the real one.
      const pcm = parseWav(Buffer.from(await res.arrayBuffer()));
      if (!pcm.data.length) throw new Error("VieNeu trả về âm thanh rỗng");
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, encodeWav(pcm));
    },
    async voices() {
      await ensureServer();
      const res = await fetch(`${base}/v1/voices`, { headers: auth });
      if (!res.ok) throw new Error(`VieNeu voices lỗi ${res.status}`);
      const body = (await res.json()) as { data?: { id: string; gender?: string; description?: string }[] };
      const preset = (body.data ?? []).map((v) => ({ name: v.id, gender: (v.gender ?? "").toUpperCase(), label: v.description || undefined }));
      const own = await readdir(opts.voicesDir).catch(() => [] as string[]);
      const cloned = own
        .map((f) => f.replace(/\.(wav|mp3|m4a|flac|ogg)$/, ""))
        .filter((n) => !preset.some((p) => p.name === n))
        .map((name) => ({ name, gender: "", label: "Giọng nhái" }));
      return [...cloned, ...preset];
    },
    async addVoice(name, clip, ext) {
      await ensureServer();
      await enroll(name, clip, ext);
      await mkdir(opts.voicesDir, { recursive: true });
      await writeFile(path.join(opts.voicesDir, `${name}.${ext}`), clip);
    },
    close() {
      child?.kill("SIGTERM");
    },
  };
}

/** Silent clips as long as the line would take to say (~14 characters a second): the flow and the render run end to end. */
export function createMockTts(): TtsProvider {
  return {
    kind: "mock",
    async synthesize(text, _voice, outPath) {
      const seconds = Math.max(1.2, text.length / 14);
      const sampleRate = 24000;
      const data = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, encodeWav({ sampleRate, channels: 1, bitsPerSample: 16, data }));
    },
    async voices() {
      return [
        { name: "mock-female", gender: "FEMALE" },
        { name: "mock-male", gender: "MALE" },
      ];
    },
  };
}

// ---------------- images ----------------

export interface ImageProvider {
  readonly kind: "gemini" | "mflux" | "openverse" | "mock";
  /** Writes one image for the prompt (AI) or search words (stock) to outPath; refs = reference portraits for consistency. */
  generate(prompt: string, outPath: string, opts: { format: VideoFormat; refs?: string[] }): Promise<string>;
  close?(): void;
}

const ASPECT: Record<VideoFormat, string> = { short: "9:16", long: "16:9" };

/**
 * Gemini native image generation, with reference images passed as inline
 * parts so a series' characters keep their faces. Image output is a paid
 * feature on most accounts (about USD 0.04 an image at the time of
 * writing) — the dashboard says so next to the option.
 */
export function createGeminiImages(opts: { apiKeys: string[]; model?: string }): ImageProvider {
  const model = opts.model ?? "gemini-2.5-flash-image";
  const pool = createKeyPool(opts.apiKeys);
  // Set false after the first 400 that names imageConfig: an older model without aspect-ratio support.
  let sendAspect = true;
  return {
    kind: "gemini",
    async generate(prompt, outPath, { format, refs = [] }) {
      pool.rotate();
      const refParts = await Promise.all(
        refs.map(async (p) => ({ inlineData: { mimeType: p.endsWith(".jpg") || p.endsWith(".jpeg") ? "image/jpeg" : "image/png", data: (await readFile(p)).toString("base64") } })),
      );
      const text = refs.length ? `${prompt}\n\nThe attached images are the reference look of the characters: keep their faces, hair and clothes exactly the same.` : prompt;
      const call = (withAspect: boolean) =>
        withRetry(() =>
          withKeyRotation(pool, async (apiKey) => {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [...refParts, { text }] }],
                generationConfig: { responseModalities: ["IMAGE"], ...(withAspect ? { imageConfig: { aspectRatio: ASPECT[format] } } : {}) },
              }),
            });
            if (!res.ok) throw new HttpStatusError(res.status, `Gemini image error ${res.status}: ${(await res.text()).slice(0, 400)}`);
            return (await res.json()) as any;
          }),
        );
      let data: any;
      try {
        data = await call(sendAspect);
      } catch (err) {
        if (!(sendAspect && (err as HttpStatusError).status === 400 && /imageConfig|aspect/i.test(String((err as Error).message)))) throw err;
        sendAspect = false;
        data = await call(false);
      }
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const img = parts.find((p) => p?.inlineData?.data);
      if (!img) throw new Error(`Gemini returned no image${parts.some((p) => p?.text) ? `: ${parts.map((p) => p?.text).join(" ").slice(0, 200)}` : ""}`);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, Buffer.from(img.inlineData.data, "base64"));
      return outPath;
    },
  };
}

/**
 * FLUX.2-klein-4B (Apache-2.0) through mflux (MIT), on this Mac's GPU — no
 * key, no fee. One Python worker keeps the model loaded (8-bit, ~8 GB) and
 * draws one image at a time; reference portraits keep a series' faces.
 * The worker starts on the first image and stops with the dashboard.
 */
export function createMfluxImages(opts: { python: string; script: string; quantize?: number; steps?: number; size?: Record<VideoFormat, [number, number]> }): ImageProvider {
  const size = opts.size ?? { long: [1280, 720], short: [720, 1280] };
  let child: ChildProcess | null = null;
  let ready: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  let chain: Promise<unknown> = Promise.resolve();
  let stderrTail = "";

  function start(): Promise<void> {
    ready ??= new Promise<void>((resolve, reject) => {
      const proc = spawn(opts.python, [opts.script], {
        env: { ...process.env, MFLUX_QUANTIZE: String(opts.quantize ?? 8), PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = proc;
      proc.on("error", (err) => {
        ready = null;
        reject(new Error(`Không chạy được mflux (${err.message}). Cài: uv tool install mflux, hoặc đặt MFLUX_PYTHON.`));
      });
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (c: string) => (stderrTail = (stderrTail + c).slice(-2000)));
      let buf = "";
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: { ready?: boolean; id?: number; ok?: boolean; error?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.ready) resolve();
          const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
          if (waiter) {
            pending.delete(msg.id!);
            msg.ok ? waiter.resolve() : waiter.reject(new Error(`mflux: ${msg.error ?? "lỗi không rõ"}`));
          }
        }
      });
      proc.on("exit", (code) => {
        child = null;
        ready = null;
        const err = new Error(`mflux dừng (mã ${code}). ${stderrTail.trim().split("\n").slice(-3).join(" ")}`);
        reject(err);
        for (const w of pending.values()) w.reject(err);
        pending.clear();
      });
    });
    return ready;
  }

  return {
    kind: "mflux",
    generate(prompt, outPath, { format, refs = [] }) {
      // One image at a time: the GPU is shared, and a second request would only wait inside the worker.
      const job = chain.then(async () => {
        await start();
        await mkdir(path.dirname(outPath), { recursive: true });
        const [width, height] = size[format];
        const id = nextId++;
        const done = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
        // A seed from the prompt: the same scene redraws the same picture.
        const seed = [...prompt].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 2_147_483_647;
        child!.stdin!.write(JSON.stringify({ id, prompt, width, height, seed, steps: opts.steps ?? 4, refs, out: outPath }) + "\n");
        await done;
        return outPath;
      });
      chain = job.catch(() => {});
      return job;
    },
    close() {
      child?.kill("SIGTERM");
    },
  };
}

/**
 * Openverse (WordPress): openly licensed images, no key. Only CC0 and public
 * domain are requested, so a picture can go into a monetized video without
 * attribution or licence conditions.
 */
export function createOpenverseImages(opts: { fetchImpl?: typeof fetch } = {}): ImageProvider {
  const f = opts.fetchImpl ?? fetch;
  const used = new Set<string>();
  return {
    kind: "openverse",
    async generate(query, outPath, { format }) {
      const params = new URLSearchParams({ q: query, license: "cc0,pdm", aspect_ratio: format === "short" ? "tall" : "wide", page_size: "20", mature: "false" });
      const search = async (p: URLSearchParams) => {
        const res = await withRetry(async () => {
          const r = await f(`https://api.openverse.org/v1/images/?${p}`, { headers: { "User-Agent": "auto-video/1.0" } });
          if (!r.ok) throw new HttpStatusError(r.status, `Openverse lỗi ${r.status}: ${(await r.text()).slice(0, 200)}`);
          return (await r.json()) as { results?: { id: string; url: string; width?: number }[] };
        });
        return res.results ?? [];
      };
      let results = await search(params);
      if (!results.length) {
        // Tall photos are rare; any orientation is cropped to fit.
        params.delete("aspect_ratio");
        results = await search(params);
      }
      // Openverse matches every word, so a long description finds nothing: drop words from the front until it does.
      for (const q of shorterQueries(query)) {
        if (results.length) break;
        params.set("q", q);
        results = await search(params);
      }
      const ranked = results.filter((r) => !used.has(r.id)).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
      for (const pick of ranked) {
        const img = await f(pick.url).catch(() => undefined);
        if (!img?.ok || !(img.headers.get("content-type") ?? "").startsWith("image/")) continue;
        used.add(pick.id);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, Buffer.from(await img.arrayBuffer()));
        return outPath;
      }
      throw new Error(`Openverse không có ảnh CC0 cho "${query}" — sửa mô tả hình của cảnh, hoặc dùng ảnh AI.`);
    },
  };
}

const STOP_WORDS = new Set(["a", "an", "the", "of", "in", "on", "at", "with", "and", "to", "for", "from", "by", "is", "are", "looking", "showing"]);

/** "a curious person looking at the night sky" → "curious person night sky", "person night sky", "night sky", "sky". */
export function shorterQueries(query: string): string[] {
  const words = query.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((w) => w && !STOP_WORDS.has(w));
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const q = words.slice(i).join(" ");
    if (q !== query.trim().toLowerCase()) out.push(q);
  }
  return out;
}

export function createMockImages(): ImageProvider {
  const palette: [number, number, number][] = [
    [52, 73, 94],
    [39, 96, 84],
    [120, 72, 54],
    [74, 63, 110],
  ];
  let i = 0;
  return {
    kind: "mock",
    async generate(_prompt, outPath, { format }) {
      await mkdir(path.dirname(outPath), { recursive: true });
      const [w, h] = format === "short" ? [90, 160] : [160, 90];
      await writeFile(outPath, solidPng(w, h, palette[i++ % palette.length]));
      return outPath;
    },
  };
}
