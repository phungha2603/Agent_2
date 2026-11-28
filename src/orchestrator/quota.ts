/**
 * When a usage-limit error says when the quota comes back ("You've hit your
 * 5-hour limit · resets 7:50pm (Asia/Saigon)"), the moment to try again —
 * a couple of minutes after that time, in this machine's local time, rolled
 * to tomorrow if it has already passed today. Undefined for any other error,
 * which keeps the normal short retries.
 */
export function quotaResumeAt(message: string, now: Date, bufferMs = 2 * 60_000): Date | undefined {
  if (!/(usage|5-hour|weekly|session)?\s*limit|out of usage credits|quota/i.test(message)) return undefined;
  const m = message.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return undefined;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return new Date(at.getTime() + bufferMs);
}

export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
