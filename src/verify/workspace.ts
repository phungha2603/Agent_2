import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { writeFiles, type ParsedFile } from "../apply/applyFiles.js";

const execFileAsync = promisify(execFile);

/**
 * Where verification runs instead of the real project. The engineer's files
 * are written into a copy and every verification command runs there, so a
 * failing attempt — or a test with side effects, like one that regenerated
 * the real Xcode project from a broken generator — never touches the
 * project. Files reach the project only after verification passes.
 */
export interface IsolationConfig {
  /** Directory holding one shadow copy per project. */
  root: string;
  /**
   * Paths (rsync patterns) neither copied from the project nor deleted from
   * the shadow: build caches the shadow keeps between attempts so an
   * incremental build stays fast.
   */
  exclude: string[];
}

export const DEFAULT_SYNC_EXCLUDE = [".build", ".swiftpm", ".venv", "node_modules", "DerivedData", "build", ".DS_Store"];

/** One shadow per project directory, stable across attempts and restarts. */
export function shadowDirFor(projectDir: string, iso: IsolationConfig): string {
  const abs = path.resolve(projectDir);
  const hash = createHash("sha1").update(abs).digest("hex").slice(0, 10);
  const name = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  return path.join(iso.root, `${name}-${hash}`);
}

/**
 * Makes the shadow an exact copy of the project (minus excluded caches,
 * which are left as they are in the shadow), then writes this attempt's
 * files into it. Returns the shadow's path.
 */
export async function prepareShadow(projectDir: string, iso: IsolationConfig, files: ParsedFile[]): Promise<string> {
  const src = path.resolve(projectDir);
  const dst = shadowDirFor(src, iso);
  await mkdir(src, { recursive: true });
  await mkdir(dst, { recursive: true });
  const excludes = iso.exclude.flatMap((e) => ["--exclude", e]);
  try {
    await execFileAsync("rsync", ["-a", "--delete", ...excludes, `${src}/`, `${dst}/`], { maxBuffer: 10 * 1024 * 1024 });
  } catch (err: any) {
    throw new Error(`Could not copy the project into its verification workspace (${dst}): ${String(err.stderr || err.message).trim().slice(0, 500)}`);
  }
  await writeFiles(dst, files);
  return dst;
}
