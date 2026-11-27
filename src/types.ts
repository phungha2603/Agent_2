export type Stage =
  | "ideation"
  | "checkpoint_idea"
  | "architecture"
  | "architecture_review"
  | "implementation"
  | "verification"
  | "review_gemini"
  | "review_claude"
  | "checkpoint_final"
  | "done"
  | "rejected";

export type RoleName = "gemini" | "claude" | "muse" | "ceo" | "system";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Set when the provider reports it (the Claude CLI does) or a price is configured. */
  costUsd?: number;
  /** True when counted from text length because the provider reported nothing (Muse, mocks). */
  estimated?: boolean;
}

export interface AgentResponse {
  role: RoleName;
  content: string;
  /** Structured verdict for review-type stages; absent for free-form output. */
  verdict?: "approve" | "reject";
  usage?: Usage;
}

export interface SendOptions {
  /** Called with each piece of output as it arrives, for agents that can stream. */
  onChunk?: (text: string) => void;
  /** Which task (or "plan:<id>") this call is for — used for engine activity tracking. */
  taskId?: string;
  /** Aborts the call in flight (Stop). */
  signal?: AbortSignal;
  /** The project directory this call is about — where an agent that can read files runs. */
  cwd?: string;
  /** Tool list for this call only (Claude CLI), e.g. "Read,Grep,Glob"; unset = the agent's own setting. */
  tools?: string;
  /**
   * Cap on agentic turns for a call that has tools (Claude CLI --max-turns).
   * Each file the model opens is another turn that re-sends the whole
   * context — the reason a ~4k-token prompt cost ~286k input tokens.
   */
  maxTurns?: number;
  /** Model for this call only (Claude); unset = the agent's configured model. */
  model?: string;
}

export interface Agent {
  readonly role: RoleName;
  send(prompt: string, context: TaskContext, opts?: SendOptions): Promise<AgentResponse>;
  close?(): Promise<void>;
}

/**
 * What a finished task hands to the tasks that depend on it — computed once
 * when it reaches the handoff point and copied into each dependent's
 * context, rather than every dependent re-reading the upstream task's full
 * history.
 */
export interface HandoffArtifact {
  taskId: string;
  slotId?: string;
  title: string;
  acceptanceCriteria: string[];
  files: string[];
  specExcerpt: string;
  at: string;
}

/** Everything an agent could need to see — pruned per stage before it's sent (see contextPruning.ts). */
export interface TaskContext {
  title: string;
  ideaBrief?: string;
  /** Plan-level context shared by every task in the same plan (goal, epic, teammates' work). */
  sharedBrief?: string;
  /** Testable statements the result must satisfy; reviewers check each one. */
  acceptanceCriteria?: string[];
  /** Results handed over by the tasks this one depends on. */
  upstream?: HandoffArtifact[];
  /** CEO steering instructions, company-wide and for this task's slot — they override earlier instructions. */
  directives?: string[];
  /**
   * The CEO's revision requests for this task, kept until it ships. Review
   * feedback is replaced every round, so a request that lived only there was
   * gone by the time the reviewers looked — and an unmet one got approved.
   */
  ceoRequests?: string[];
  /** Material the CEO forwarded to this task from another agent's output. */
  attachments?: { title: string; from: string; content: string }[];
  architectureSpec?: string;
  /** Current contents of the project files this task is about, read from disk just before the call. */
  projectFiles?: { path: string; content: string; truncated?: boolean }[];
  implementationDiff?: string;
  implementationFiles?: string[];
  verificationLog?: string;
  reviewFeedback?: string[];
  /** Path to an image Gemini generated as the visual style target, if configured. */
  referenceImagePath?: string;
  /** Path to a real screenshot of the running implementation, if configured. */
  implementationScreenshotPath?: string;
}

export interface HistoryEntry {
  stage: Stage;
  at: string; // ISO timestamp
  by: RoleName;
  summary: string;
}

export interface VerificationResult {
  passed: boolean;
  log: string;
}

/**
 * The project-specific settings a task was created with — snapshotted at
 * creation time so that later changes to .env (switching to a different
 * project, a different REFERENCE_IMAGE_PROMPT, etc.) don't silently affect
 * a task that's already in flight. Absent on tasks created before this
 * existed, which fall back to reading the live config (the old behavior).
 */
