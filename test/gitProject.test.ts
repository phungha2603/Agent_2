import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitTaskFiles, discardTaskFiles, isGitRepo } from "../src/verify/gitProject.js";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "git-project-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  writeFileSync(path.join(dir, "keep.txt"), "approved\n");
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  return dir;
}

describe("git project recording", () => {
  it("commits exactly an approved task's files, under a generic identity when the repo has none", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "keep.txt"), "changed by the task\n");
    writeFileSync(path.join(dir, "new.txt"), "new\n");
    writeFileSync(path.join(dir, "unrelated.txt"), "not this task's\n");
    const hash = await commitTaskFiles(dir, ["keep.txt", "new.txt"], "E1.S1 · thing");
    expect(hash).toMatch(/^[0-9a-f]{7,}$/);
    const files = execFileSync("git", ["-C", dir, "show", "--name-only", "--format=%an <%ae>", "HEAD"], { encoding: "utf8" });
    expect(files).toMatch(/AI Company Dashboard <ai-company@localhost>/);
    expect(files).toMatch(/keep\.txt[\s\S]*new\.txt/);
    expect(files).not.toMatch(/unrelated\.txt/);
    expect(await commitTaskFiles(dir, ["keep.txt"], "again")).toBeUndefined(); // nothing changed
  });

  it("undoes a rejected task: tracked files back to the last commit, new files removed", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "keep.txt"), "rejected rewrite\n");
    writeFileSync(path.join(dir, "new.txt"), "rejected new file\n");
    const res = await discardTaskFiles(dir, ["keep.txt", "new.txt"]);
    expect(res).toEqual({ restored: ["keep.txt"], removed: ["new.txt"] });
    expect(readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("approved\n");
    expect(existsSync(path.join(dir, "new.txt"))).toBe(false);
  });

  it("knows a plain directory isn't a repository", async () => {
    expect(await isGitRepo(mkdtempSync(path.join(tmpdir(), "plain-")))).toBe(false);
  });
});
