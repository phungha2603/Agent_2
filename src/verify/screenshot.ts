import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

export interface ScreenshotConfig {
  /** The project directory to run the dev server in. */
  cwd: string;
  /** Command that starts a dev server, e.g. "npm run dev". */
  devCommand: string;
  /** URL to open once the server is up, e.g. "http://localhost:5173". */
  url: string;
  outPath: string;
  /** Extra time to let the page settle (animations, async rendering) after load. */
  waitMs?: number;
  /** How long to wait for the dev server to start responding. */
  startupTimeoutMs?: number;
}

/**
 * Starts the project's dev server, waits for it to come up, opens it in a
 * real (headless) browser, takes a screenshot, and always tears the server
 * down afterwards — success or failure.
 */
export async function screenshotDevServer(config: ScreenshotConfig): Promise<string> {
  const [cmd, ...args] = config.devCommand.split(" ");
  const proc = spawn(cmd, args, { cwd: config.cwd, stdio: "ignore" });
  try {
    await waitForServer(config.url, config.startupTimeoutMs ?? 30000);
    return await captureScreenshot({ url: config.url, outPath: config.outPath, waitMs: config.waitMs });
  } finally {
    await stopProcess(proc);
  }
}

async function captureScreenshot(opts: { url: string; outPath: string; waitMs?: number }): Promise<string> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(opts.url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(opts.waitMs ?? 3000);
    await mkdir(path.dirname(opts.outPath), { recursive: true });
    await page.screenshot({ path: opts.outPath });
    return opts.outPath;
  } finally {
    await browser.close();
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Dev server at ${url} did not come up within ${timeoutMs}ms${lastErr ? `: ${lastErr}` : ""}`);
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
