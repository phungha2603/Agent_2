import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { Company, isUserError } from "../orchestrator/scheduler.js";
import { buildAgents, buildPipelineConfig, buildProjectConfigSnapshot, buildSchedulerSettings } from "../config.js";
import { basicAuth, isLoopback } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 4000);
// Loopback by default: reachable from this machine only (and from a tunnel
// or reverse proxy running on it). Exposing it on a network interface is an
// explicit choice, and then a login is required — see below.
const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const AUTH_USER = process.env.DASHBOARD_USER;
const AUTH_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SLOT_DEBOUNCE_MS = 120;

if (!isLoopback(HOST) && !(AUTH_USER && AUTH_PASSWORD)) {
  console.error(
    `Refusing to listen on ${HOST} without a login: anyone who reaches the dashboard can make the agents write and run code. ` +
      "Set DASHBOARD_USER and DASHBOARD_PASSWORD, or keep DASHBOARD_HOST=127.0.0.1 behind a tunnel/proxy.",
  );
  process.exit(1);
}
const SUMMARY_DEBOUNCE_MS = 400;

// One set of agents for the whole process: in particular one Muse MCP
// server, so there's only ever one Chrome on the Muse profile.
const company = new Company({
  agents: buildAgents(),
  pipeline: buildPipelineConfig(),
  settings: buildSchedulerSettings(),
  projectConfig: buildProjectConfigSnapshot,
});

const app = express();
app.disable("x-powered-by");
// For uptime checks; says nothing about the company.
app.get("/healthz", (_req, res) => res.json({ ok: true }));
if (AUTH_USER && AUTH_PASSWORD) app.use(basicAuth(AUTH_USER, AUTH_PASSWORD));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/** Express 4 doesn't catch rejected promises — without this, one bad request crashes the server. */
const route = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

app.get("/api/status", route(async (_req, res) => res.json(await company.statusSnapshot())));
app.get("/api/timeline", route(async (_req, res) => res.json(await company.timeline())));
app.get("/api/tasks/:id/detail", route(async (req, res) => res.json(await company.taskDetail(req.params.id))));
app.get("/api/artifacts", route(async (_req, res) => res.json(await company.listArtifacts())));
app.get("/api/artifacts/content", route(async (req, res) => {
  const art = await company.artifactContent(String(req.query.taskId), String(req.query.kind) as any, str(req.query.path));
  if (req.query.download) {
    res.setHeader("Content-Disposition", `attachment; filename="${art.filename.replace(/"/g, "")}"`);
    res.type("text/plain").send(art.content);
  } else {
    res.json(art);
  }
}));

// ---- Server-Sent Events: one card at a time, instead of polling the whole grid ----
const clients = new Set<Response>();
const broadcast = (event: string, data: unknown) => {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(frame);
};

function debounced(ms: number, fn: () => Promise<void> | void): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (clients.size) await Promise.resolve(fn()).catch(() => {});
    }, ms);
  };
}

// Telemetry and the bottleneck/handoff summary depend on every slot — recompute them at most a few times a second.
const pushSummary = debounced(SUMMARY_DEBOUNCE_MS, async () => {
  broadcast("telemetry", await company.telemetry());
  broadcast("insights", await company.insights());
  broadcast("control", company.control());
});

const pendingSlots = new Map<string, NodeJS.Timeout>();
company.on("slot", (slotId: string) => {
  pushSummary();
  if (pendingSlots.has(slotId)) return;
  pendingSlots.set(
    slotId,
    setTimeout(async () => {
      pendingSlots.delete(slotId);
      if (clients.size) broadcast("slot", await company.slotSnapshot(slotId).catch(() => null));
    }, SLOT_DEBOUNCE_MS),
  );
});
company.on("plan", debounced(SLOT_DEBOUNCE_MS, async () => broadcast("plan", await company.planSnapshot())));
company.on("engines", debounced(SLOT_DEBOUNCE_MS, () => broadcast("engines", company.engineSnapshot())));
company.on("control", pushSummary);
company.on("rebalance", debounced(SLOT_DEBOUNCE_MS, () => broadcast("rebalance", company.rebalanceSnapshot())));
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
const ok = (res: Response, extra?: object | void) => res.json({ ok: true, ...(extra ?? {}) });

