import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFileBlocks, writeFiles } from "../src/apply/applyFiles.js";

describe("parseFileBlocks", () => {
  it("parses files with no code fence (how Muse actually replies)", () => {
    const text =
      "FILE: src/weekly-digest/notify/notifier.ts\n\n" +
      'import type {WeeklyDigest} from "../types.js";\n' +
      "export interface Notifier{send():Promise<void>}\n\n" +
      "FILE: src/weekly-digest/notify/consoleNotifier.ts\n\n" +
      'import type {Notifier} from "./notifier.js";\n' +
      "export class ConsoleNotifier implements Notifier{async send(){}}\n";

    const files = parseFileBlocks(text);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("src/weekly-digest/notify/notifier.ts");
    expect(files[0].content).toContain("export interface Notifier");
    expect(files[1].path).toBe("src/weekly-digest/notify/consoleNotifier.ts");
    expect(files[1].content).toContain("export class ConsoleNotifier");
  });

  it("still strips a wrapping fenced code block when present", () => {
    const text = 'FILE: NOTES.md\n```md\n# Title\n\nBody text.\n```\n';
    const files = parseFileBlocks(text);
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe("# Title\n\nBody text.");
  });

  it("ignores prose before the first FILE: marker", () => {
    const text = "Here is my plan...\n\nFILE: a.ts\nconst a = 1;\n";
    const files = parseFileBlocks(text);
    expect(files).toEqual([{ path: "a.ts", content: "const a = 1;" }]);
  });

  it("returns nothing for a reply with no FILE: markers", () => {
    expect(parseFileBlocks("I would implement this by adding a notifier class.")).toEqual([]);
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
