import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { SLOTS, deriveStatus, loadDashboardState } from "./slots.js";
import { enqueueDecision, enqueueRun, enqueueRunAll, queueLength, resetAllSlots } from "./runner.js";
import { loadTask, taskExists } from "../store/taskStore.js";
import type { HistoryEntry, TaskRecord } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DASHBOARD_PORT ?? 4000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function miniLogs(task: TaskRecord | undefined): { at: string; text: string }[] {
  if (!task) return [];
  return task.history
    .slice(-3)
    .map((h: HistoryEntry) => ({ at: new Date(h.at).toTimeString().slice(0, 5), text: h.summary }));
}

app.get("/api/status", async (_req, res) => {
  const state = await loadDashboardState();
  const slots = await Promise.all(
    SLOTS.map(async (slot) => {
      const taskId = state[slot.id];
      const task = taskId && taskExists(taskId) ? await loadTask(taskId) : undefined;
      const status = deriveStatus(task?.stage);
      return {
        id: slot.id,
        name: slot.name,
        icon: slot.icon,
        taskId: taskId ?? null,
        title: task?.context.title ?? null,
        stage: task?.stage ?? null,
        ...status,
        waitingForYou: task ? ["checkpoint_idea", "checkpoint_final"].includes(task.stage) : false,
        checkpointBrief: task?.stage === "checkpoint_idea" ? task.context.ideaBrief : undefined,
        lastFeedback: task?.context.reviewFeedback?.join("\n") || undefined,
        logs: miniLogs(task),
      };
    }),
  );
  res.json({ slots, queueLength: queueLength() });
});

app.post("/api/slots/:id/run", (req, res) => {
  const slot = SLOTS.find((s) => s.id === req.params.id);
  if (!slot) return res.status(404).json({ error: "unknown slot" });
  enqueueRun(slot.id, req.body?.goal);
  res.json({ ok: true });
});

app.post("/api/slots/:id/decision", (req, res) => {
  const slot = SLOTS.find((s) => s.id === req.params.id);
  if (!slot) return res.status(404).json({ error: "unknown slot" });
  const approved = Boolean(req.body?.approved);
  const feedback = typeof req.body?.feedback === "string" ? req.body.feedback : undefined;
  enqueueDecision(slot.id, approved, feedback);
  res.json({ ok: true });
});

app.post("/api/run-all", (req, res) => {
  const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
  if (!goal) return res.status(400).json({ error: "missing goal" });
  enqueueRunAll(goal);
  res.json({ ok: true });
});

app.post("/api/reset", async (_req, res) => {
  await resetAllSlots();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`AI Company dashboard: http://localhost:${PORT}`);
});
