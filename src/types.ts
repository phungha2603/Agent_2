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

export interface AgentResponse {
  role: RoleName;
  content: string;
  /** Structured verdict for review-type stages; absent for free-form output. */
  verdict?: "approve" | "reject";
}

export interface SendOptions {
  /** Called with each piece of output as it arrives, for agents that can stream. */
  onChunk?: (text: string) => void;
  /** Which task (or "plan:<id>") this call is for — used for engine activity tracking. */
  taskId?: string;
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
  architectureSpec?: string;
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
  screenshotWaitMs?: number;
}

export interface TaskError {
  at: string;
  stage: Stage;
  message: string;
  attempts: number;
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
}
