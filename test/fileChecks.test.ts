import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkFileContent, checkWrittenFiles } from "../src/verify/fileChecks.js";

// Shapes taken from the VocabApp files that a rendered-Markdown reply corrupted.
const RENDERED_SH = '#!/usr/bin/env bash\n\nLocal test script.\n1. Python tests (34 tests)\nexport PATH="\n𝐻\n𝑂\n𝑀\n𝐸\n/bin:\nPATH"\n';
const FLAT_PY = 'def uid(name):\n"""Deterministic ID."""\nreturn name.upper()\n';
const FLAT_YAML = "name: Test\n\non:\npush:\nbranches: [main]\n\njobs:\ntests:\nruns-on: macos-14\nsteps:\n- name: Check out\nuses: actions/checkout@v4\n";
const RENDERED_PBXPROJ = "// !\n∗\n𝑈\n𝑇\n𝐹\n8\n∗\n!\n{\narchiveVersion = 1;\n}\n";

describe("checkFileContent", () => {
  it("flags text that went through a Markdown/LaTeX renderer", async () => {
    const problems = await checkFileContent("scripts/test.sh", RENDERED_SH);
    expect(problems.join("\n")).toMatch(/math-styled letter/);
    expect(problems.join("\n")).toMatch(/bash -n failed/);
  });

  it("flags Python whose indentation was stripped", async () => {
    expect((await checkFileContent("gen.py", FLAT_PY)).join("\n")).toMatch(/python syntax check failed: line 2/);
  });

  it("flags YAML whose nesting was flattened, even though it still parses as flat YAML", async () => {
    expect((await checkFileContent(".github/workflows/test.yml", FLAT_YAML)).join("\n")).toMatch(/"on:" has nothing nested under it/);
  });

  it("flags invalid JSON and a broken Xcode project header", async () => {
    expect((await checkFileContent("data.json", '{"a": 1}\nVerification log: ok')).join("\n")).toMatch(/invalid JSON/);
    expect((await checkFileContent("App.xcodeproj/project.pbxproj", RENDERED_PBXPROJ)).join("\n")).toMatch(/UTF8/);
  });

  it("passes clean files of each kind", async () => {
    const clean: [string, string][] = [
      ["a.py", "class A:\n    def __init__(self):\n        self.x = 2 * 3\n"],
      ["run.sh", '#!/usr/bin/env bash\n# comment\nset -euo pipefail\nexport PATH="$HOME/bin:$PATH"\n'],
      [".github/workflows/ci.yml", "name: CI\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: |\n          npm ci\n          npm test\n"],
      ["data.json", '{"a": [1, 2]}\n'],
      ["notes.md", "# Title\n\n*emphasis* and `__init__`\n"],
      ["main.js", "export const x = 1;\n"],
    ];
    for (const [p, content] of clean) expect(await checkFileContent(p, content), p).toEqual([]);
  });
});

describe("checkWrittenFiles", () => {
  it("reads files back from disk and reports missing ones", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "filechecks-"));
    writeFileSync(path.join(dir, "ok.py"), "x = 1\n");
    writeFileSync(path.join(dir, "bad.py"), FLAT_PY);
    const res = await checkWrittenFiles(dir, ["ok.py", "bad.py", "gone.py"]);
    expect(res.map((r) => r.path).sort()).toEqual(["bad.py", "gone.py"]);
  });
});
