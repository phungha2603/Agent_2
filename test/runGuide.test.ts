import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunGuide, scanProject } from "../src/orchestrator/runGuide.js";

const base = { title: "FootPredict", goal: "Xây dựng FootPredict.\nChi tiết…", verifyCommands: ["python3 -m unittest discover -s tests -v"], tasks: { done: 11, total: 11 } };

describe("run guide", () => {
  it("covers location, GitHub clone, detected stack, the plan's test commands and the project's README", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guide-"));
    mkdirSync(path.join(dir, "footpredict"));
    writeFileSync(path.join(dir, "footpredict", "__init__.py"), "");
    writeFileSync(path.join(dir, "README.md"), "# FootPredict\n\nRun: python3 -m footpredict backtest");
    const guide = buildRunGuide({ ...base, dir, githubUrl: "https://github.com/u/footpredict" });

    expect(guide).toContain(`cd "${dir}"`);
    expect(guide).toContain("git clone https://github.com/u/footpredict.git");
    expect(guide).toMatch(/Python\*\* — chỉ dùng thư viện chuẩn/);
    expect(guide).toContain("python3 -m unittest discover -s tests -v");
    expect(guide).toContain("Run: python3 -m footpredict backtest");
    expect(guide).toContain("11/11 task xong");
  });

  it("names npm scripts, Swift and Xcode projects", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guide-"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", test: "vitest" } }));
    writeFileSync(path.join(dir, "Package.swift"), "");
    mkdirSync(path.join(dir, "VocabApp.xcodeproj"));
    const guide = buildRunGuide({ ...base, dir });
    expect(guide).toContain("`npm run dev` → `vite`");
    expect(guide).toContain("`swift test`");
    expect(guide).toContain("open VocabApp.xcodeproj");
  });

  it("still gives the plan's facts when the folder is gone", () => {
    expect(scanProject("/no/such/dir").exists).toBe(false);
    const guide = buildRunGuide({ ...base, dir: "/no/such/dir" });
    expect(guide).toContain("không còn tồn tại trên máy này");
    expect(guide).toContain("Dự án chưa có README");
  });
});