export interface ProjectConfig {
  verifyCwd: string;
  verifyCommands: string[];
  /** Unset means this task was never configured for the visual review loop. */
  referenceImagePrompt?: string;
  referenceImagePath?: string;
  screenshotPath?: string;
  /** Built output directory to screenshot, relative to verifyCwd (e.g. "dist"). */
  buildDir?: string;
  /** When dependents may start: once this task reaches the final checkpoint, or only once the CEO approved it. Unset = company setting. */
  handoffOn?: "checkpoint_final" | "done";
  /** Ship the result without waiting for the CEO when everything is green (no red warning; reviewers approved). */
  autoApprove?: boolean;
  /** Skip Claude's final review when Gemini approved, nothing is flagged, and it isn't an integration task or a CEO revision. */
  skipClaudeReviewWhenGreen?: boolean;
  screenshotWaitMs?: number;
}

/** One attempt at one stage: what the timeline, the per-card duration/token figures and the critical path are built from. */
export interface StageRun {
  stage: Stage;
  startedAt: string;
  endedAt?: string;
  outcome?: "ok" | "error" | "cancelled";
  /** Time spent waiting for an engine or the workspace lock rather than working. */
  waitMs: number;
  engines: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimated: boolean;
  /** A span spent waiting at a checkpoint for the CEO, not an agent run (no engines, no tokens). */
  human?: boolean;
  /** How the CEO resolved that checkpoint. */
  decision?: "approve" | "reject" | "revise";
  /** Per-engine split, for the telemetry bar (a review_gemini stage can fall back to Claude). */
  usageByEngine?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
  error?: string;
}

/** Why something happened to a task — assignment rationale, reassignments, gates, directives. */
export interface TraceEntry {
  at: string;
  by: string;
  kind: "assign" | "reassign" | "priority" | "directive" | "gate" | "revise" | "recovery" | "input" | "note";
  text: string;
}

/**
 * Something the CEO should know before shipping, shown on the card and in
 * the final approval box. "warn" ones make Ship ask for a second
 * confirmation. One per kind — a newer one of the same kind replaces it.
 */
export interface TaskAlert {
  kind: "no_files" | "files_rejected" | "files_broken" | "verify_coverage" | "verify_unconfigured" | "spec_rewritten" | "gemini_down" | "files_overwritten";
  level: "warn" | "info";
  at: string;
  stage: Stage;
  /** Vietnamese, for the dashboard. */
  text: string;
}

export interface TaskError {
  at: string;
  stage: Stage;
  message: string;
  attempts: number;
  /** Set when the error was a usage limit with a known reset time: the task resumes by itself then. */
  resumeAt?: string;
}

export interface TaskRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  stage: Stage;
  context: TaskContext;
  history: HistoryEntry[];
  implementationAttempts: number;
  reviewRejections: number;
  /** Rounds of the Claude/Gemini architecture discussion so far. Optional for tasks created before this existed. */
  architectureRounds?: number;
  /** Times this task was automatically sent back to architecture after exhausting its retry budget. */
  autoRecoveries?: number;
  projectConfig?: ProjectConfig;
  /** Dashboard slot this task belongs to, if any. */
  slotId?: string;
  /** Tasks that must hand off before this one can start. */
  dependsOn?: string[];
  planRef?: { planId: string; epicId: string; subtaskId?: string };
  /** Set once this task's result is ready for dependents. */
  handoff?: HandoffArtifact;
  /**
   * A runtime failure (agent call threw, CLI missing, network down) that
   * survived the automatic stage retries — kept apart from reviewFeedback so
   * it's never fed to the next agent as if it were review feedback. The task
   * stays paused until retried.
   */
  lastError?: TaskError;
  /** When the current stage started — drives the elapsed-time display. */
  stageStartedAt?: string;
  runs?: StageRun[];
  trace?: TraceEntry[];
  /** Warnings for the CEO gathered during the current run (cleared when a checkpoint sends the task on). */
  alerts?: TaskAlert[];
  /** A CEO directive asking to redo the work, applied once the stage currently running finishes. */
  redoRequested?: string;
}
