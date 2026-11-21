import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { VerificationResult } from "../types.js";

const execAsync = promisify(exec);

export interface VerifyConfig {
  /** Directory to run the commands in (the project Muse is writing code into). */
  cwd: string;
  /** Shell commands run in sequence, e.g. ["npm install", "npm run build", "npm test"]. */
  commands: string[];
}

/**
 * Runs real commands and reports pass/fail from their actual exit codes.
 * This is the only thing allowed to say work is "done" — no agent's own
 * claim of success is trusted.
 */
export async function runVerification(config: VerifyConfig): Promise<VerificationResult> {
  const logs: string[] = [];
  for (const command of config.commands) {
    logs.push(`$ ${command}`);
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: config.cwd,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stdout) logs.push(stdout.trim());
      if (stderr) logs.push(stderr.trim());
    } catch (err: any) {
      logs.push(`FAILED: ${err.message}`);
      if (err.stdout) logs.push(String(err.stdout).trim());
      if (err.stderr) logs.push(String(err.stderr).trim());
      return { passed: false, log: logs.join("\n") };
    }
  }
  return { passed: true, log: logs.join("\n") };
}
