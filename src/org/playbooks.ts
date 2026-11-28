import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { roleById, teamById } from "./roles.js";

/** playbooks/ at the repository root — resolved from this file, not the working directory. */
export const PLAYBOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../playbooks");

export type SectionKey = "skills" | "design" | "code" | "review" | "boundaries" | "lessons";

/** The "## …" headings a playbook uses, and what each one feeds. */
export const SECTION_HEADINGS: Record<string, SectionKey> = {
  "Năng lực": "skills",
  "Khi thiết kế": "design",
  "Khi viết code": "code",
  "Khi review": "review",
  "Không làm": "boundaries",
  "Bài học": "lessons",
};
const SECTION_TITLES: Record<SectionKey, string> = {
  skills: "Role capabilities",
  design: "When designing (architecture guide)",
  code: "When writing code",
  review: "When reviewing",
  boundaries: "Out of scope for this role",
  lessons: "Lessons learned (follow these)",
};

/** Which sections each step gets, so a prompt only carries the part of the playbook that step needs. */
export type GuidanceStage = "ideation" | "architecture" | "architecture_review" | "implementation" | "review";
export const STAGE_SECTIONS: Record<GuidanceStage, SectionKey[]> = {
  ideation: ["skills", "boundaries"],
  architecture: ["skills", "design", "boundaries", "lessons"],
  architecture_review: ["design", "review", "lessons"],
  implementation: ["code", "lessons"],
  review: ["review", "lessons"],
};

export interface Playbook {
  slotId: string;
  title: string;
  summary: string;
  sections: Partial<Record<SectionKey, string>>;
  raw: string;
}

export function parsePlaybook(slotId: string, raw: string): Playbook {
  const title = /^#\s+(.+)$/m.exec(raw)?.[1].trim() ?? slotId;
  const summary = /^>\s*Tóm tắt:\s*(.+)$/m.exec(raw)?.[1].trim() ?? "";
  const sections: Partial<Record<SectionKey, string>> = {};
  const parts = raw.split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const key = SECTION_HEADINGS[heading];
    const body = (nl === -1 ? "" : part.slice(nl + 1)).trim();
    if (key && body) sections[key] = body;
  }
  return { slotId, title, summary, sections, raw };
}

const cache = new Map<string, { mtimeMs: number; playbook: Playbook }>();

export function playbookPath(slotId: string): string {
  return path.join(PLAYBOOK_DIR, `${slotId}.md`);
}

/** The role's playbook, re-read whenever the file changes on disk (edits apply to the next step). */
export async function loadPlaybook(slotId: string): Promise<Playbook | undefined> {
  const file = playbookPath(slotId);
  const info = await stat(file).catch(() => undefined);
  if (!info) return undefined;
  const hit = cache.get(slotId);
  if (hit && hit.mtimeMs === info.mtimeMs) return hit.playbook;
  const playbook = parsePlaybook(slotId, await readFile(file, "utf8"));
  cache.set(slotId, { mtimeMs: info.mtimeMs, playbook });
  return playbook;
}

/**
 * The block appended to a step's prompt for a task this role owns: the
 * playbook sections that step uses, plus lessons the CEO accepted for the
 * role. Appended after the step's own instructions (whose first word some
 * callers key on) and framed so it never overrides the evidence rule, the
 * FILES line or CEO directives.
 */
export function formatGuidance(slotId: string, playbook: Playbook | undefined, stage: GuidanceStage, extraLessons: string[] = []): string | undefined {
  const role = roleById(slotId);
  if (!role) return undefined;
  const blocks: string[] = [];
  for (const key of STAGE_SECTIONS[stage]) {
    const body = playbook?.sections[key];
    const extra = key === "lessons" ? extraLessons.map((l) => `- ${l.replace(/\s*\n\s*/g, " ")}`).join("\n") : "";
    const text = [body, extra].filter(Boolean).join("\n");
    if (text) blocks.push(`### ${SECTION_TITLES[key]}\n${text}`);
  }
  if (!blocks.length) return undefined;
  const team = teamById(role.team)?.name ?? role.team;
  return (
    `\n\nROLE PLAYBOOK — this task belongs to ${role.id} (${role.name.replace(/^AI /, "")}, team "${team}"). ` +
    "Apply these role standards on top of the instructions above. They never override the evidence rule, the FILES line, or CEO requests and directives; if they conflict, those win.\n" +
    blocks.join("\n\n") +
    "\n"
  );
}
