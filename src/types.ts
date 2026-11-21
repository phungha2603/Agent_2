export type Stage =
  | "ideation"
  | "checkpoint_idea"
  | "architecture"
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

export interface Agent {
  readonly role: RoleName;
  send(prompt: string, context: TaskContext): Promise<AgentResponse>;
}

/** Everything an agent needs to see to act on the current task. */
export interface TaskContext {
  title: string;
  ideaBrief?: string;
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

export interface TaskRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  stage: Stage;
  context: TaskContext;
  history: HistoryEntry[];
  implementationAttempts: number;
  reviewRejections: number;
}
