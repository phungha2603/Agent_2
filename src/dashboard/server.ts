import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { Company } from "../orchestrator/scheduler.js";
import { buildAgents, buildPipelineConfig, buildProjectConfigSnapshot, buildSchedulerSettings } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 4000);
const SLOT_DEBOUNCE_MS = 120;

// One set of agents for the whole process: in particular one Muse MCP
// server, so there's only ever one Chrome on the Muse profile.
const company = new Company({
  agents: buildAgents(),
  pipeline: buildPipelineConfig(),
  settings: buildSchedulerSettings(),
  projectConfig: buildProjectConfigSnapshot,
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/** Express 4 doesn't catch rejected promises — without this, one bad request crashes the server. */
const route = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

app.get("/api/status", route(async (_req, res) => res.json(await company.statusSnapshot())));

// ---- Server-Sent Events: one card at a time, instead of polling the whole grid ----
const clients = new Set<Response>();
const broadcast = (event: string, data: unknown) => {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(frame);
};

const pendingSlots = new Map<string, NodeJS.Timeout>();
company.on("slot", (slotId: string) => {
  if (pendingSlots.has(slotId)) return;
  pendingSlots.set(
    slotId,
    setTimeout(async () => {
      pendingSlots.delete(slotId);
      if (clients.size) broadcast("slot", await company.slotSnapshot(slotId).catch(() => null));
    }, SLOT_DEBOUNCE_MS),
  );
});

let planTimer: NodeJS.Timeout | null = null;
company.on("plan", () => {
  if (planTimer) return;
  planTimer = setTimeout(async () => {
    planTimer = null;
    if (clients.size) broadcast("plan", await company.planSnapshot().catch(() => null));
  }, SLOT_DEBOUNCE_MS);
});

let engineTimer: NodeJS.Timeout | null = null;
company.on("engines", () => {
  if (engineTimer) return;
  engineTimer = setTimeout(() => {
    engineTimer = null;
    broadcast("engines", company.engineSnapshot());
  }, SLOT_DEBOUNCE_MS);
});

company.on("live", (chunk) => broadcast("live", chunk));

app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("retry: 3000\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

// ---- commands ----
const goalOf = (req: Request) => (typeof req.body?.goal === "string" ? req.body.goal : "");
const feedbackOf = (req: Request) => (typeof req.body?.feedback === "string" ? req.body.feedback : undefined);

app.post("/api/slots/:id/run", route(async (req, res) => {
  await company.runSlot(req.params.id, goalOf(req));
  res.json({ ok: true });
}));

app.post("/api/tasks/:id/decision", route(async (req, res) => {
  await company.decide(req.params.id, Boolean(req.body?.approved), feedbackOf(req));
  res.json({ ok: true });
}));

app.post("/api/approve-all", route(async (_req, res) => {
  res.json({ ok: true, approved: await company.approveAllWaiting() });
}));

app.post("/api/tasks/:id/retry", route(async (req, res) => {
  await company.retryTask(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/run-all", route(async (req, res) => {
  const goal = goalOf(req).trim();
  if (!goal) return res.status(400).json({ error: "missing goal" });
  const plan = await company.startPlan(goal);
  res.json({ ok: true, planId: plan.id });
}));

app.post("/api/plan/:id/decision", route(async (req, res) => {
  await company.decidePlan(req.params.id, Boolean(req.body?.approved), feedbackOf(req));
  res.json({ ok: true });
}));

app.post("/api/plan/:id/retry", route(async (req, res) => {
  await company.retryPlan(req.params.id);
  res.json({ ok: true });
}));

app.post("/api/reset", route(async (_req, res) => {
  await company.reset();
  res.json({ ok: true });
}));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: err.message });
});

await company.init();
const server = app.listen(PORT, () => {
  console.log(`AI Company dashboard: http://localhost:${PORT}`);
});

const shutdown = async () => {
  server.close();
  for (const c of clients) c.end();
  await company.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
