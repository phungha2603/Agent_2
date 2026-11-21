import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ParsedFile {
  path: string;
  content: string;
}

/**
 * Matches blocks of the form:
 *   FILE: relative/path.ext
 *   ```lang
 *   ...full file content...
 *   ```
 * This is the only format the implementation stage understands — anything
 * else in the agent's reply (prose, explanations) is ignored for the
 * purpose of writing files, but kept in context.implementationDiff for
 * reviewers to read.
 */
const FILE_BLOCK_RE = /^FILE:\s*(.+?)\s*\r?\n```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)\r?\n```/gm;

export function parseFileBlocks(text: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  FILE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_BLOCK_RE.exec(text))) {
    files.push({ path: match[1].trim(), content: match[2] });
  }
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
