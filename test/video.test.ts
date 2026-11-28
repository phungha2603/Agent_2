import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captionChunks, concatPcm, encodeWav, parseWav, solidPng, wavDurationSec } from "../src/integrations/video/media.js";
import { createMfluxImages, createMockImages, createMockTts, createOpenverseImages, createVieneuTts, shorterQueries } from "../src/integrations/video/providers.js";
import { createPublisher, saveYoutubeToken, youtubeMetadata, type Publisher } from "../src/integrations/video/publish.js";
import type { Renderer } from "../src/integrations/video/render.js";
import { extractJson, parseScript } from "../src/integrations/video/script.js";
import { VideoService, type VideoDeps } from "../src/integrations/video/service.js";
import type { Agent } from "../src/types.js";

const pcm = (seconds: number) => ({ sampleRate: 24000, channels: 1, bitsPerSample: 16, data: Buffer.alloc(Math.round(seconds * 24000) * 2) });

describe("video media helpers", () => {
  it("round-trips a WAV and reads its duration", () => {
    const back = parseWav(encodeWav(pcm(1.5)));
    expect(back.sampleRate).toBe(24000);
    expect(wavDurationSec(back)).toBeCloseTo(1.5, 5);
  });

  it("joins clips with a gap and reports where each starts", () => {
    const { pcm: joined, starts } = concatPcm([pcm(1), pcm(2)], 0.5);
    expect(starts).toEqual([0, 1.5]);
    expect(wavDurationSec(joined)).toBeCloseTo(3.5, 5);
  });

  it("refuses to join clips of different formats", () => {
    expect(() => concatPcm([pcm(1), { ...pcm(1), sampleRate: 16000 }], 0.2)).toThrow(/different formats/);
  });

  it("splits a line into caption chunks that cover its duration exactly", () => {
    const chunks = captionChunks("Một hai ba bốn năm sáu bảy tám chín mười, mười một mười hai.", 2, 4, 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].start).toBe(2);
    expect(chunks.at(-1)!.end).toBeCloseTo(6, 2);
    for (const c of chunks) expect(c.text.split(" ").length).toBeLessThanOrEqual(5);
  });

  it("writes a valid PNG", () => {
    const png = solidPng(4, 2, [10, 20, 30]);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(4);
  });
});

const goodScript = {
  title: "Vì sao trời xanh",
  description: "Mô tả.\n#khoahoc",
  tags: ["khoa học"],
  thumbnailText: "Bầu trời",
  scenes: [{ lines: [{ speaker: "narrator", text: "Câu mở đầu." }], visual: "blue sky" }],
};

