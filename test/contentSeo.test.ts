import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyRun, ContentSeoService } from "../src/integrations/contentSeo.js";

/** A stand-in for the project's python: answers --check, and plays a pipeline run or the bot from a script. */
function fakePython(runOutput: string[], botSleeps = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-seo-"));
  const file = path.join(dir, "python");
  const lines = runOutput.map((l) => `echo '${l.replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync(
    file,
    `#!/bin/bash
if [ "$1" = "main.py" ]; then echo "Bot đang chạy (polling)..."; ${botSleeps ? "sleep 30" : "exit 0"}; fi
if [ "$2" = "--check" ]; then echo '{"type": "check", "ok": true, "error": null, "model": "gemini-x", "articles": 15}'; exit 0; fi
${lines}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const waitFor = async (check: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("classifyRun", () => {
  it("reads the outcome from the pipeline's own final message", () => {
    expect(classifyRun(["✅ Hoàn tất! Đã tạo 15 bài content chuẩn SEO tại:\nhttps://drive.google.com/x"], 0)).toEqual({ status: "done", result: "15/15" });
    expect(classifyRun(["⚠️ Hoàn tất với 12/15 bài thành công tại: ..."], 0)).toEqual({ status: "partial", result: "12/15" });
    expect(classifyRun(["🛑 Đã hết quota Gemini ...\nĐã tạo xong 7/15 bài, lưu tại: ..."], 0)).toEqual({ status: "quota", result: "7/15" });
    expect(classifyRun([], 1)).toEqual({ status: "failed" });
  });
});

describe("ContentSeoService", () => {
  it("runs the pipeline, streams its progress, finds the Drive folder and keeps the history", async () => {
    const data = mkdtempSync(path.join(tmpdir(), "seo-data-"));
    const python = fakePython([
      '{"type": "progress", "text": "🔎 Đang thu thập nội dung tham khảo từ các link..."}',
      '{"type": "progress", "text": "✍️ Đang tạo Bài 1/15..."}',
      '{"type": "progress", "text": "✅ Hoàn tất! Đã tạo 15 bài content chuẩn SEO tại:\\nhttps://drive.google.com/drive/folders/abc"}',
      '{"type": "end"}',
    ]);
    const svc = new ContentSeoService(mkdtempSync(path.join(tmpdir(), "seo-proj-")), { python, dataDir: data });
    await svc.init();
    await waitFor(() => svc.snapshot().check !== null);
    expect(svc.snapshot().check).toMatchObject({ ok: true, model: "gemini-x", articles: 15 });

    await expect(svc.startRun({ domain: "", keyword: "k", links: [] })).rejects.toThrow(/Cần domain/);
    const finished = new Promise((r) => svc.once("finished", r));
    await svc.startRun({ domain: "UY88", keyword: "UY88", links: "https://a.com\nhttps://b.com not-a-link" });
    await expect(svc.startRun({ domain: "x", keyword: "y", links: ["https://c.com"] })).rejects.toThrow(/Đang có một lượt/);
    await finished;
    const run = svc.snapshot().runs[0];
    expect(run).toMatchObject({ status: "done", result: "15/15", folderUrl: "https://drive.google.com/drive/folders/abc", links: ["https://a.com", "https://b.com"] });
    expect(run.progress.map((p) => p.text)[1]).toBe("✍️ Đang tạo Bài 1/15...");
    expect(svc.snapshot().current).toBeNull();
    expect(JSON.parse(readFileSync(path.join(data, "runs.json"), "utf8"))[0].status).toBe("done");
  });

  it("starts and stops the Telegram bot and keeps its log", async () => {
    const svc = new ContentSeoService(mkdtempSync(path.join(tmpdir(), "seo-proj-")), { python: fakePython([], true), dataDir: mkdtempSync(path.join(tmpdir(), "seo-data-")) });
    svc.startBot();
    expect(() => svc.startBot()).toThrow(/đang chạy rồi/);
    await waitFor(() => svc.snapshot().bot.log.some((l) => l.includes("polling")));
    expect(svc.snapshot().bot.running).toBe(true);
    svc.stopBot();
    await waitFor(() => !svc.snapshot().bot.running);
    expect(svc.snapshot().bot.log.at(-1)).toMatch(/Bot đã dừng/);
  });

  it("marks a run that was in progress when the dashboard stopped as stopped", async () => {
    const data = mkdtempSync(path.join(tmpdir(), "seo-data-"));
    writeFileSync(path.join(data, "runs.json"), JSON.stringify([{ id: "r1", startedAt: "x", domain: "d", keyword: "k", links: [], status: "running", progress: [] }]));
    const svc = new ContentSeoService(mkdtempSync(path.join(tmpdir(), "seo-proj-")), { python: fakePython([]), dataDir: data });
    await svc.init();
    expect(svc.snapshot().runs[0].status).toBe("stopped");
    expect(existsSync(path.join(data, "runs.json"))).toBe(true);
  });
});
