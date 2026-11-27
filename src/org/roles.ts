/**
 * The company's org chart: who sits where, which team they belong to, and
 * what each role actually brings to a task.
 *
 * A role is more than a label. Each one has a playbook (playbooks/<id>.md)
 * whose sections are injected into the prompts of every task that role owns,
 * a model tier (light / standard / strong) that can route its Claude calls to
 * a cheaper or stronger model, and role checks that run during verification
 * on top of the project's own build/test commands.
 *
 * IDs AG-01…AG-10 are the original ten slots and keep their ids (queues,
 * tasks and gates are stored by id); AG-11…AG-16 were added when the company
 * was restructured into five teams.
 */

export type TeamId = "exec" | "eng" | "data" | "quality" | "product";

export interface TeamDef {
  id: TeamId;
  /** Shown on the dashboard. */
  name: string;
  /** The tier-2 lead who owns this team's epics (none for the exec team). */
  leadId?: string;
  /** One line for the planner: what this team is responsible for. */
  mission: string;
  /** The same, in Vietnamese, for the dashboard. */
  description: string;
}

/** Routes a role's Claude calls: "light" → CLAUDE_MODEL_LIGHT, "strong" → CLAUDE_MODEL_STRONG, when those are set. */
export type ModelTier = "light" | "standard" | "strong";

/**
 * Extra checks run during verification for tasks this role owns (see
 * src/verify/roleChecks.ts). They only look at the source files the attempt
 * wrote, so documentation-only work is never held to code rules.
 */
export type RoleCheck = "secrets" | "tests" | "stubs" | "ios_destination";

export interface RoleDef {
  id: string;
  name: string;
  icon: string;
  /** Org-chart rank: 1 = boss (exactly one), 2 = team lead, 3 = staff. */
  tier: 1 | 2 | 3;
  team: TeamId;
  /** One line on the role's specialty, given to the planner when it picks owners. */
  summary: string;
  modelTier: ModelTier;
  checks: RoleCheck[];
  /** Results only hand off after the CEO approves them, unless the CEO turns this off. */
  gatedByDefault?: boolean;
}

export const TEAMS: TeamDef[] = [
  { id: "exec", name: "Điều hành", mission: "Plans the company-wide goal into a work tree and coordinates the teams.", description: "Lập cây công việc và điều phối các khối." },
  { id: "eng", name: "Kỹ thuật", leadId: "AG-05", mission: "Builds the product: overall architecture, backend services, iOS/mobile apps and web UI.", description: "Xây sản phẩm: kiến trúc, backend, app iOS, giao diện web." },
  { id: "data", name: "Dữ liệu & AI", leadId: "AG-11", mission: "Data pipelines, storage schemas, analytics, ML models and their evaluation.", description: "Pipeline dữ liệu, schema, phân tích, model và đánh giá." },
  { id: "quality", name: "Chất lượng & Phát hành", leadId: "AG-08", mission: "Independent testing, security, CI/CD and releases. Checks the other teams' work; does not build features.", description: "Kiểm thử độc lập, bảo mật, CI/CD, phát hành — kiểm tra chứ không xây tính năng." },
  { id: "product", name: "Sản phẩm & Tăng trưởng", leadId: "AG-12", mission: "What to build and for whom: requirements, UX/UI design, market research, content and SEO.", description: "Xây gì, cho ai: yêu cầu, thiết kế UX/UI, nghiên cứu thị trường, nội dung & SEO." },
];

