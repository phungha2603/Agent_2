import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FileProblem {
  path: string;
  problems: string[];
}

const TOOL_TIMEOUT_MS = 30_000;

/**
 * Text that went through a Markdown/KaTeX renderer before reaching us — the
 * engineer's reply scraped from a chat page's rendered DOM — carries tell-tale
 * characters no source file should: math-italic letters (`$HOME` → 𝐻𝑂𝑀𝐸),
 * zero-width spaces, and the lone "∗" KaTeX makes of `*`.
 */
function renderedMarkdownSigns(content: string): string[] {
  const out: string[] = [];
  const math = content.match(/[\u{1D400}-\u{1D7FF}]/gu);
  if (math) out.push(`contains ${math.length} math-styled letter(s) such as "${math[0]}" — the text was rendered as Markdown/LaTeX, it is not the original source`);
  if (/​/.test(content)) out.push("contains zero-width spaces (U+200B) — a sign of text copied from a rendered page");
  if (/^\s*∗\s*$/m.test(content)) out.push('has a line that is only "∗" — a "*" that a Markdown/LaTeX renderer turned into a math symbol');
  return out;
}

/** A YAML key with nothing nested under it followed by a sibling, or a bare non-key line: what YAML looks like after its indentation was stripped. */
function yamlStructureProblems(content: string): string[] {
  const out: string[] = [];
  const lines = content.split(/\r?\n/);
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const significant = (l: string) => l.trim() !== "" && !l.trimStart().startsWith("#");
  let blockIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!significant(line)) continue;
    const indent = indentOf(line);
    if (blockIndent >= 0) {
      if (indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (/^\t/.test(line)) out.push(`line ${i + 1}: indented with a tab (YAML only allows spaces)`);
    const body = line.trim();
    if (/[:-]\s*[|>][+-]?\d*\s*(#.*)?$/.test(body)) {
      blockIndent = indent;
      continue;
    }
    if (body === "---" || body === "..." || body.startsWith("- ") || body === "-" || body.startsWith("%")) continue;
    const isKey = /^("[^"]*"|'[^']*'|[^\s"'#][^#]*?)\s*:(\s|$)/.test(body);
    if (!isKey) {
      const prev = lines.slice(0, i).reverse().find(significant);
      // A plain scalar may continue on a more-indented line; anything else that isn't "key:" is broken.
      if (!prev || indent <= indentOf(prev)) out.push(`line ${i + 1}: "${body.slice(0, 60)}" is not a "key: value" or "- item" line — the indentation looks lost`);
      continue;
    }
  }
  // A key left empty ("push:" in a GitHub workflow) is valid YAML, so one
  // alone proves nothing. What flattening leaves behind is a whole file with
  // block-opening keys and not a single indented line.
  const openers = lines.filter((l) => significant(l) && /^[^\s#-][^#]*:\s*(#.*)?$/.test(l));
  const indented = lines.some((l) => significant(l) && indentOf(l) > 0);
  if (openers.length >= 2 && !indented) {
    out.push(`no line is indented although ${openers.length} keys (e.g. "${openers[0].trim()}") open nested blocks — the indentation looks lost`);
  }
  return out.slice(0, 5);
}

function runTool(cmd: string, args: string[]): Promise<{ ok: boolean; output: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TOOL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, output: "", missing: false });
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      resolve({ ok: false, output: `${stderr || stdout || err.message}`.trim().slice(0, 600), missing });
    });
  });
}

type ToolCheck = (file: string) => Promise<string | undefined>;

/** Wraps an external checker: a missing tool skips the check (logged by the caller as nothing found), it never fails the file. */
function tool(name: string, cmd: string, args: (file: string) => string[]): ToolCheck {
  return async (file) => {
    const r = await runTool(cmd, args(file));
    if (r.ok || r.missing) return undefined;
    return `${name} failed: ${r.output}`;
  };
}