describe("video script parsing", () => {
  it("reads a fenced JSON block", () => {
    expect(extractJson("Here:\n```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });

  it("accepts a valid script and fills defaults", () => {
    const s = parseScript("```json\n" + JSON.stringify({ ...goodScript, thumbnailText: "" }) + "\n```");
    expect(s.scenes[0].lines[0].speaker).toBe("narrator");
    expect(s.thumbnailText).toBe("Vì sao trời xanh");
  });

  it("rejects a speaker who is not in the series bible", () => {
    const bad = { ...goodScript, scenes: [{ lines: [{ speaker: "Hùng", text: "Xin chào" }], visual: "x" }] };
    expect(() => parseScript(JSON.stringify(bad), ["Minh"])).toThrow(/unknown speaker "Hùng"/);
  });

  it("rejects a scene without a picture", () => {
    expect(() => parseScript(JSON.stringify({ ...goodScript, scenes: [{ lines: [{ text: "a" }] }] }))).toThrow(/no "visual"/);
  });
});

function fakeRenderer(): Renderer & { calls: number } {
  const r = {
    calls: 0,
    async render(jobDir: string) {
      r.calls++;
      await writeFile(path.join(jobDir, "final.mp4"), "mp4");
      await writeFile(path.join(jobDir, "thumbnail.png"), "png");
      return { video: path.join(jobDir, "final.mp4"), thumbnail: path.join(jobDir, "thumbnail.png") };
    },
  };
  return r;
}

function fakePublisher(opts: { failFacebook?: boolean } = {}): Publisher & { sent: string[] } {
  const p = {
    sent: [] as string[],
    youtubeReady: true,
    facebookReady: true,
    failFacebook: opts.failFacebook ?? false,
    async youtube() {
      p.sent.push("youtube");
      return { id: "yt1", url: "https://www.youtube.com/watch?v=yt1" };
    },
    async facebook() {
      p.sent.push("facebook");
      if (p.failFacebook) throw new Error("Facebook từ chối");
      return { id: "fb1", url: "https://www.facebook.com/p/videos/fb1" };
    },
    async youtubeViews() {
      return 42;
    },
    async facebookViews() {
      return 7;
    },
  };
  return p;
}

async function service(over: Partial<VideoDeps> = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "video-"));
  const deps: VideoDeps = {
    dataDir,
    gemini: null,
    claude: null,
    tts: createMockTts(),
    images: { ai: createMockImages(), stock: createMockImages() },
    renderer: fakeRenderer(),
    publisher: fakePublisher(),
    defaultVoice: "mock-female",
    ...over,
  };
  const svc = new VideoService(deps);
  await svc.init();
  return { svc, deps, dataDir };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

describe("VideoService flow", () => {
  it("stops for the CEO at the script, then produces and renders up to the final review", async () => {
    const { svc } = await service();
    const job = await svc.createExplainer({ topic: "Vì sao trời xanh", format: "short" });
    await until(() => job.stage === "script_review");
    expect(job.script?.scenes.length).toBeGreaterThan(0);
    await svc.decideScript(job.id, "approve");
    await until(() => job.stage === "final_review");
    expect(job.output).toBe("final.mp4");
    expect(job.scenes?.every((s) => s.durationSec > 1 && s.captions.length > 0)).toBe(true);
  });

  it("rewrites with the CEO's note, keeping earlier notes", async () => {
    const prompts: string[] = [];
    const claude: Agent = {
      role: "claude",
      async send(prompt) {
        prompts.push(prompt);
        return { role: "claude", content: "```json\n" + JSON.stringify(goodScript) + "\n```" };
      },
    };
    const gemini: Agent = { role: "gemini", send: async () => ({ role: "gemini", content: "research brief" }) };
    const { svc } = await service({ claude, gemini });
    const job = await svc.createExplainer({ topic: "Trời xanh" });
    await until(() => job.stage === "script_review");
    await svc.decideScript(job.id, "revise", "Mở đầu bằng một câu hỏi");
    await until(() => job.stage === "script_review" && prompts.length === 2);
    expect(prompts[1]).toContain("Mở đầu bằng một câu hỏi");
    expect(prompts[1]).toContain("Your previous draft");
    await expect(svc.decideScript(job.id, "revise", "  ")).rejects.toThrow(/Ghi rõ/);
  });

  it("asks the model again once when its JSON is invalid", async () => {
    let n = 0;
    const claude: Agent = {
      role: "claude",
      async send() {
        n++;
        return { role: "claude", content: n === 1 ? "not json" : JSON.stringify(goodScript) };
      },
    };
    const gemini: Agent = { role: "gemini", send: async () => ({ role: "gemini", content: "brief" }) };
    const { svc } = await service({ claude, gemini });
    const job = await svc.createExplainer({ topic: "Trời xanh" });
    await until(() => job.stage === "script_review");
    expect(n).toBe(2);
  });

  it("publishes only after the CEO asks, and a retry resends only what failed", async () => {
    const publisher = fakePublisher({ failFacebook: true });
    const { svc } = await service({ publisher });
    const job = await svc.createExplainer({ topic: "Trời xanh" });
    await until(() => job.stage === "script_review");
    await svc.decideScript(job.id, "approve");
    await until(() => job.stage === "final_review");
    expect(publisher.sent).toEqual([]);
    await svc.publish(job.id, { youtube: true, facebook: true, privacy: "unlisted" });
    await until(() => job.stage === "failed");
    expect(job.publish.youtube?.id).toBe("yt1");
    (publisher as any).failFacebook = false;
    await svc.retry(job.id);
    await until(() => job.stage === "published");
    expect(publisher.sent).toEqual(["youtube", "facebook", "facebook"]);
    await svc.refreshStats(job.id);
    expect(job.publish.youtube?.views).toBe(42);
  });

  it("reuses images that did not change when the script is rewritten", async () => {
    let generated = 0;
    const base = createMockImages();
    const images = { ai: { kind: "mock" as const, generate: async (...a: Parameters<typeof base.generate>) => (generated++, base.generate(...a)) } };
    const { svc } = await service({ images });
    const job = await svc.createExplainer({ topic: "Trời xanh", imageSource: "ai" });
    await until(() => job.stage === "script_review");
    await svc.decideScript(job.id, "approve");
    await until(() => job.stage === "final_review");
    const first = generated;
    await svc.decideFinal(job.id, "revise", "Đổi giọng kể vui hơn");
    await until(() => job.stage === "script_review");
    await svc.decideScript(job.id, "approve");
    await until(() => job.stage === "final_review");
    expect(generated).toBe(first); // the mock writer returns the same scenes
  });

  it("builds a series, numbers its episodes and uses character voices", async () => {
    const { svc } = await service();
    const series = await svc.createSeries({ premise: "Hai học sinh phát hiện chiếc đèn lồng kỳ lạ ở Hội An", genre: "bí ẩn" });
    await svc.updateSeries(series.id, { characters: series.characters.map((c, i) => ({ ...c, voice: i === 0 ? "mock-male" : "" })) });
    await svc.makePortraits(series.id);
    expect(series.characters.every((c) => c.refImage)).toBe(true);
    const ep1 = await svc.createEpisode(series.id, {});
    const ep2 = await svc.createEpisode(series.id, { topic: "Chuyến đi đầu tiên" });
    expect([ep1.episode, ep2.episode]).toEqual([1, 2]);
    await expect(svc.updateSeries(series.id, { characters: [] })).rejects.toThrow(/ít nhất một nhân vật/);
  });

  it("serves only known files with safe names", async () => {
    const { svc } = await service();
    const job = await svc.createExplainer({ topic: "Trời xanh" });
    expect(svc.filePath("job", job.id, "final.mp4")).toBe(path.join(svc.jobDir(job.id), "final.mp4"));
    expect(svc.filePath("job", job.id, "../jobs.json")).toBeUndefined();
    expect(svc.filePath("job", "nope", "final.mp4")).toBeUndefined();
  });

  it("marks a job that was mid-way when the dashboard stopped as failed, resumable", async () => {
    const { dataDir } = await service();
    await mkdir(dataDir, { recursive: true });
    const stuck = { id: "vid-1", niche: "explainer", format: "short", topic: "x", stage: "rendering", feedback: [], publish: {}, progress: [], createdAt: "", updatedAt: "", imageSource: "ai" };
    await writeFile(path.join(dataDir, "jobs.json"), JSON.stringify([stuck]));
    const svc = new VideoService({ dataDir, gemini: null, claude: null, tts: createMockTts(), images: {}, renderer: fakeRenderer(), publisher: fakePublisher(), defaultVoice: "x" });
    await svc.init();
    const job = svc.snapshot().jobs[0];
    expect(job.stage).toBe("failed");
    expect(job.failedStage).toBe("rendering");
  });
});

describe("video publishing", () => {
  it("declares synthetic media and the right category", () => {
    const meta = youtubeMetadata({ script: { ...goodScript, scenes: [] } as any, niche: "series", privacy: "private" });
    expect(meta.status.containsSyntheticMedia).toBe(true);
    expect(meta.status.privacyStatus).toBe("private");
    expect(meta.snippet.categoryId).toBe("1");
  });

  it("refreshes the token, starts a resumable upload and sends the file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "yt-"));
    const tokenFile = path.join(dir, "token.json");
    await saveYoutubeToken(tokenFile, "refresh-1");
    const video = path.join(dir, "v.mp4");
    await writeFile(video, "VIDEO");
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body });
      if (url.startsWith("https://oauth2")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
      if (url.includes("uploadType=resumable")) return new Response("", { status: 200, headers: { location: "https://upload.example/session" } });
      if (url === "https://upload.example/session") return new Response(JSON.stringify({ id: "abc" }));
      return new Response("", { status: 403 }); // thumbnail
    }) as typeof fetch;
    const pub = createPublisher({ youtube: { clientId: "c", clientSecret: "s", tokenFile }, fetchImpl });
    const post = await pub.youtube(video, video, { script: goodScript as any, niche: "explainer", privacy: "unlisted" });
    expect(post).toMatchObject({ id: "abc", url: "https://www.youtube.com/watch?v=abc" });
    expect(post.error).toMatch(/thumbnail/);
    expect(String(calls[0].body)).toContain("refresh_token=refresh-1");
    expect(JSON.parse(String(calls[1].body)).status.privacyStatus).toBe("unlisted");
    expect(Buffer.from(calls[2].body as Buffer).toString()).toBe("VIDEO");
    expect(JSON.parse(await readFile(tokenFile, "utf8")).refresh_token).toBe("refresh-1");
  });

  it("explains how to log in when there is no token yet", async () => {
    const pub = createPublisher({ youtube: { clientId: "c", clientSecret: "s", tokenFile: "/nonexistent/token.json" } });
    await expect(pub.youtubeViews("x")).rejects.toThrow(/video:youtube-auth/);
  });
});

