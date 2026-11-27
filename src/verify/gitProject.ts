import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Used only when the repository has no user.name/user.email of its own (none of the CEO's personal details). */
const FALLBACK_IDENTITY = ["-c", "user.name=AI Company Dashboard", "-c", "user.email=ai-company@localhost"];

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

async function identityArgs(dir: string): Promise<string[]> {
  try {
    await git(dir, ["config", "user.name"]);
    await git(dir, ["config", "user.email"]);
    return [];
  } catch {
    return FALLBACK_IDENTITY;
  }
}

/**
 * Records an approved task's files as one commit, so it can be told apart
 * from — and undone independently of — every other task. Returns the
 * commit's short hash, or undefined when nothing changed.
 */
export async function commitTaskFiles(dir: string, files: string[], message: string): Promise<string | undefined> {
  if (!files.length) return undefined;
  await git(dir, ["add", "--", ...files]);
  const staged = await git(dir, ["diff", "--cached", "--name-only", "--", ...files]);
  if (!staged) return undefined;
  const id = await identityArgs(dir);
  await execFileAsync("git", ["-C", dir, ...id, "commit", "--quiet", "-m", message, "--", ...files]);
  return git(dir, ["rev-parse", "--short", "HEAD"]);
}

/**
 * Undoes a task's files that were never approved: tracked ones go back to
 * the last commit, ones the task created are deleted. Returns what it did.
 */
export async function discardTaskFiles(dir: string, files: string[]): Promise<{ restored: string[]; removed: string[] }> {
  const restored: string[] = [];
  const removed: string[] = [];
  for (const f of files) {
    let tracked = true;
    try {
      await git(dir, ["cat-file", "-e", `HEAD:${f}`]);
    } catch {
      tracked = false;
    }
    if (tracked) {
      await git(dir, ["checkout", "HEAD", "--", f]);
      restored.push(f);
    } else {
      await git(dir, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", f]).catch(() => "");
      await rm(path.join(dir, f), { force: true });
      removed.push(f);
    }
  }
  return { restored, removed };
}
