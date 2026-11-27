import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { checkFileContent } from "./fileChecks.js";

const SKIP_DIRS = new Set([".git", ".build", ".swiftpm", ".venv", "node_modules", "DerivedData", "build", "dist", "__pycache__", "xcuserdata"]);
const CHECKED = /\.(py|sh|bash|js|mjs|cjs|swift|json|ya?ml|pbxproj|plist|resolved)$/i;
const MAX_FILES = 400;
const MAX_LISTED = 150;
const MAX_BYTES = 512 * 1024;

export interface ProjectSurvey {
  files: string[];
  broken: { path: string; problems: string[] }[];
  /** Test classes that compile but contain no test — "passing" while testing nothing. */
  emptyTests: string[];
  truncated: boolean;
}

async function walk(root: string, rel = "", out: string[] = []): Promise<string[]> {
  if (out.length >= MAX_FILES) return out;
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_FILES) break;
    if (e.name === ".DS_Store") continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/**
 * What is actually in an existing project, for the planner (which cannot
 * read files): its file list, files failing the same content/syntax checks
 * the pipeline applies, and test classes with no tests. A plan built from
 * the goal text alone once missed four test files whose bodies had been
 * wiped — they compiled, so nothing reported them.
 */
export async function surveyProject(dir: string): Promise<ProjectSurvey | undefined> {
  try {
    if (!(await stat(dir)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const files = await walk(dir);
  if (!files.length) return undefined;
  const broken: ProjectSurvey["broken"] = [];
  const emptyTests: string[] = [];
  for (const f of files.filter((p) => CHECKED.test(p))) {
    const abs = path.join(dir, f);
    if ((await stat(abs)).size > MAX_BYTES) continue;
    const content = await readFile(abs, "utf8");
    const problems = await checkFileContent(f, content);
    if (problems.length) broken.push({ path: f, problems: problems.map((p) => p.split("\n")[0].slice(0, 200)) });
    if (/\.swift$/.test(f) && /:\s*XCTestCase\b/.test(content) && !/\bfunc\s+test\w*\s*\(/.test(content)) emptyTests.push(f);
    if (/(^|\/)test_[^/]*\.py$/.test(f) && !/^\s*def\s+test_/m.test(content)) emptyTests.push(f);
  }
  return { files, broken, emptyTests, truncated: files.length >= MAX_FILES };
}

export function formatSurvey(s: ProjectSurvey): string {
  const lines = [
    `Files (${s.files.length}${s.truncated ? "+, list truncated" : ""}): ${s.files.slice(0, MAX_LISTED).join(", ")}${s.files.length > MAX_LISTED ? ", …" : ""}`,
  ];
  if (s.broken.length) {
    lines.push(`Files that fail automatic content/syntax checks (${s.broken.length}):`, ...s.broken.map((b) => `- ${b.path}: ${b.problems.join("; ")}`));
  } else {
    lines.push("No file fails the automatic content/syntax checks.");
  }
  if (s.emptyTests.length) lines.push(`Test files that contain no test functions (${s.emptyTests.length}): ${s.emptyTests.join(", ")}`);
  return lines.join("\n");
}