describe("VieNeu TTS provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A fake VieNeu server: streams WAV with an unknown-length header, forgets enrolled voices on "restart". */
  function fakeServer() {
    const known = new Set<string>();
    const calls: string[] = [];
    const streamedWav = () => {
      const wav = encodeWav(pcm(0.5));
      wav.writeUInt32LE(0xffffffff, 4);
      wav.writeUInt32LE(0xffffffff, 40);
      return wav;
    };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      if (u.pathname === "/health") return new Response("{}");
      if (u.pathname === "/v1/voices" && init?.method === "POST") {
        known.add(String((init.body as FormData).get("name")));
        return new Response("{}");
      }
      if (u.pathname === "/v1/voices") return new Response(JSON.stringify({ data: [{ id: "Hải Đăng", gender: "male", description: "Nam · Bắc" }] }));
      if (u.pathname === "/v1/audio/speech") {
        const voice = JSON.parse(String(init?.body)).voice;
        if (voice && voice !== "Hải Đăng" && !known.has(voice)) return new Response("unknown voice", { status: 400 });
        return new Response(new Uint8Array(streamedWav()));
      }
      return new Response("", { status: 404 });
    });
    return { known, calls };
  }

  it("rewrites the streamed WAV header with the real length", async () => {
    fakeServer();
    const dir = await mkdtemp(path.join(os.tmpdir(), "vieneu-"));
    const tts = createVieneuTts({ voicesDir: path.join(dir, "voices") });
    await tts.synthesize("Xin chào", "Hải Đăng", path.join(dir, "a.wav"));
    const out = await readFile(path.join(dir, "a.wav"));
    expect(out.readUInt32LE(40)).toBe(0.5 * 24000 * 2);
    expect(wavDurationSec(parseWav(out))).toBeCloseTo(0.5, 5);
  });

  it("keeps cloned voices across a server restart by enrolling them again", async () => {
    const server = fakeServer();
    const dir = await mkdtemp(path.join(os.tmpdir(), "vieneu-"));
    const tts = createVieneuTts({ voicesDir: path.join(dir, "voices") });
    await tts.addVoice!("Giọng của tôi", encodeWav(pcm(4)), "wav");
    expect((await tts.voices()).map((v) => v.name)).toEqual(["Giọng của tôi", "Hải Đăng"]);
    server.known.clear(); // the server restarted
    await tts.synthesize("Một câu", "Giọng của tôi", path.join(dir, "b.wav"));
    expect(server.calls.filter((c) => c === "POST /v1/voices").length).toBe(2);
  });

  it("rejects clone names that are not plain labels", async () => {
    fakeServer();
    const dir = await mkdtemp(path.join(os.tmpdir(), "vieneu-"));
    const tts = createVieneuTts({ voicesDir: path.join(dir, "voices") });
    const { svc } = await service({ tts });
    await expect(svc.addVoice("../evil", encodeWav(pcm(4)), "wav")).rejects.toThrow(/Tên giọng/);
    await expect(svc.addVoice("Hải Đăng", encodeWav(pcm(4)), "wav")).rejects.toThrow(/trùng tên/);
    await svc.addVoice("Giọng của tôi", encodeWav(pcm(4)), "wav");
  });
});

