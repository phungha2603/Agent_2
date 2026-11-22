import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";
import { createInterface } from "node:readline/promises";

// Some networks route IPv6 to Google's hosts but the route is actually
// dead ("No route to host"). dns.setDefaultResultOrder alone isn't enough:
// Node's fetch still races IPv4 and IPv6 ("Happy Eyeballs") regardless of
// that preference, so the dead IPv6 attempts can still eat the whole
// connection timeout. Turning the race off entirely makes it use plain
// IPv4-first resolution instead.
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);
import {
  advance,
  amendShippedTask,
  createTask,
  isTerminal,
  isWaitingForHuman,
  resolveCheckpoint,
  retryFromRejected,
} from "./orchestrator/pipeline.js";
import { loadTask, saveTask } from "./store/taskStore.js";
import { buildAgents, buildPipelineConfig, buildProjectConfigSnapshot } from "./config.js";
import type { TaskRecord } from "./types.js";

const STAGE_LABEL: Record<string, string> = {
  ideation: "Gemini is drafting the idea",
  checkpoint_idea: "Waiting on you: approve the idea?",
  architecture: "Claude is writing the architecture spec",
  implementation: "Muse is implementing",
  verification: "Running real verification commands",
  review_gemini: "Gemini is reviewing the implementation",
  review_claude: "Claude is doing final sign-off",
  checkpoint_final: "Waiting on you: ship it?",
  done: "Done",
  rejected: "Rejected (gave up after max retries)",
};

async function runUntilCheckpoint(task: TaskRecord): Promise<void> {
  const agents = buildAgents();
  const config = buildPipelineConfig();
  while (!isWaitingForHuman(task) && !isTerminal(task)) {
    console.log(`→ ${STAGE_LABEL[task.stage] ?? task.stage}`);
    await advance(task, agents, config);
    await saveTask(task);
  }
  console.log(`\n[${task.id}] stage: ${task.stage} — ${STAGE_LABEL[task.stage] ?? ""}`);
  if (task.stage === "checkpoint_idea" && task.context.ideaBrief) {
    console.log("\n--- Idea brief ---\n" + task.context.ideaBrief);
  }
  if (task.stage === "checkpoint_final") {
    console.log("\n--- Verification log (tail) ---\n" + (task.context.verificationLog ?? "").slice(-1500));
  }
  if (task.stage === "rejected") {
    console.log("\n--- Last feedback ---\n" + (task.context.reviewFeedback ?? []).join("\n"));
  }
}

async function cmdNew(title: string): Promise<void> {
  const task = createTask(title, buildProjectConfigSnapshot());
  await saveTask(task);
  console.log(`Created task ${task.id}`);
  await runUntilCheckpoint(task);
}

async function cmdContinue(id: string, decision?: "approve" | "reject", feedback?: string): Promise<void> {
  const task = await loadTask(id);
  if (isWaitingForHuman(task)) {
    if (!decision) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`${STAGE_LABEL[task.stage]} [y/n]: `);
      rl.close();
      decision = answer.trim().toLowerCase().startsWith("y") ? "approve" : "reject";
    }
    resolveCheckpoint(task, decision === "approve", feedback);
    await saveTask(task);
  } else if (isTerminal(task)) {
    console.log(`Task ${id} is already terminal (${task.stage}).`);
    return;
  }
  await runUntilCheckpoint(task);
}

async function cmdRetry(id: string, clearFeedback: boolean): Promise<void> {
  const task = await loadTask(id);
  retryFromRejected(task, { clearFeedback });
  await saveTask(task);
  await runUntilCheckpoint(task);
}

async function cmdAmend(id: string, change: string): Promise<void> {
  const task = await loadTask(id);
  amendShippedTask(task, change);
  await saveTask(task);
  await runUntilCheckpoint(task);
}

async function cmdStatus(id: string): Promise<void> {
  const task = await loadTask(id);
  console.log(JSON.stringify(task, null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "new":
      await cmdNew(rest.join(" "));
      break;
    case "continue": {
      const [id, flag, ...fb] = rest;
      const decision = flag === "--approve" ? "approve" : flag === "--reject" ? "reject" : undefined;
      await cmdContinue(id, decision, fb.join(" ") || undefined);
      break;
    }
    case "status":
      await cmdStatus(rest[0]);
      break;
    case "retry":
      await cmdRetry(rest[0], rest.includes("--clear-feedback"));
      break;
    case "amend": {
      const [id, ...change] = rest;
      await cmdAmend(id, change.join(" "));
      break;
    }
    default:
      console.log(
        [
          "Usage:",
          '  tsx src/cli.ts new "<idea title>"',
          "  tsx src/cli.ts continue <taskId> [--approve|--reject \"feedback\"]",
          "  tsx src/cli.ts status <taskId>",
          "  tsx src/cli.ts retry <taskId> [--clear-feedback]   (fresh implementation attempt; keeps the last reviewer's feedback unless --clear-feedback)",
          '  tsx src/cli.ts amend <taskId> "<change>"   (reopen an already-shipped task for more work, keeping its history)',
        ].join("\n"),
      );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
