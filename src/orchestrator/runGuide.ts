import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface RunGuideInput {
  title: string;
  goal: string;
  dir?: string;
  githubUrl?: string;
  /** Baseline build/test commands of the plan, run from the project root. */
  verifyCommands: string[];
  tasks: { done: number; total: number };
  finishedAt?: string;
}

const README_MAX_CHARS = 12_000;

/** What can be learned from the project folder itself: its stack markers and README. */
export interface ProjectScan {
  exists: boolean;
  entries: string[];
  /** Whether any top-level .py file or package folder (with __init__.py) exists. */
  python: boolean;
  readme?: { name: string; text: string };
  scripts?: Record<string, string>;
}

export function scanProject(dir: string | undefined): ProjectScan {
  if (!dir || !existsSync(dir)) return { exists: false, entries: [], python: false };
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((e) => !e.startsWith("."));
  } catch {
    return { exists: false, entries: [], python: false };
  }
  const readmeName = entries.find((e) => /^readme(\.md|\.txt)?$/i.test(e));
  const readme = readmeName ? { name: readmeName, text: readFileSync(path.join(dir, readmeName), "utf8") } : undefined;
  let scripts: Record<string, string> | undefined;
  if (entries.includes("package.json")) {
    try {
      scripts = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts;
    } catch {
      /* a broken package.json just means no script list */
    }
  }
  const python = entries.some((e) => e.endsWith(".py") || existsSync(path.join(dir, e, "__init__.py")));
  return { exists: true, entries, python, readme, scripts };
}

function stackSteps({ entries, scripts, python }: ProjectScan): string[] {
  const has = (name: string) => entries.includes(name);
  const steps: string[] = [];
  if (has("package.json")) {
    steps.push("**Node.js** — cài thư viện: `npm install`");
    for (const name of ["dev", "start", "build", "test"]) if (scripts?.[name]) steps.push(`\`npm run ${name}\` → \`${scripts[name]}\``);
  }
  if (has("requirements.txt")) steps.push("**Python** — cài thư viện: `python3 -m pip install -r requirements.txt` (nên dùng môi trường ảo `python3 -m venv .venv && source .venv/bin/activate`)");
  else if (has("pyproject.toml")) steps.push("**Python** — cài dự án: `python3 -m pip install -e .`");
  else if (python) steps.push("**Python** — chỉ dùng thư viện chuẩn, không cần cài thêm gì.");
  if (has("Package.swift")) steps.push("**Swift** — build: `swift build` · test: `swift test`");
  const xcode = entries.find((e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"));
  if (xcode) steps.push(`**Xcode** — mở \`${xcode}\` bằng \`open ${xcode}\`, chọn một iPhone simulator rồi bấm Run (⌘R)`);
  if (has("Makefile")) steps.push("**Make** — xem các lệnh có sẵn trong `Makefile` (`make` hoặc `make test`)");
  return steps;
}

/** A Vietnamese how-to-run guide for a finished project, built from the plan and the project folder — no model call. */
export function buildRunGuide(input: RunGuideInput, scan = scanProject(input.dir)): string {
  const lines: string[] = [`# Hướng dẫn chạy: ${input.title}`, ""];
  lines.push(`> ${input.goal.split("\n")[0].trim()}`, "");
  lines.push(`- Trạng thái: ${input.tasks.done}/${input.tasks.total} task xong${input.finishedAt ? ` · hoàn tất ${input.finishedAt.slice(0, 10)}` : ""}`);
  lines.push(`- Thư mục: ${input.dir ? `\`${input.dir}\`` : "chưa ghi nhận"}${input.dir && !scan.exists ? " (không còn tồn tại trên máy này)" : ""}`);
  if (input.githubUrl) lines.push(`- GitHub: ${input.githubUrl}`);
  lines.push("");

  lines.push("## 1. Lấy mã nguồn", "");
  if (input.dir && scan.exists) lines.push("```bash", `cd "${input.dir}"`, "```", "");
  if (input.githubUrl) lines.push("Hoặc trên máy khác:", "", "```bash", `git clone ${input.githubUrl}.git`, `cd ${input.githubUrl.split("/").pop()}`, "```", "");

  const steps = scan.exists ? stackSteps(scan) : [];
  lines.push("## 2. Chuẩn bị môi trường", "");
  lines.push(...(steps.length ? steps.map((s) => `- ${s}`) : ["- Không nhận diện được công nghệ từ thư mục dự án — xem README bên dưới."]), "");

  lines.push("## 3. Kiểm tra dự án chạy đúng", "");
  if (input.verifyCommands.length) {
    lines.push("Đây là các lệnh hệ thống đã dùng để build và kiểm tra mọi task, chạy từ thư mục gốc dự án:", "", "```bash", ...input.verifyCommands, "```", "");
  } else lines.push("Kế hoạch không ghi lệnh kiểm tra nào.", "");

  lines.push("## 4. Chạy và sử dụng", "");
  if (scan.readme) {
    const text = scan.readme.text.trim();
    lines.push(`Theo \`${scan.readme.name}\` của dự án:`, "", "---", "", text.length > README_MAX_CHARS ? `${text.slice(0, README_MAX_CHARS)}\n\n…(còn tiếp trong ${scan.readme.name})` : text, "");
  } else lines.push("Dự án chưa có README — cách chạy chi tiết nằm trong các file kiến trúc (Architecture guide) ở tab Sản phẩm.", "");
  return lines.join("\n");
}
