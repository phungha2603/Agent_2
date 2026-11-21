import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

export interface ScreenshotConfig {
  /** The project directory (same as the verification cwd). */
  cwd: string;
  /** The built output directory to serve, relative to cwd (e.g. "dist"). */
  buildDir: string;
  outPath: string;
  /** Extra time to let the page settle (animations, async rendering) after load. */
  waitMs?: number;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serves `buildDir` as static files on a fresh, randomly assigned port,
 * screenshots it, then shuts the server down. Serving the already-built
 * output directly — rather than starting the project's own dev server —
 * means there's nothing that can be left running from a previous attempt
 * and silently keep answering with stale content: a new port is picked
 * every single call, so a screenshot can only ever reflect what's on disk
 * right now.
 */
export async function screenshotBuildOutput(config: ScreenshotConfig): Promise<string> {
  const rootDir = path.resolve(config.cwd, config.buildDir);
  const { url, close } = await startStaticServer(rootDir);
  try {
    return await captureScreenshot({ url, outPath: config.outPath, waitMs: config.waitMs });
  } finally {
    await close();
  }
}

async function startStaticServer(rootDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const indexPath = path.join(rootDir, "index.html");

  const server = createServer(async (req, res) => {
    try {
      const reqPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      let filePath = path.join(rootDir, reqPath);
      if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      try {
        if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, "index.html");
      } catch {
        // doesn't exist as-is; fall through to the SPA fallback below
      }

      let data: Buffer;
      let servedPath = filePath;
      try {
        data = await readFile(filePath);
      } catch {
        data = await readFile(indexPath); // SPA-style fallback for client-side routing
        servedPath = indexPath;
      }
      const contentType = MIME_TYPES[path.extname(servedPath).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    } catch (err) {
      res.writeHead(500);
      res.end(`Static server error: ${(err as Error).message}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
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
