import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { RoleCheck } from "../org/roles.js";

/**
 * Checks that come with a role, run during verification on top of the
 * project's own build/test commands. They only look at the files this
 * attempt wrote.
 *
 * "fail" findings fail verification, so the engineer gets them back as
 * feedback and fixes the same files. "warn" findings are things the engineer
 * may not be able to fix alone (a test file the guide's FILES line doesn't
 * allow, a plan-level verify command): they become a red warning the CEO
 * sees before shipping, and the reviewers see them in the verification log.
 */
export interface RoleCheckFinding {
  check: RoleCheck;
  level: "fail" | "warn";
  /** Vietnamese, for the dashboard and the log. */
  text: string;
}

export interface RoleCheckInput {
  cwd: string;
  /** Files this attempt wrote, relative to cwd. */
  files: string[];
  /** The verify commands this task runs. */
  commands: string[];
}

const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "swift", "go", "rs", "java", "kt", "kts", "rb", "php", "cs", "c", "cc", "cpp", "h", "hpp", "m", "mm", "scala", "dart"]);

const ext = (file: string) => path.extname(file).slice(1).toLowerCase();
export const isCodeFile = (file: string) => CODE_EXT.has(ext(file));

/** Test files by the usual conventions across languages (tests/, __tests__/, *Tests.swift, test_x.py, x.test.ts, x_test.go …). */
export function isTestFile(file: string): boolean {
  const norm = file.replace(/\\/g, "/");
  if (/(^|\/)(tests?|__tests__|spec|specs|[A-Za-z]*Tests|[A-Za-z]*UITests)\//.test(norm)) return true;
  const base = norm.split("/").pop() ?? "";
  return /^test_.+|.+_test\.[a-z]+$|.+\.(test|spec)\.[a-z]+$|.+Tests?\.(swift|kt|java|cs|m)$/.test(base);
}

/** Secret-looking values. Placeholders like "changeme", "<your-key>", "example" don't count. */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "khoá riêng (private key)", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "API key dạng sk-", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "mật khẩu/secret gán cứng", re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i },
];
const PLACEHOLDER = /change.?me|example|dummy|placeholder|your[_-]|<[^>]+>|\$\{|process\.env|os\.environ|getenv|x{4,}|\*{4,}|test|fake|sample|redacted/i;

/** Stubs left where the work was supposed to be. Plain abstract-method idioms are not flagged. */
const STUB_PATTERNS: RegExp[] = [
  /\b(?:TODO|FIXME)\b\s*:?\s*(?:implement|implementation|not implemented|fill in)/i,
  /fatalError\(\s*"[^"]*(?:TODO|unimplemented|not implemented)/i,
  /throw new Error\(\s*['"`][^'"`]*(?:not implemented|unimplemented|TODO)/i,
  /\b(?:unimplemented|todo)!\s*\(/,
  /raise NotImplementedError\(\s*['"][^'"]*(?:TODO|later|implement)/i,
];

async function read(cwd: string, file: string): Promise<string | undefined> {
  return readFile(path.join(cwd, file), "utf8").catch(() => undefined);
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

async function checkSecrets(input: RoleCheckInput): Promise<RoleCheckFinding[]> {
  const hits: string[] = [];
  for (const file of input.files) {
    if (/(^|\/)\.env\.example$|\.md$/i.test(file) && !/-----BEGIN/.test((await read(input.cwd, file)) ?? "")) continue;
    const content = await read(input.cwd, file);
    if (!content) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      const m = re.exec(content);
      if (!m) continue;
      const value = m[1] ?? m[0];
      if (PLACEHOLDER.test(value)) continue;
      hits.push(`${file}:${lineOf(content, m.index)} — ${name}`);
      break;
    }
  }
  return hits.length
    ? [{ check: "secrets", level: "fail", text: `Có giá trị trông như secret thật trong file vừa ghi (${hits.join("; ")}). Đọc từ biến môi trường thay vì ghi cứng.` }]
    : [];
}

async function checkStubs(input: RoleCheckInput): Promise<RoleCheckFinding[]> {
  const hits: string[] = [];
  for (const file of input.files.filter((f) => isCodeFile(f) && !isTestFile(f))) {
    const content = await read(input.cwd, file);
    if (!content) continue;
    for (const re of STUB_PATTERNS) {
      const m = re.exec(content);
      if (m) {
        hits.push(`${file}:${lineOf(content, m.index)} (${m[0].slice(0, 60)})`);
        break;
      }
    }
  }
  return hits.length
    ? [{ check: "stubs", level: "fail", text: `Còn code giả/chưa viết trong phần được giao: ${hits.join("; ")}. Viết phần thật thay cho chỗ để trống.` }]
    : [];
}

function checkTests(input: RoleCheckInput): RoleCheckFinding[] {
  const code = input.files.filter((f) => isCodeFile(f) && !isTestFile(f));
  if (!code.length || input.files.some(isTestFile)) return [];
  return [
    {
      check: "tests",
      level: "warn",
      text: `Vai trò này phải kèm test cho code mới, nhưng lượt này ghi ${code.length} file code (${code.slice(0, 4).join(", ")}${code.length > 4 ? ", …" : ""}) mà không có file test nào.`,
    },
  ];
}

function hasXcodeProject(cwd: string): boolean {
  try {
    return existsSync(cwd) && readdirSync(cwd).some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"));
  } catch {
    return false;
  }
}

function checkIosDestination(input: RoleCheckInput): RoleCheckFinding[] {
  if (!input.files.some((f) => /\.(swift|pbxproj|xcscheme)$/.test(f))) return [];
  const xcode = input.commands.filter((c) => /\bxcodebuild\b/.test(c));
  if (!xcode.length) {
    return hasXcodeProject(input.cwd)
      ? [{ check: "ios_destination", level: "warn", text: "Dự án có .xcodeproj nhưng lệnh kiểm tra không có xcodebuild — app iOS chưa được build thật trên Simulator." }]
      : [];
  }
  const concrete = xcode.some((c) => /platform=iOS Simulator,\s*name=/.test(c));
  const generic = xcode.some((c) => /generic\/platform=iOS Simulator/.test(c));
  return generic && !concrete
    ? [{ check: "ios_destination", level: "warn", text: "Lệnh xcodebuild chỉ dùng 'generic/platform=iOS Simulator' — cần build trên một simulator có tên cụ thể như nút Run của Xcode." }]
    : [];
}

export async function runRoleChecks(checks: RoleCheck[], input: RoleCheckInput): Promise<RoleCheckFinding[]> {
  if (!input.files.length) return [];
  const out: RoleCheckFinding[] = [];
  for (const check of checks) {
    if (check === "secrets") out.push(...(await checkSecrets(input)));
    else if (check === "stubs") out.push(...(await checkStubs(input)));
    else if (check === "tests") out.push(...checkTests(input));
    else if (check === "ios_destination") out.push(...checkIosDestination(input));
  }
  return out;
}
