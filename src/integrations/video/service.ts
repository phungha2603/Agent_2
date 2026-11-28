import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "../../types.js";
import { UserError } from "../../orchestrator/scheduler.js";
import { writeFileAtomic } from "../../store/atomicWrite.js";
import { captionChunks, concatPcm, encodeWav, parseWav, wavDurationSec, type Pcm } from "./media.js";
import type { ImageProvider, TtsProvider, Voice } from "./providers.js";
import type { Publisher } from "./publish.js";
import type { Renderer } from "./render.js";
import { biblePrompt, mockWriter, outlinePrompt, parseBible, parseScript, researchPrompt, scriptPrompt, spokenWords } from "./script.js";
import type { Character, Niche, SceneAsset, Script, Series, VideoFormat, VideoJob, VideoStage } from "./types.js";

/**
 * The Auto Video tab. One job at a time moves through
 *   researching → writing → script_review (CEO) → producing → rendering
 *   → final_review (CEO) → publishing → published
 * and stops at the two CEO gates. Nothing is uploaded without the CEO
 * pressing "Đăng" on a video they have watched.
 *
 * Files: data/video/{jobs,series}.json, data/video/jobs/<id>/ (audio,
 * images, final.mp4, thumbnail.png), data/video/series/<id>/ (portraits).
 * Generated files are named by a hash of what produced them, so a retry or a
 * rewrite reuses every image that didn't change instead of paying for it again.
 */

export type ImageSource = "ai" | "stock";

export interface VideoDeps {
  dataDir?: string;
  /** null = the mock writer (no Gemini/Claude configured). */
  gemini: Agent | null;
  claude: Agent | null;
  tts: TtsProvider;
  images: { ai?: ImageProvider; stock?: ImageProvider };
  renderer: Renderer;
  publisher: Publisher;
  defaultVoice: string;
  explainerStyle?: string;
  defaultPrivacy?: "public" | "unlisted" | "private";
}

export type JobWithSource = VideoJob & { imageSource: ImageSource; failedStage?: VideoStage; /** Explainer narrator; empty = default. */ voice?: string };

const AUTO_STAGES: VideoStage[] = ["researching", "writing", "producing", "rendering", "publishing"];
const MAX_PROGRESS = 200;
const LINE_GAP_SEC = 0.3;
const SCENE_TAIL_SEC = 0.45;
const FILE_RE = /^[\w.-]+\.(png|jpg|jpeg|wav|mp4)$/;

const now = () => new Date().toISOString();
const hash = (...parts: string[]) => createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 12);
const exists = (p: string) => access(p).then(() => true, () => false);

export class VideoService extends EventEmitter {
  readonly dataDir: string;
  private jobs: JobWithSource[] = [];
  private series: Series[] = [];
  private queue: string[] = [];
  private running: { id: string; abort: AbortController } | null = null;
  private busySeries = new Set<string>();

  constructor(private readonly deps: VideoDeps) {
    super();
    this.dataDir = deps.dataDir ?? path.resolve(process.cwd(), "data", "video");
  }

  // ---------------- storage ----------------

  async init(): Promise<void> {
    this.jobs = await this.readJson("jobs.json", []);
    this.series = await this.readJson("series.json", []);
    for (const j of this.jobs) {
      if (AUTO_STAGES.includes(j.stage)) Object.assign(j, { failedStage: j.stage, stage: "failed", error: "Dashboard đã dừng khi video này đang xử lý. Bấm Chạy lại để tiếp tục từ bước đó." });
    }
  }