export const ROLES: RoleDef[] = [
  // ---- tier 1
  { id: "AG-01", name: "AI Product Lead", icon: "🚀", tier: 1, team: "exec", modelTier: "standard", checks: [], summary: "Plans the goal into epics and subtasks, picks owners, writes acceptance criteria and verify commands." },

  // ---- tier 2: team leads (in team order)
  { id: "AG-05", name: "AI Tech Lead", icon: "🏗️", tier: 2, team: "eng", modelTier: "strong", checks: ["stubs"], summary: "Overall software architecture and module boundaries; integrates and verifies engineering epics end to end." },
  { id: "AG-11", name: "AI Data Lead", icon: "📊", tier: 2, team: "data", modelTier: "standard", checks: ["stubs"], summary: "Data architecture and data quality; integrates pipelines with models and checks the numbers end to end." },
  { id: "AG-08", name: "AI QA Lead", icon: "🛡️", tier: 2, team: "quality", modelTier: "standard", checks: ["tests"], gatedByDefault: true, summary: "Test strategy and acceptance testing; integrates quality epics and owns the definition of done." },
  { id: "AG-12", name: "AI Product Manager", icon: "🧭", tier: 2, team: "product", modelTier: "standard", checks: [], summary: "Requirements, user stories and scope; integrates product epics and checks they match user needs." },

  // ---- tier 3: engineering
  { id: "AG-13", name: "AI Backend Developer", icon: "🔧", tier: 3, team: "eng", modelTier: "standard", checks: ["tests", "stubs", "secrets"], summary: "Server-side code: APIs, business logic, persistence, auth, background jobs, with unit/integration tests." },
  { id: "AG-14", name: "AI iOS / Mobile Developer", icon: "📱", tier: 3, team: "eng", modelTier: "standard", checks: ["tests", "stubs", "ios_destination"], summary: "Swift/SwiftUI apps, Xcode projects and schemes, Simulator builds, XCTest/XCUITest." },
  { id: "AG-06", name: "AI Frontend / 3D UI", icon: "🖥️", tier: 3, team: "eng", modelTier: "standard", checks: ["stubs"], summary: "Web UI in HTML/CSS/JS/TypeScript, components, state, accessibility, WebGL/Three.js 3D scenes." },

  // ---- tier 3: data & AI
  { id: "AG-03", name: "AI Data Engineer", icon: "🗄️", tier: 3, team: "data", modelTier: "standard", checks: ["tests", "stubs", "secrets"], summary: "ETL/ingestion pipelines, schemas, validation scripts, data files and fixtures, SQL." },
  { id: "AG-04", name: "AI Data Scientist", icon: "🧠", tier: 3, team: "data", modelTier: "standard", checks: ["tests", "stubs"], summary: "Analysis, statistics, ML models, evaluation metrics, scoring/ranking algorithms." },

  // ---- tier 3: quality & release
  { id: "AG-15", name: "AI Security Engineer", icon: "🔐", tier: 3, team: "quality", modelTier: "strong", checks: ["secrets", "stubs"], gatedByDefault: true, summary: "Threat modelling, secure coding fixes, secrets handling, dependency and input-validation review." },
  { id: "AG-07", name: "AI Automation Ops", icon: "⚙️", tier: 3, team: "quality", modelTier: "standard", checks: ["secrets"], summary: "CI/CD workflows, build and test scripts, shell tooling, project generators." },
  { id: "AG-10", name: "AI Release Manager", icon: "🚩", tier: 3, team: "quality", modelTier: "standard", checks: ["secrets"], gatedByDefault: true, summary: "Versioning, release notes/changelog, packaging, build configuration, final release checks." },

  // ---- tier 3: product & growth
  { id: "AG-16", name: "AI UX/UI Designer", icon: "🎨", tier: 3, team: "product", modelTier: "standard", checks: [], summary: "User flows, wireframes as code, design tokens, visual style, usability and accessibility of screens." },
  { id: "AG-02", name: "AI Market Researcher", icon: "🔍", tier: 3, team: "product", modelTier: "light", checks: [], summary: "Users, competitors and market data turned into concrete requirements and sample data." },
  { id: "AG-09", name: "AI Content & SEO", icon: "📢", tier: 3, team: "product", modelTier: "light", checks: [], summary: "Product copy, learning content, documentation pages, SEO metadata and content files." },
];

export function roleById(id: string | undefined): RoleDef | undefined {
  return id ? ROLES.find((r) => r.id === id) : undefined;
}

export function teamById(id: TeamId | undefined): TeamDef | undefined {
  return id ? TEAMS.find((t) => t.id === id) : undefined;
}

/** The team members a lead manages (staff only, in org-chart order). */
export function teamMembers(teamId: TeamId): RoleDef[] {
  return ROLES.filter((r) => r.team === teamId && r.tier === 3);
}