describe("Openverse images", () => {
  it("shortens a description into search words, keeping the end of it", () => {
    expect(shorterQueries("A curious person looking at the night sky.")).toEqual(["curious person night sky", "person night sky", "night sky", "sky"]);
  });

  it("asks only for CC0/public-domain, skips links that are not images, and falls back to any orientation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ov-"));
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes("api.openverse.org")) {
        const tall = new URL(url).searchParams.get("aspect_ratio") === "tall";
        const results = tall ? [] : [{ id: "a", url: "https://img/a", width: 3000 }, { id: "b", url: "https://img/b", width: 800 }];
        return new Response(JSON.stringify({ results }));
      }
      if (url === "https://img/a") return new Response("<html>", { headers: { "content-type": "text/html" } });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
    const ov = createOpenverseImages({ fetchImpl });
    await ov.generate("city night", path.join(dir, "x.jpg"), { format: "short" });
    expect(new URL(urls[0]).searchParams.get("license")).toBe("cc0,pdm");
    expect(new URL(urls[1]).searchParams.has("aspect_ratio")).toBe(false);
    expect(urls.slice(2)).toEqual(["https://img/a", "https://img/b"]);
    expect([...(await readFile(path.join(dir, "x.jpg")))]).toEqual([1, 2, 3]);
  });
});

