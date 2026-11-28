const SIGNAL = /\b(error|errors|failed|failure|FAIL|FAILED|fatal|panic|exception|Traceback|assert\w*|AssertionError|undefined symbols?|not found|cannot|unable to|timed out|killed|Permission denied|exit code|exited with)\b|^\s*E\s{2,}|^\$ |^== /i;
const CONTEXT = 2;

/**
 * The part of a failed verification log the engineer needs to fix it: the
 * commands that ran, every line that reports a failure with a little
 * context, and the log's tail — capped. The full log can run to hundreds of
 * kilobytes (an Xcode build log was 482k characters), almost all of it
 * progress noise, and was sent to the engineer whole on every retry.
 */
export function failureDigest(log: string, maxChars = 6000): string {
  if (log.length <= maxChars) return log;
  const lines = log.split("\n");
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (SIGNAL.test(l)) for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep.add(j);
  });
  for (let j = Math.max(0, lines.length - 15); j < lines.length; j++) keep.add(j);
  const out: string[] = [];
  let last = -1;
  let size = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i].length > 400 ? `${lines[i].slice(0, 400)} …` : lines[i];
    if (last !== -1 && i > last + 1) out.push(`… (${i - last - 1} line(s) omitted)`);
    out.push(line);
    size += line.length + 1;
    last = i;
    if (size > maxChars) {
      out.push("… (digest truncated)");
      break;
    }
  }
  return `[Digest of a ${lines.length}-line verification log: the commands, every failure line with context, and the tail]\n${out.join("\n")}`;
}
