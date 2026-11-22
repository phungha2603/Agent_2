import { rename, unlink, writeFile } from "node:fs/promises";

/**
 * Writes by creating a sibling temp file and renaming it over the target.
 * rename() is atomic on the same filesystem, so a crash or kill mid-write
 * (e.g. Ctrl+C at exactly the wrong moment) can never leave the target
 * truncated or empty — a reader always sees either the old complete
 * content or the new complete content, never something in between that
 * fails JSON.parse.
 */
export async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, "utf8");
  try {
    await rename(tmpPath, targetPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