  private async readJson<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path.join(this.dataDir, name), "utf8"));
    } catch {
      return fallback;
    }
  }

  private saving: Promise<void> = Promise.resolve();

  /** Saves one after another: the worker and a dashboard request can save at the same moment, and two writes would share a temp file name. */
  private save(): Promise<void> {
    const next = this.saving.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      await writeFileAtomic(path.join(this.dataDir, "jobs.json"), JSON.stringify(this.jobs, null, 2));
      await writeFileAtomic(path.join(this.dataDir, "series.json"), JSON.stringify(this.series, null, 2));
      this.emit("change");
    });
    this.saving = next.catch(() => {});
    return next;
  }

  jobDir(id: string): string {
    return path.join(this.dataDir, "jobs", id);
  }

  private seriesDir(id: string): string {
    return path.join(this.dataDir, "series", id);
  }

  /** Absolute path of a job or series file the dashboard may serve; undefined for anything else. */
  filePath(kind: "job" | "series", id: string, name: string): string | undefined {
    if (!FILE_RE.test(name) || !/^[\w-]+$/.test(id)) return undefined;
    const known = kind === "job" ? this.jobs.some((j) => j.id === id) : this.series.some((s) => s.id === id);
    return known ? path.join(kind === "job" ? this.jobDir(id) : this.seriesDir(id), name) : undefined;
  }

  // ---------------- snapshot ----------------

  snapshot() {
    return {
      config: {
        writer: this.deps.claude && this.deps.gemini ? "real" : "mock",
        tts: this.deps.tts.kind,
        images: { ai: this.deps.images.ai?.kind ?? null, stock: this.deps.images.stock?.kind ?? null },
        youtube: this.deps.publisher.youtubeReady,
        facebook: this.deps.publisher.facebookReady,
        defaultPrivacy: this.deps.defaultPrivacy ?? "private",
        defaultVoice: this.deps.defaultVoice,
      },
      running: this.running?.id ?? null,
      queued: [...this.queue],
      series: this.series,
      busySeries: [...this.busySeries],
      jobs: this.jobs.slice(0, 100).map((j) => ({ ...j, progress: j.progress.slice(-40), words: j.script ? spokenWords(j.script) : 0 })),
    };
  }

  voices(): Promise<Voice[]> {
    return this.deps.tts.voices();
  }

  /** A cloned voice from a 3–8 s clip of someone who agreed to it — usually the owner's own voice. */
  async addVoice(name: string, clip: Buffer, ext: string): Promise<void> {
    const tts = this.deps.tts;
    if (!tts.addVoice) throw new UserError("Chỉ VieNeu-TTS nhái được giọng (VIDEO_TTS=vieneu).");
    const clean = name.trim().normalize("NFC"); // VieNeu checks names with Python's \w, which rejects combining marks
    if (!/^[\p{L}\p{N}][\p{L}\p{N}\p{M}_ .-]{0,63}$/u.test(clean)) throw new UserError("Tên giọng: 1–64 chữ, số, dấu cách, '.', '-' hoặc '_'.");
    if (!["wav", "mp3", "m4a", "flac", "ogg"].includes(ext)) throw new UserError("File ghi âm phải là wav, mp3, m4a, flac hoặc ogg.");
    if (clip.length < 20_000) throw new UserError("File ghi âm quá ngắn — cần 3–8 giây nói rõ.");
    const existing = await tts.voices().catch(() => [] as Voice[]);
    if (existing.some((v) => v.name === clean && v.label !== "Giọng nhái")) throw new UserError(`"${clean}" trùng tên một giọng có sẵn.`);
    await tts.addVoice(clean, clip, ext);
    this.emit("change");
  }

  // ---------------- series ----------------

  async createSeries(input: { premise?: string; genre?: string; style?: string; format?: string }): Promise<Series> {
    const premise = (input.premise ?? "").trim();
    const genre = (input.genre ?? "").trim() || "phiêu lưu";
    if (premise.length < 20) throw new UserError("Mô tả ý tưởng phim ít nhất vài câu (từ 20 ký tự).");
    const format = parseFormat(input.format);
    const voices = await this.voices().catch(() => [] as Voice[]);
    const draft = this.deps.claude
      ? await this.askJson(this.deps.claude, biblePrompt({ premise, genre, style: input.style?.trim(), voices: voices.map((v) => `${v.name} — ${v.gender}`) }), "Series bible", parseBible)
      : mockWriter.bible(premise);
    const known = new Set(voices.map((v) => v.name));
    const pick = (v?: string) => (v && known.has(v) ? v : undefined);
    const series: Series = {
      id: `series-${Date.now()}`,
      title: draft.title || premise.slice(0, 40),
      premise,
      genre,
      style: input.style?.trim() || draft.style || "2D anime, soft cel shading, warm muted palette",
      format,
      narratorVoice: pick(draft.narratorVoice),
      characters: draft.characters.map((c) => ({ ...c, voice: pick(c.voice) })),
      createdAt: now(),
    };
    this.series.unshift(series);
    await this.save();
    return series;
  }

  async updateSeries(id: string, patch: Partial<Pick<Series, "title" | "premise" | "genre" | "style" | "format" | "narratorVoice" | "characters">>): Promise<Series> {
    const s = this.needSeries(id);
    if (patch.characters !== undefined) {
      if (!Array.isArray(patch.characters) || !patch.characters.length) throw new UserError("Phim cần ít nhất một nhân vật.");
      const names = new Set<string>();
      s.characters = patch.characters.map((c: Partial<Character>, i) => {
        const name = String(c?.name ?? "").trim();
        const look = String(c?.look ?? "").trim();
        if (!name || !look) throw new UserError(`Nhân vật ${i + 1} cần tên và ngoại hình.`);
        if (names.has(name)) throw new UserError(`Trùng tên nhân vật: ${name}`);
        names.add(name);
        const old = s.characters.find((o) => o.name === name);
        // A changed look makes the old portrait wrong.
        const refImage = old && old.look === look ? old.refImage : undefined;
        return { name, look, personality: String(c?.personality ?? "").trim(), voice: String(c?.voice ?? "").trim() || undefined, refImage };
      });
    }
    for (const k of ["title", "premise", "genre", "style", "narratorVoice"] as const) {
      if (typeof patch[k] === "string") (s as any)[k] = (patch[k] as string).trim() || (k === "narratorVoice" ? undefined : (s as any)[k]);
    }
    if (patch.format) s.format = parseFormat(patch.format);
    await this.save();
    return s;
  }

  /** One reference portrait per character, used as an input image for every scene they appear in. */
  async makePortraits(id: string): Promise<Series> {
    const s = this.needSeries(id);
    const ai = this.deps.images.ai;
    if (!ai) throw new UserError("Chưa có nguồn ảnh AI (VIDEO_IMAGES=mflux).");
    if (this.busySeries.has(id)) throw new UserError("Đang tạo ảnh nhân vật cho phim này.");
    this.busySeries.add(id);
    this.emit("change");
    try {
      for (const c of s.characters) {
        if (c.refImage && (await exists(path.join(this.seriesDir(id), c.refImage)))) continue;
        const name = `char-${hash(c.name, c.look, s.style)}.png`;
        await ai.generate(
          `Character reference portrait of ${c.name}: ${c.look}. Front view, head and shoulders, neutral expression, plain light background. Art style: ${s.style}. No text, signature or watermark.`,
          path.join(this.seriesDir(id), name),
          { format: "long" },
        );
        c.refImage = name;
        await this.save();
      }
    } finally {
      this.busySeries.delete(id);
      this.emit("change");
    }
    return s;
  }

  private needSeries(id: string): Series {
    const s = this.series.find((x) => x.id === id);
    if (!s) throw new UserError("Không tìm thấy phim này.");
    return s;
  }

  // ---------------- jobs ----------------

  async createExplainer(input: { topic?: string; format?: string; notes?: string; imageSource?: string; voice?: string }): Promise<VideoJob> {
    const topic = (input.topic ?? "").trim();
    if (topic.length < 4) throw new UserError("Nhập chủ đề cần giải thích.");
    return this.addJob({ niche: "explainer", topic, format: parseFormat(input.format), notes: input.notes, imageSource: this.pickSource(input.imageSource, "explainer"), voice: input.voice?.trim() || undefined });
  }

  async createEpisode(seriesId: string, input: { topic?: string; notes?: string; format?: string }): Promise<VideoJob> {
    const s = this.needSeries(seriesId);
    const episodes = this.jobs.filter((j) => j.seriesId === s.id && j.stage !== "stopped");
    const episode = Math.max(0, ...episodes.map((j) => j.episode ?? 0)) + 1;
    return this.addJob({
      niche: "series",
      seriesId: s.id,
      episode,
      topic: (input.topic ?? "").trim(),
      notes: input.notes,
      format: input.format ? parseFormat(input.format) : s.format,
      imageSource: this.pickSource("ai", "series"),
    });
  }

  private pickSource(wanted: string | undefined, niche: Niche): ImageSource {
    const { ai, stock } = this.deps.images;
    if (niche === "series") {
      if (!ai) throw new UserError("Phim dài tập cần ảnh AI: đặt VIDEO_IMAGES=mflux (hoặc mock để thử).");
      return "ai";
    }
    if (wanted === "ai" && ai) return "ai";
    if (wanted === "stock" && stock) return "stock";
    if (stock) return "stock";
    if (ai) return "ai";
    throw new UserError("Chưa có nguồn ảnh: bật Openverse (mặc định) hoặc đặt VIDEO_IMAGES=mflux.");
  }

  private async addJob(fields: Pick<JobWithSource, "niche" | "topic" | "format" | "imageSource"> & Partial<JobWithSource>): Promise<VideoJob> {
    const job: JobWithSource = {
      id: `vid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      stage: "researching",
      feedback: [],
      publish: {},
      progress: [],
      createdAt: now(),
      updatedAt: now(),
      ...fields,
      notes: fields.notes?.trim() || undefined,
    };
    this.jobs.unshift(job);
    this.log(job, fields.niche === "series" ? `Tạo tập ${job.episode}.` : "Tạo video giải thích.");
    await this.save();
    this.enqueue(job.id);
    return job;
  }

  /** CEO's call on the script: approve → produce; revise → rewrite with the note; reject → stop. */
  async decideScript(id: string, action: string, feedback?: string): Promise<void> {
    const job = this.needJob(id);
    if (job.stage !== "script_review") throw new UserError("Video này không ở bước duyệt kịch bản.");
    if (action === "approve") {
      this.setStage(job, "producing", "Bạn đã duyệt kịch bản.");
    } else if (action === "revise") {
      const note = (feedback ?? "").trim();
      if (!note) throw new UserError("Ghi rõ cần sửa gì trong kịch bản.");
      job.feedback.push(note);
      this.setStage(job, "writing", `Yêu cầu sửa: ${note}`);
    } else if (action === "reject") {
      this.setStage(job, "stopped", "Bạn đã bỏ kịch bản này.");
    } else throw new UserError("action phải là approve, revise hoặc reject");
    await this.save();
    if (action !== "reject") this.enqueue(id);
  }

  /** CEO's call on the rendered video: revise → back to the script with the note; reject → stop. Publishing is publish(). */
  async decideFinal(id: string, action: string, feedback?: string): Promise<void> {
    const job = this.needJob(id);
    if (job.stage !== "final_review") throw new UserError("Video này không ở bước duyệt video.");
    if (action === "revise") {
      const note = (feedback ?? "").trim();
      if (!note) throw new UserError("Ghi rõ cần sửa gì.");
      job.feedback.push(note);
      this.setStage(job, "writing", `Yêu cầu sửa sau khi xem: ${note}`);
      await this.save();
      this.enqueue(id);
    } else if (action === "reject") {
      this.setStage(job, "stopped", "Bạn đã bỏ video này.");
      await this.save();
    } else throw new UserError("action phải là revise hoặc reject");
  }

  async publish(id: string, opts: { youtube?: boolean; facebook?: boolean; privacy?: string }): Promise<void> {
    const job = this.needJob(id);
    const again = job.stage === "published" || (job.stage === "failed" && job.failedStage === "publishing");
    if (job.stage !== "final_review" && !again) throw new UserError("Chỉ đăng được video đã dựng xong và bạn đã xem.");
    const targets = { youtube: Boolean(opts.youtube) && !job.publish.youtube?.id, facebook: Boolean(opts.facebook) && !job.publish.facebook?.id };
    if (!targets.youtube && !targets.facebook) throw new UserError("Chọn ít nhất một nơi đăng chưa đăng.");
    if (targets.youtube && !this.deps.publisher.youtubeReady) throw new UserError("YouTube chưa cấu hình.");
    if (targets.facebook && !this.deps.publisher.facebookReady) throw new UserError("Facebook chưa cấu hình.");
    const privacy = opts.privacy === "public" || opts.privacy === "unlisted" || opts.privacy === "private" ? opts.privacy : (this.deps.defaultPrivacy ?? "private");
    (job as any).pendingPublish = { ...targets, privacy };
    this.setStage(job, "publishing", `Đăng ${[targets.youtube && "YouTube", targets.facebook && "Facebook"].filter(Boolean).join(" + ")} (${privacy}).`);
    await this.save();
    this.enqueue(id);
  }

  async retry(id: string): Promise<void> {
    const job = this.needJob(id);
    if (job.stage !== "failed") throw new UserError("Chỉ chạy lại được video đang lỗi.");
    this.setStage(job, job.failedStage ?? "researching", "Chạy lại.");
    job.error = undefined;
    await this.save();
    this.enqueue(id);
  }

  async stop(id: string): Promise<void> {
    const job = this.needJob(id);
    if (["published", "stopped"].includes(job.stage)) throw new UserError("Video này đã kết thúc.");
    this.queue = this.queue.filter((q) => q !== id);
    if (this.running?.id === id) this.running.abort.abort();
    this.setStage(job, "stopped", "Bạn đã dừng video này.");
    await this.save();
  }

  async remove(id: string): Promise<void> {
    const job = this.needJob(id);
    if (!["stopped", "failed"].includes(job.stage)) throw new UserError("Chỉ xoá được video đã dừng hoặc lỗi.");
    this.jobs = this.jobs.filter((j) => j !== job);
    await this.save();
  }

  async refreshStats(id: string): Promise<void> {
    const job = this.needJob(id);
    const p = this.deps.publisher;
    const yt = job.publish.youtube;
    const fb = job.publish.facebook;
    const errors: string[] = [];
    if (yt?.id) yt.views = await p.youtubeViews(yt.id).catch((e) => (errors.push(String(e.message)), yt.views));
    if (fb?.id) fb.views = await p.facebookViews(fb.id).catch((e) => (errors.push(String(e.message)), fb.views));
    for (const post of [yt, fb]) if (post) post.statsAt = now();
    await this.save();
    if (errors.length) throw new UserError(errors.join(" · "));
  }

  private needJob(id: string): JobWithSource {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new UserError("Không tìm thấy video này.");
    return j;
  }

  // ---------------- worker ----------------

  private enqueue(id: string): void {
    if (!this.queue.includes(id) && this.running?.id !== id) this.queue.push(id);
    this.emit("change");
    void this.pump();
  }

  /** One job at a time: free tiers (Gemini, TTS) and the renderer would only slow each other down. */
  private async pump(): Promise<void> {
    if (this.running) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return void this.pump();
    const abort = new AbortController();
    this.running = { id, abort };
    this.emit("change");
    try {
      while (AUTO_STAGES.includes(job.stage) && !abort.signal.aborted) {
        await this.step(job, abort.signal);
        await this.save();
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        job.failedStage = job.stage;
        job.error = (err as Error).message;
        this.setStage(job, "failed", `Lỗi ở bước ${job.failedStage}: ${job.error}`);
        this.emit("finished", job);
      }
      await this.save().catch(() => {});
    } finally {
      this.running = null;
      this.emit("change");
      void this.pump();
    }
  }

  private async step(job: JobWithSource, signal: AbortSignal): Promise<void> {
    switch (job.stage) {
      case "researching":
        return this.research(job, signal);
      case "writing":
        return this.write(job, signal);
      case "producing":
        return this.produce(job, signal);
      case "rendering":
        return this.renderJob(job, signal);
      case "publishing":
        return this.publishJob(job);
    }
  }

  private async research(job: JobWithSource, signal: AbortSignal): Promise<void> {
    const series = job.seriesId ? this.needSeries(job.seriesId) : undefined;
    this.log(job, series ? "Gemini đang viết dàn ý tập phim…" : "Gemini đang nghiên cứu chủ đề…");
    if (!this.deps.gemini) {
      job.research = series ? mockWriter.outline(job) : mockWriter.research(job);
    } else {
      const prompt = series ? outlinePrompt(job, series, this.previousEpisodes(series.id, job.episode ?? 1)) : researchPrompt(job);
      const res = await this.deps.gemini.send(prompt, { title: job.topic || `Tập ${job.episode}` }, { signal });
      if (!res.content.trim()) throw new Error("Gemini trả lời rỗng.");
      job.research = res.content.trim();
    }
    if (signal.aborted) return;
    this.setStage(job, "writing", series ? "Xong dàn ý." : "Xong bản nghiên cứu.");
  }

  private async write(job: JobWithSource, signal: AbortSignal): Promise<void> {
    const series = job.seriesId ? this.needSeries(job.seriesId) : undefined;
    this.log(job, job.script ? "Claude đang viết lại kịch bản theo yêu cầu…" : "Claude đang viết kịch bản…");
    const speakers = series?.characters.map((c) => c.name);
    const script = this.deps.claude
      ? await this.askJson(
          this.deps.claude,
          scriptPrompt({ job, series, brief: job.research ?? "", imageSource: job.imageSource, previousScript: job.script }),
          job.topic || `Tập ${job.episode}`,
          (t) => parseScript(t, speakers),
          signal,
        )
      : mockWriter.script(job, series);
    if (signal.aborted) return;
    job.script = script;
    this.setStage(job, "script_review", `Kịch bản xong: ${script.scenes.length} cảnh, ${spokenWords(script)} từ. Chờ bạn duyệt.`);
    this.emit("finished", job);
  }

  private async produce(job: JobWithSource, signal: AbortSignal): Promise<void> {
    const script = job.script!;
    const series = job.seriesId ? this.needSeries(job.seriesId) : undefined;
    const dir = this.jobDir(job.id);
    await mkdir(dir, { recursive: true });
    const images = job.imageSource === "stock" ? this.deps.images.stock : this.deps.images.ai;
    if (!images) throw new Error(`Nguồn ảnh "${job.imageSource}" không còn được cấu hình.`);
    const assets: SceneAsset[] = [];
    for (const [i, scene] of script.scenes.entries()) {
      if (signal.aborted) return;
      this.log(job, `Cảnh ${i + 1}/${script.scenes.length}: giọng đọc + ảnh…`);
      // Voice: one clip per line, joined with a short pause; captions are exact at line boundaries.
      const clips: Pcm[] = [];
      for (const line of scene.lines) {
        const voice = series ? this.voiceFor(line.speaker, series) : job.voice || this.deps.defaultVoice;
        const name = `line-${hash(this.deps.tts.kind, voice, line.text)}.wav`;
        const file = path.join(dir, name);
        if (!(await exists(file))) await this.deps.tts.synthesize(line.text, voice, file);
        clips.push(parseWav(await readFile(file)));
      }
      const { pcm, starts } = concatPcm(clips, LINE_GAP_SEC);
      const tail = Buffer.alloc(Math.round(SCENE_TAIL_SEC * pcm.sampleRate) * pcm.channels * (pcm.bitsPerSample / 8));
      const sceneAudio = { ...pcm, data: Buffer.concat([pcm.data, tail]) };
      const audio = `scene-${i + 1}-${hash(...clips.map((c) => String(c.data.length)), ...scene.lines.map((l) => l.text))}.wav`;
      await writeFile(path.join(dir, audio), encodeWav(sceneAudio));
      const captions = scene.lines.flatMap((l, k) => captionChunks(l.text, starts[k], wavDurationSec(clips[k]), job.format === "short" ? 5 : 8));

      // Picture: named by what produced it, so an unchanged scene is never paid for twice.
      const { prompt, refs } = this.imagePrompt(scene.visual, scene.lines.map((l) => l.speaker), job, series);
      const ext = images.kind === "openverse" ? "jpg" : "png";
      const image = `img-${hash(images.kind, prompt, job.format, ...refs)}.${ext}`;
      if (!(await exists(path.join(dir, image)))) await images.generate(prompt, path.join(dir, image), { format: job.format, refs });

      assets.push({ audio, image, durationSec: Math.round(wavDurationSec(sceneAudio) * 1000) / 1000, captions });
    }
    job.scenes = assets;
    const total = assets.reduce((n, a) => n + a.durationSec, 0);
    this.setStage(job, "rendering", `Xong giọng và ảnh: tổng ${Math.round(total)} giây.`);
  }

  private async renderJob(job: JobWithSource, signal: AbortSignal): Promise<void> {
    const script = job.script!;
    const scenes = job.scenes!;
    this.log(job, "Đang dựng video (lần đầu Remotion tải Chrome ~100 MB)…");
    let last = -10;
    const { video, thumbnail } = await this.deps.renderer.render(
      this.jobDir(job.id),
      {
        format: job.format,
        fps: 30,
        title: script.title,
        thumbnailText: script.thumbnailText,
        scenes: scenes.map((a, i) => ({ ...a, onScreenText: script.scenes[i]?.onScreenText })),
      },
      (pct) => {
        if (pct - last >= 10) {
          last = pct;
          this.log(job, `Dựng video: ${pct}%`);
        }
      },
      signal,
    );
    if (signal.aborted) return;
    job.output = path.basename(video);
    job.thumbnail = path.basename(thumbnail);
    this.setStage(job, "final_review", "Video đã dựng xong. Chờ bạn xem và quyết định đăng.");
    this.emit("finished", job);
  }

  private async publishJob(job: JobWithSource): Promise<void> {
    const pending = (job as any).pendingPublish as { youtube: boolean; facebook: boolean; privacy: "public" | "unlisted" | "private" } | undefined;
    if (!pending) throw new Error("Không rõ cần đăng lên đâu.");
    const video = path.join(this.jobDir(job.id), job.output!);
    const thumb = job.thumbnail ? path.join(this.jobDir(job.id), job.thumbnail) : undefined;
    const meta = { script: job.script!, niche: job.niche, privacy: pending.privacy };
    const errors: string[] = [];
    if (pending.youtube && !job.publish.youtube?.id) {
      this.log(job, "Đang tải lên YouTube…");
      try {
        job.publish.youtube = await this.deps.publisher.youtube(video, thumb, meta);
        this.log(job, `YouTube: ${job.publish.youtube.url}${job.publish.youtube.error ? ` (${job.publish.youtube.error})` : ""}`);
      } catch (e) {
        errors.push((e as Error).message);
      }
      await this.save();
    }
    if (pending.facebook && !job.publish.facebook?.id) {
      this.log(job, "Đang tải lên Facebook…");
      try {
        job.publish.facebook = await this.deps.publisher.facebook(video, meta);
        this.log(job, `Facebook: ${job.publish.facebook.url}`);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    // What went up stays up; a retry only sends what failed.
    if (errors.length) throw new Error(errors.join(" · "));
    delete (job as any).pendingPublish;
    this.setStage(job, "published", "Đã đăng.");
    this.emit("finished", job);
  }

  // ---------------- helpers ----------------

  private voiceFor(speaker: string, series?: Series): string {
    if (!series || speaker === "narrator") return series?.narratorVoice || this.deps.defaultVoice;
    return series.characters.find((c) => c.name === speaker)?.voice || this.deps.defaultVoice;
  }

  private imagePrompt(visual: string, speakers: string[], job: JobWithSource, series?: Series): { prompt: string; refs: string[] } {
    if (job.imageSource === "stock") return { prompt: visual, refs: [] };
    if (!series) {
      return { prompt: `${visual}. Style: ${this.deps.explainerStyle ?? "clean editorial illustration, natural light, realistic proportions"}. No text, letters, captions, signature or watermark in the image.`, refs: [] };
    }
    const lower = visual.toLowerCase();
    const cast = series.characters.filter((c) => speakers.includes(c.name) || lower.includes(c.name.toLowerCase())).slice(0, 3);
    const looks = cast.map((c) => `${c.name}: ${c.look}`).join("; ");
    const refs = cast.filter((c) => c.refImage).map((c) => path.join(this.seriesDir(series.id), c.refImage!));
    return {
      prompt: `${visual}${looks ? `\nCharacters in this frame — ${looks}.` : ""}\nArt style: ${series.style}. Cinematic composition. No text, letters, captions, signature or watermark in the image.`,
      refs,
    };
  }

  private previousEpisodes(seriesId: string, before: number): { episode: number; summary: string }[] {
    return this.jobs
      .filter((j) => j.seriesId === seriesId && (j.episode ?? 0) < before && j.script?.summary && ["final_review", "publishing", "published"].includes(j.stage))
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))
      .slice(-12)
      .map((j) => ({ episode: j.episode ?? 0, summary: j.script!.summary! }));
  }

  /** Asks for JSON and gives the model one chance to fix an invalid answer, with the parse error. */
  private async askJson<T>(agent: Agent, prompt: string, title: string, parse: (t: string) => T, signal?: AbortSignal): Promise<T> {
    let res = await agent.send(prompt, { title }, { signal });
    try {
      return parse(res.content);
    } catch (err) {
      if (signal?.aborted) throw err;
      res = await agent.send(`${prompt}\n\nYour previous answer could not be used: ${(err as Error).message}. Answer again with only the corrected \`\`\`json block.`, { title }, { signal });
      try {
        return parse(res.content);
      } catch (err2) {
        throw new Error(`Kịch bản không hợp lệ sau 2 lần: ${(err2 as Error).message}`);
      }
    }
  }

  private setStage(job: JobWithSource, stage: VideoStage, note?: string): void {
    job.stage = stage;
    if (stage !== "failed") job.failedStage = undefined;
    if (note) this.log(job, note);
    job.updatedAt = now();
  }

  private log(job: VideoJob, text: string): void {
    job.progress.push({ at: now(), text });
    if (job.progress.length > MAX_PROGRESS) job.progress.splice(0, job.progress.length - MAX_PROGRESS);
    job.updatedAt = now();
    this.emit("change");
  }

  close(): void {
    this.running?.abort.abort();
    this.deps.tts.close?.();
    this.deps.images.ai?.close?.();
  }
}

function parseFormat(v: string | undefined): VideoFormat {
  return v === "long" ? "long" : "short";
}