const PY_PARSE = [
  "import ast,sys",
  "src=open(sys.argv[1],encoding='utf-8').read()",
  "try:",
  "    ast.parse(src,sys.argv[1])",
  "except SyntaxError as e:",
  "    print(f'line {e.lineno}: {e.msg}: {(e.text or \"\").strip()[:120]}'); sys.exit(1)",
].join("\n");

const python = tool("python syntax check", "python3", (f) => ["-I", "-c", PY_PARSE, f]);
const bashCheck = tool("bash -n", "bash", (f) => ["-n", f]);
const nodeCheck = tool("node --check", process.execPath, (f) => ["--check", f]);
const plutil = tool("plutil -lint", "plutil", (f) => ["-lint", "-s", f]);
const swiftParse = tool("swiftc -parse", "swiftc", (f) => ["-parse", f]);

function checksFor(relPath: string, content: string): ToolCheck[] {
  const ext = path.extname(relPath).toLowerCase();
  const shebang = content.startsWith("#!") ? content.slice(0, content.indexOf("\n")) : "";
  if (ext === ".py" || /python/.test(shebang)) return [python];
  if (ext === ".sh" || ext === ".bash" || /\b(ba)?sh\b/.test(shebang)) return [bashCheck];
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return [nodeCheck];
  if (ext === ".pbxproj" || ext === ".plist" || ext === ".entitlements" || ext === ".strings") return [plutil];
  if (ext === ".swift") return [swiftParse];
  return [];
}

/**
 * Checks one file's contents before (or after) it lands on disk: signs of
 * Markdown-rendered text, then the language's own syntax check where a tool
 * for it is installed. Returns human-readable problems; empty means clean.
 */
export async function checkFileContent(relPath: string, content: string): Promise<string[]> {
  const problems = renderedMarkdownSigns(content);
  const ext = path.extname(relPath).toLowerCase();
  const base = path.basename(relPath);

  if (ext === ".json" || base === "Package.resolved") {
    try {
      JSON.parse(content);
    } catch (err) {
      problems.push(`invalid JSON: ${(err as Error).message}`);
    }
  }
  if (ext === ".yml" || ext === ".yaml") problems.push(...yamlStructureProblems(content));
  if (ext === ".pbxproj" && !content.startsWith("// !$*UTF8*$!")) {
    problems.push('first line is not "// !$*UTF8*$!" — Xcode will refuse to open the project');
  }

  const checks = checksFor(relPath, content);
  if (checks.length) {
    const dir = await mkdtemp(path.join(tmpdir(), "filecheck-"));
    try {
      const file = path.join(dir, base);
      await writeFile(file, content, "utf8");
      for (const check of checks) {
        const problem = await check(file);
        if (problem) problems.push(problem.split(dir + path.sep).join(""));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return problems;
}

export async function checkFiles(files: { path: string; content: string }[]): Promise<FileProblem[]> {
  const out: FileProblem[] = [];
  for (const f of files) {
    const problems = await checkFileContent(f.path, f.content);
    if (problems.length) out.push({ path: f.path, problems });
  }
  return out;
}

/** The same checks against files already written under `cwd` (a missing file is itself a problem). */
export async function checkWrittenFiles(cwd: string, relPaths: string[]): Promise<FileProblem[]> {
  const files: { path: string; content: string }[] = [];
  const out: FileProblem[] = [];
  for (const p of relPaths) {
    try {
      files.push({ path: p, content: await readFile(path.resolve(cwd, p), "utf8") });
    } catch (err) {
      out.push({ path: p, problems: [`could not be read back from disk: ${(err as Error).message}`] });
    }
  }
  return [...out, ...(await checkFiles(files))];
}

export function formatFileProblems(problems: FileProblem[]): string {
  return problems.map((f) => `- ${f.path}\n${f.problems.map((p) => `    • ${p}`).join("\n")}`).join("\n");
}
