import type { Agent } from "../types.js";

export interface DepartmentBrief {
  id: string;
  name: string;
}

/**
 * Splits a reply on "DEPT: <id>" marker lines, mirroring how applyFiles.ts
 * splits on "FILE:" markers — each marker's sub-goal is everything up to
 * the next marker (or the end of the reply). Agents don't reliably stick to
 * a strict format, so a marker that's missing or malformed for a given
 * department simply isn't in the returned map; the caller decides the
 * fallback for whatever's missing instead of this throwing or guessing.
 */
const DEPT_MARKER_RE = /^DEPT:[ \t]*(.+?)[ \t]*\r?$/gm;

export function parseDepartmentGoals(text: string): Record<string, string> {
  const markers: { id: string; index: number; contentStart: number }[] = [];
  DEPT_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DEPT_MARKER_RE.exec(text))) {
    markers.push({ id: match[1].trim(), index: match.index, contentStart: match.index + match[0].length });
  }

  const goals: Record<string, string> = {};
  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    const goal = text.slice(markers[i].contentStart, end).trim();
    if (goal.length > 0) goals[markers[i].id] = goal;
  }
  return goals;
}

export interface DelegationResult {
  /** slotId -> that department's sub-goal, only for departments the boss's reply actually covered. */
  goals: Record<string, string>;
  raw: string;
}

/**
 * The "boss" (tier-1 slot, Claude per the org chart) reads the company-wide
 * goal and writes one specific sub-goal per department so the departments'
 * work is complementary rather than ten copies of the same thing. Any
 * department missing from the reply is the caller's job to fall back for —
 * this never throws just because the boss's reply was incomplete.
 */
export async function decomposeGoalForDepartments(
  boss: Agent,
  companyGoal: string,
  departments: DepartmentBrief[],
): Promise<DelegationResult> {
  const list = departments.map((d) => `- ${d.id}: ${d.name}`).join("\n");
  const prompt =
    "You are the boss of this AI company, coordinating the whole team. A company-wide goal just came in. " +
    "Break it into one concrete, non-overlapping sub-goal per department below, so their work complements each other instead of each department doing the same thing. " +
    `Company-wide goal: "${companyGoal}"\n\nDepartments:\n${list}\n\n` +
    "Reply with exactly one block per department, in this format, repeated for every department listed above:\n" +
    "DEPT: <department id>\n<that department's specific sub-goal, one or more lines>\n\n" +
    "Cover every department listed — don't skip any, and don't invent new ones.";
  const res = await boss.send(prompt, { title: companyGoal });
  return { goals: parseDepartmentGoals(res.content), raw: res.content };
}