app.post("/api/slots/:id/run", route(async (req, res) => ok(res, await company.runSlot(req.params.id, str(req.body?.goal)))));
app.post("/api/slots/:id/gate", route(async (req, res) => ok(res, await company.setGate(req.params.id, Boolean(req.body?.enabled)))));

app.post("/api/tasks/:id/decision", route(async (req, res) => {
  const action = str(req.body?.action) ?? (req.body?.approved ? "approve" : "reject");
  if (!["approve", "reject", "revise"].includes(action)) return res.status(400).json({ error: "action phải là approve, reject hoặc revise" });
  await company.decide(req.params.id, action as "approve" | "reject" | "revise", str(req.body?.feedback));
  ok(res);
}));
app.post("/api/tasks/:id/retry", route(async (req, res) => ok(res, await company.retryTask(req.params.id))));
app.post("/api/tasks/:id/move", route(async (req, res) => {
  await company.moveTask(req.params.id, String(req.body?.toSlot), req.body?.position === "top" ? "top" : "bottom");
  ok(res);
}));
app.post("/api/approve-all", route(async (_req, res) => ok(res, { approved: await company.approveAllWaiting() })));

app.post("/api/steer", route(async (req, res) => {
  const directive = await company.steer(str(req.body?.slotId) ?? null, String(req.body?.text ?? ""), Boolean(req.body?.redo));
  ok(res, { directive });
}));
app.post("/api/steer/:id/remove", route(async (req, res) => ok(res, await company.removeDirective(req.params.id))));

app.post("/api/artifacts/send", route(async (req, res) => {
  const result = await company.sendArtifact(
    { taskId: String(req.body?.taskId), kind: req.body?.kind, path: str(req.body?.path) },
    String(req.body?.toSlot),
    str(req.body?.note),
  );
  ok(res, result);
}));

app.post("/api/engines/:engine/promote", route(async (req, res) => {
  await company.promote(req.params.engine as any, String(req.body?.id ?? ""));
  ok(res);
}));
app.post("/api/rebalance", route(async (_req, res) => ok(res, { proposal: await company.proposeRebalance() })));
app.post("/api/rebalance/:id/apply", route(async (req, res) => {
  const indexes = Array.isArray(req.body?.indexes) ? req.body.indexes.map(Number) : undefined;
  ok(res, await company.applyRebalance(req.params.id, indexes));
}));
app.post("/api/rebalance/dismiss", route(async (_req, res) => ok(res, company.dismissRebalance())));

app.post("/api/control/pause", route(async (_req, res) => ok(res, await company.pause())));
app.post("/api/control/resume", route(async (_req, res) => ok(res, await company.resume())));
app.post("/api/control/stop", route(async (_req, res) => ok(res, await company.stop())));

app.post("/api/run-all", route(async (req, res) => {
  const goal = (str(req.body?.goal) ?? "").trim();
  if (!goal) return res.status(400).json({ error: "Thiếu mục tiêu." });
  const plan = await company.startPlan(goal);
  ok(res, { planId: plan.id });
}));
app.post("/api/plan/:id/decision", route(async (req, res) => ok(res, await company.decidePlan(req.params.id, Boolean(req.body?.approved), str(req.body?.feedback)))));
app.post("/api/plan/:id/retry", route(async (req, res) => ok(res, await company.retryPlan(req.params.id))));
app.post("/api/reset", route(async (_req, res) => ok(res, await company.reset())));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (!isUserError(err)) console.error(err);
  res.status(isUserError(err) ? 400 : 500).json({ error: err.message });
});

await company.init();
const server = app.listen(PORT, HOST, () => {
  console.log(`AI Company dashboard: http://${isLoopback(HOST) ? "localhost" : HOST}:${PORT}${AUTH_USER && AUTH_PASSWORD ? " (login required)" : ""}`);
});

const shutdown = async () => {
  server.close();
  for (const c of clients) c.end();
  await company.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
