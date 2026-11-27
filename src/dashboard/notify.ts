import { execFile } from "node:child_process";

/** Tells the CEO something needs them (or finished) while they're not looking at the dashboard. */
export type Notifier = (title: string, body: string) => void;

const BATCH_MS = 4000;

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").slice(0, 240);
}

/**
 * macOS notifications (Notification Center, with a sound), batched: events
 * within a few seconds of each other — a plan's tasks reaching their
 * checkpoints together — become one notification instead of a burst.
 * Undefined off macOS or with NOTIFY=0.
 */
export function createMacNotifier(opts: { platform?: string; env?: NodeJS.ProcessEnv; show?: (title: string, body: string) => void } = {}): Notifier | undefined {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== "darwin" || env.NOTIFY === "0") return undefined;
  const show =
    opts.show ??
    ((title: string, body: string) => {
      const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}" sound name "Glass"`;
      execFile("osascript", ["-e", script], () => {
        /* a failed notification must never affect the run */
      });
    });
  let pending: { title: string; body: string }[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    const batch = pending;
    pending = [];
    if (batch.length === 1) show(`AI Company · ${batch[0].title}`, batch[0].body);
    else if (batch.length > 1) show(`AI Company · ${batch.length} cập nhật`, batch.map((e) => `${e.title}: ${e.body}`).join(" · "));
  };
  return (title, body) => {
    pending.push({ title, body });
    if (!timer) {
      timer = setTimeout(flush, BATCH_MS);
      timer.unref?.();
    }
  };
}
