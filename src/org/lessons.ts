import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../store/atomicWrite.js";
import type { TaskRecord } from "../types.js";

/**
 * Lessons a role picks up over time. When a task ships after being sent back
 * (review rejections, CEO revisions), its feedback becomes a *pending* lesson
 * for the task's role; the CEO edits it into a general rule and accepts it,
 * or dismisses it. Accepted lessons are added to that role's playbook
 * guidance on every later task. Stored in data/lessons.json — runtime data,
 * next to the tasks — while playbooks/*.md stay the curated standard.
 */
export interface Lesson {
  id: string;
  slotId: string;
  text: string;
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
  decidedAt?: string;
  source?: { taskId: string; title: string };
}

/** Lessons per role carried into prompts (most recent first), so guidance stays short. */
export const MAX_LESSONS_IN_PROMPT = 12;
const MAX_CANDIDATE_CHARS = 1200;

const file = () => path.resolve(process.cwd(), "data/lessons.json");

let chain: Promise<unknown> = Promise.resolve();
/** Serializes read-modify-write cycles on the lessons file. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

export async function loadLessons(): Promise<Lesson[]> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8"));
    return Array.isArray(parsed?.lessons) ? parsed.lessons : [];
  } catch {
    return [];
  }
}

async function save(lessons: Lesson[]): Promise<void> {
  await mkdir(path.dirname(file()), { recursive: true });
  await writeFileAtomic(file(), JSON.stringify({ lessons }, null, 2));
}

async function update(fn: (lessons: Lesson[]) => Lesson | undefined): Promise<Lesson | undefined> {
  return locked(async () => {
    const lessons = await loadLessons();
    const changed = fn(lessons);
    await save(lessons);
    return changed;
  });
}

export async function acceptedLessons(slotId: string): Promise<string[]> {
  return (await loadLessons())
    .filter((l) => l.slotId === slotId && l.status === "accepted")
    .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))
    .slice(0, MAX_LESSONS_IN_PROMPT)
    .map((l) => l.text);
}

export function addLesson(slotId: string, text: string, status: Lesson["status"] = "accepted", source?: Lesson["source"]): Promise<Lesson | undefined> {
  const clean = text.trim();
  if (!clean) throw new Error("Bài học trống.");
  const now = new Date().toISOString();
  return update((lessons) => {
    const lesson: Lesson = { id: randomUUID(), slotId, text: clean, status, createdAt: now, decidedAt: status === "pending" ? undefined : now, source };
    lessons.push(lesson);
    return lesson;
  });
}

export function decideLesson(id: string, decision: "accept" | "dismiss" | "remove", text?: string): Promise<Lesson | undefined> {
  return update((lessons) => {
    const i = lessons.findIndex((l) => l.id === id);
    if (i === -1) throw new Error("Không tìm thấy bài học.");
    if (decision === "remove") return lessons.splice(i, 1)[0];
    const l = lessons[i];
    l.status = decision === "accept" ? "accepted" : "dismissed";
    if (decision === "accept" && text?.trim()) l.text = text.trim();
    l.decidedAt = new Date().toISOString();
    return l;
  });
}

/**
 * A shipped task that needed corrections proposes what its role should take
 * away from them — pending until the CEO turns it into a general rule.
 * Nothing is proposed for a task that went through cleanly.
 */
export async function proposeLessonFrom(task: TaskRecord): Promise<Lesson | undefined> {
  const log = task.feedbackLog ?? [];
  if (!task.slotId || !log.length) return undefined;
  const existing = await loadLessons();
  if (existing.some((l) => l.source?.taskId === task.id && l.status === "pending")) return undefined;
  const rounds = log.length;
  const lines = log.slice(-3).map((f) => `- [${f.by}] ${f.text.replace(/\s+/g, " ").slice(0, 360)}`);
  const text = `Task «${task.context.title}» phải sửa ${rounds} lần trước khi được duyệt. Phản hồi chính:\n${lines.join("\n")}`.slice(0, MAX_CANDIDATE_CHARS);
  return addLesson(task.slotId, text, "pending", { taskId: task.id, title: task.context.title });
}
