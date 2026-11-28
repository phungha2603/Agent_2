import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFileBlocks, writeFiles } from "../src/apply/applyFiles.js";

describe("parseFileBlocks", () => {
  it("takes each file from its fenced code block, exactly, and ignores prose around it", () => {
    const text =
      "Done — two files.\n\n" +
      "FILE: scripts/test.sh\n```bash\n#!/usr/bin/env bash\n# a comment\nexport PATH=\"$HOME/bin:$PATH\"\n```\n" +
      "This script runs the tests.\n\n" +
      "FILE: app.py\n\n```python\nclass A:\n    def __init__(self):\n        pass\n```\n\n" +
      "Verification log — real run in my sandbox: all green.";
    expect(parseFileBlocks(text)).toEqual([
      { path: "scripts/test.sh", content: '#!/usr/bin/env bash\n# a comment\nexport PATH="$HOME/bin:$PATH"\n', fenced: true },
      { path: "app.py", content: "class A:\n    def __init__(self):\n        pass\n", fenced: true },
    ]);
  });

  it("keeps a FILE: line inside a code block as content, and honors a longer fence around nested ``` lines", () => {
    const text = "FILE: README.md\n````md\n# Usage\n\nFILE: not-a-marker.txt\n```sh\nnpm test\n```\n````\n";
    const files = parseFileBlocks(text);
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe("# Usage\n\nFILE: not-a-marker.txt\n```sh\nnpm test\n```\n");
  });

  it("marks content that isn't in a closed fence as unfenced instead of guessing where it ends", () => {
    const unfenced = parseFileBlocks("FILE: a.ts\nconst a = 1;\n\nThat's all.");
    expect(unfenced).toEqual([{ path: "a.ts", content: "const a = 1;\n\nThat's all.", fenced: false }]);
    const cutOff = parseFileBlocks("FILE: b.ts\n```ts\nconst b = 1;\n");
    expect(cutOff[0].fenced).toBe(false);
  });

  it("refuses a file whose own fence was lost, instead of taking a code block nested inside it (Muse's Copy output)", () => {
    const copied = "FILE: README.md\n\nmarkdown\n# Model\n\nSome *text*.\n\n```bash\n./scripts/check.sh\n```\n\nAll done.";
    expect(parseFileBlocks(copied)[0].fenced).toBe(false);
    // A single language label before a real fence is fine.
    expect(parseFileBlocks("FILE: a.sh\nbash\n```bash\necho hi\n```")[0]).toMatchObject({ content: "echo hi\n", fenced: true });
  });

  it("accepts markers written as **FILE:** or with a backticked path", () => {
    const files = parseFileBlocks("**FILE:** `src/x.ts`\n```ts\nexport {};\n```");
    expect(files).toEqual([{ path: "src/x.ts", content: "export {};\n", fenced: true }]);
  });

  it("returns nothing for a reply with no FILE: markers", () => {
    expect(parseFileBlocks("I would implement this by adding a notifier class.")).toEqual([]);
  });
});

describe("writeFiles — executables", () => {
  it("makes files that start with a shebang executable, and leaves others alone", async () => {
    const { statSync } = await import("node:fs");
    const cwd = mkdtempSync(path.join(tmpdir(), "apply-files-mode-"));
    await writeFiles(cwd, [
      { path: "scripts/run.sh", content: "#!/usr/bin/env bash\necho hi\n" },
      { path: "notes.md", content: "# not a script\n" },
    ]);
    expect(statSync(path.join(cwd, "scripts/run.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(path.join(cwd, "notes.md")).mode & 0o111).toBe(0);
  });
});

describe("writeFiles", () => {
  it("writes parsed files under cwd and refuses to escape it", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "apply-files-test-"));
    const written = await writeFiles(cwd, [{ path: "src/a/b.ts", content: "export const x = 1;" }]);
    expect(written).toEqual(["src/a/b.ts"]);
    expect(readFileSync(path.join(cwd, "src/a/b.ts"), "utf8")).toBe("export const x = 1;");

    await expect(writeFiles(cwd, [{ path: "../escape.ts", content: "x" }])).rejects.toThrow(/outside the project/);
  });
});