describe("mflux images", () => {
  /** Stands in for mflux_worker.py: same line protocol, writes a tiny file instead of loading FLUX. */
  async function fakeWorker(dir: string, opts: { failOn?: string } = {}) {
    const script = path.join(dir, "worker.py");
    await writeFile(
      script,
      [
        "import json, sys",
        'print(json.dumps({"ready": True}), flush=True)',
        "for line in sys.stdin:",
        "    req = json.loads(line)",
        `    if ${JSON.stringify(opts.failOn ?? "")} and ${JSON.stringify(opts.failOn ?? "")} in req["prompt"]:`,
        '        print(json.dumps({"id": req["id"], "ok": False, "error": "boom"}), flush=True); continue',
        '    open(req["out"], "w").write(json.dumps(req))',
        '    print(json.dumps({"id": req["id"], "ok": True}), flush=True)',
      ].join("\n"),
    );
    return script;
  }

  it("keeps one worker, sends the format's size and the references, and gives one prompt one seed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mflux-"));
    const img = createMfluxImages({ python: "python3", script: await fakeWorker(dir) });
    await Promise.all([
      img.generate("a cat", path.join(dir, "1.png"), { format: "short", refs: ["/r/minh.png"] }),
      img.generate("a cat", path.join(dir, "2.png"), { format: "long" }),
    ]);
    const a = JSON.parse(await readFile(path.join(dir, "1.png"), "utf8"));
    const b = JSON.parse(await readFile(path.join(dir, "2.png"), "utf8"));
    expect([a.width, a.height, b.width, b.height]).toEqual([720, 1280, 1280, 720]);
    expect(a.refs).toEqual(["/r/minh.png"]);
    expect(a.seed).toBe(b.seed);
    img.close!();
  });

  it("reports a failed image without stopping the worker", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mflux-"));
    const img = createMfluxImages({ python: "python3", script: await fakeWorker(dir, { failOn: "bad" }) });
    await expect(img.generate("bad prompt", path.join(dir, "x.png"), { format: "long" })).rejects.toThrow(/mflux: boom/);
    await img.generate("good prompt", path.join(dir, "y.png"), { format: "long" });
    img.close!();
  });

  it("says how to install mflux when its Python is missing", async () => {
    const img = createMfluxImages({ python: "/nonexistent/python", script: "x.py" });
    await expect(img.generate("x", "/tmp/x.png", { format: "long" })).rejects.toThrow(/uv tool install mflux/);
  });
});
