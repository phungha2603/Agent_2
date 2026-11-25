import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ParsedFile {
  path: string;
  content: string;
  /** False when the content wasn't inside a fenced code block — it can't be told apart from prose, so it's refused. */
  fenced?: boolean;
}

const FILE_MARKER_RE = /^\s*(?:\*\*|`)?FILE:(?:\*\*|`)?[ \t]*`?([^`\s][^`]*?)`?[ \t]*(?:\*\*)?\s*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;

/**
 * Splits the reply into files on "FILE: relative/path.ext" lines. Each
 * file's content is the first fenced code block after its marker, exactly
 * as written; prose between or after blocks is ignored (an unfenced reply
 * once had the engineer's closing "Verification log ..." notes pasted into
 * the end of a source file). Marker lines inside a code block are content,
 * not markers. A marker with no fenced block still yields an entry, with
 * `fenced: false`, so the caller can refuse it with a reason instead of
 * silently writing nothing.
 */
export function parseFileBlocks(text: string): ParsedFile[] {
  const lines = text.split(/\r?\n/);
  const files: ParsedFile[] = [];
  let current: { path: string; raw: string[]; code?: string[]; done: boolean; loose?: boolean } | undefined;
  let fence: { char: string; len: number } | undefined;

  const flush = () => {
    if (!current) return;
    // An unclosed block means the reply was cut off mid-file.
    if (current.code) files.push({ path: current.path, content: current.code.join("\n") + "\n", fenced: current.done && !current.loose });
    else {
      const raw = current.raw.join("\n").trim();
      if (raw) files.push({ path: current.path, content: raw, fenced: false });
    }
  };

  for (const line of lines) {
    if (fence) {
      const close = line.trim();
      if (close.length >= fence.len && close === fence.char.repeat(close.length)) {
        fence = undefined;
        if (current && !current.done) current.done = true;
      } else if (current && !current.done && current.code) {
        current.code.push(line);
      }
      continue;
    }
    const marker = line.match(FILE_MARKER_RE);
    if (marker) {
      flush();
      current = { path: marker[1].trim(), raw: [], done: false };
      continue;
    }
    const open = line.match(FENCE_OPEN_RE);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      if (current && !current.done && !current.code) {
        current.code = [];
        // A language label line before the block is normal; several lines of
        // text are not — that's a file whose own fence was lost (e.g. Muse's
        // Copy output), and this block is one nested inside it.
        current.loose = current.raw.filter((l) => l.trim()).length > 2;
      }
      else if (current && !current.done) current.done = true;
      continue;
    }
    if (current && !current.done && !current.code) current.raw.push(line);
  }
  flush();
  return files;
}

/** Writes parsed files under `cwd`, refusing to write outside it. */
export async function writeFiles(cwd: string, files: ParsedFile[]): Promise<string[]> {
  const root = path.resolve(cwd);
  const written: string[] = [];
  for (const file of files) {
    const target = path.resolve(root, file.path);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Refusing to write outside the project directory: ${file.path}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
    written.push(file.path);
  }
  return written;
}
