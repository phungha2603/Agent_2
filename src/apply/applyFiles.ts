import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ParsedFile {
  path: string;
  content: string;
}

/**
 * Splits the reply on "FILE: relative/path.ext" marker lines — each
 * marker's content is everything up to the next marker (or end of text).
 * Agents don't reliably wrap that content in a ```fenced``` code block
 * despite being asked to, so a wrapping fence is stripped if present but
 * not required. Anything before the first marker (prose, explanations) is
 * ignored for writing files, but the whole reply is still kept in
 * context.implementationDiff for reviewers to read.
 */
const FILE_MARKER_RE = /^FILE:[ \t]*(.+?)[ \t]*\r?$/gm;

export function parseFileBlocks(text: string): ParsedFile[] {
  const markers: { path: string; index: number; contentStart: number }[] = [];
  FILE_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_MARKER_RE.exec(text))) {
    markers.push({ path: match[1].trim(), index: match.index, contentStart: match.index + match[0].length });
  }

  const files: ParsedFile[] = [];
  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    const content = stripCodeFence(text.slice(markers[i].contentStart, end).trim());
    if (content.length > 0) {
      files.push({ path: markers[i].path, content });
    }
  }
  return files;
}

function stripCodeFence(content: string): string {
  const fenced = content.match(/^```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)\r?\n?```$/);
  return fenced ? fenced[1] : content;
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
