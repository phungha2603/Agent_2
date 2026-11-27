import { execFile } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
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

const DEFAULT_GITIGNORE = [
  "# Build output and caches",
  ".build/",
  ".swiftpm/",
  "DerivedData/",
  "build/",
  "dist/",
  "node_modules/",
  "xcuserdata/",
  "*.xcuserstate",
  "__pycache__/",
  ".venv/",
  ".pytest_cache/",
  ".DS_Store",
  "",
].join("\n");

/**
 * Makes a plan's project directory a git repository if it isn't one yet —
 * creating the directory, a default .gitignore (unless one exists) and a
 * first commit of whatever is already there — so every task approved later
 * becomes its own commit and a rejected one can be undone. Returns what it
 * did, or undefined if the directory was already a repository.
 */
export async function ensureProjectRepo(dir: string): Promise<{ created: boolean; commit: string } | undefined> {
  if (await isGitRepo(dir)) return undefined;
  let existed = true;
  try {
    await access(dir);
  } catch {
    existed = false;
  }
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "--quiet"]);
  const ignore = path.join(dir, ".gitignore");
  try {
    await access(ignore);
  } catch {
    await writeFile(ignore, DEFAULT_GITIGNORE, "utf8");
  }
  await git(dir, ["add", "-A"]);
  const id = await identityArgs(dir);
  await execFileAsync("git", [
    "-C",
    dir,
    ...id,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    existed ? "Baseline: project as it was before the AI Company started on it" : "Start of the project (created by the AI Company dashboard)",
  ]);
  return { created: !existed, commit: await git(dir, ["rev-parse", "--short", "HEAD"]) };
}

/** GitHub side of a project: one remote repository per project, kept up to date as tasks are approved. */
export interface GithubOps {
  /** Whether `gh` is installed and logged in. */
  available(): Promise<boolean>;
  /** Creates a repository for `dir` (named after its folder, -2, -3... if taken), sets it as origin and pushes; returns its URL. */
  createRepo(dir: string, description: string): Promise<string>;
  /** Pushes the current branch to origin. */
  push(dir: string): Promise<void>;
  /** origin's URL, if the project already has one. */
  remoteUrl(dir: string): Promise<string | undefined>;
}

async function gh(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
  return stdout.trim();
}

/** The real thing, through the `gh` CLI the CEO is logged in with. Repositories are private unless `visibility` says otherwise. */
export function createGithubOps(opts: { visibility?: "private" | "public" } = {}): GithubOps {
  let login: Promise<string> | null = null;
  const owner = () => (login ??= gh(["api", "user", "--jq", ".login"]));
  return {
    async available() {
      try {
        return Boolean(await owner());
      } catch {
        login = null;
        return false;
      }
    },
    async remoteUrl(dir) {
      try {
        return (await git(dir, ["remote", "get-url", "origin"])) || undefined;
      } catch {
        return undefined;
      }
    },
    async createRepo(dir, description) {
      const me = await owner();
      const base = path.basename(path.resolve(dir)).replace(/[^A-Za-z0-9._-]/g, "-") || "project";
      let name = base;
      for (let n = 2; ; n++) {
        try {
          await gh(["repo", "view", `${me}/${name}`, "--json", "name"]);
          name = `${base}-${n}`; // taken: try the next
        } catch {
          break; // free
        }
      }
      await gh([
        "repo",
        "create",
        `${me}/${name}`,
        opts.visibility === "public" ? "--public" : "--private",
        "--source",
        dir,
        "--remote",
        "origin",
        "--push",
        "--description",
        description.replace(/\s+/g, " ").slice(0, 300),
      ]);
      return `https://github.com/${me}/${name}`;
    },
    async push(dir) {
      await git(dir, ["push", "--quiet", "-u", "origin", "HEAD"]);
    },
  };
}
