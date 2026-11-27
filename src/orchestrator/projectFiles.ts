import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TaskRecord } from "../types.js";

export interface ProjectFile {
  path: string;
  content: string;
  /** The content was cut at the per-file limit. */
  truncated?: boolean;
}

const PATH_RE = /(?:^|[\s`'"(\[,])((?:[\w.-]+\/)*[\w.-]+\.(?:swift|py|sh|bash|ya?ml|json|pbxproj|xcscheme|plist|md|txt|toml|ts|tsx|js|mjs|cjs|kt|java|go|rs|rb|c|h|m|mm|cpp|hpp|css|html|sql))(?=$|[\s`'"),.;:\]])/gm;
const PER_FILE_CHARS = 20_000;
const TOTAL_CHARS = 80_000;
const MAX_FILES = 25;

/** File paths the task's own text mentions, in order of first mention. */
export function mentionedPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, "");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The current contents of the project files this task is about — the ones
 * its brief, criteria, CEO requests, directives, upstream handoffs and the
 * guide's FILES: line name — read from disk now. Given to Claude so it
 * doesn't spend a tool turn (and a full re-send of the context) per file,
 * and to the engineer, who cannot read the project at all and otherwise
 * rebuilds files from whatever stale copy it has.
 */
export async function collectProjectFiles(task: TaskRecord, projectDir: string | undefined, extra: string[] = []): Promise<ProjectFile[]> {
  if (!projectDir) return [];
  const c = task.context;
  const text = [
    c.title,
    c.ideaBrief,
    ...(c.acceptanceCriteria ?? []),
    ...(c.ceoRequests ?? []),
    ...(c.directives ?? []),
    ...(c.upstream ?? []).flatMap((u) => u.files),
  ]
    .filter(Boolean)
    .join("\n");
  const candidates = [...extra, ...mentionedPaths(text)];
  const root = path.resolve(projectDir);
  const out: ProjectFile[] = [];
  let total = 0;
  for (const rel of [...new Set(candidates)]) {
    if (out.length >= MAX_FILES || total >= TOTAL_CHARS) break;
    if (rel.includes("*")) continue;
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) continue;
    try {
      if (!(await stat(abs)).isFile()) continue;
      let content = await readFile(abs, "utf8");
      if (content.includes("\u0000")) continue; // binary
      const budget = Math.min(PER_FILE_CHARS, TOTAL_CHARS - total);
      const truncated = content.length > budget;
      if (truncated) content = content.slice(0, budget);
      total += content.length;
      out.push({ path: rel, content, ...(truncated ? { truncated } : {}) });
    } catch {
      // Not there (yet): the task may be creating it.
    }
  }
  return out;
}
