/* AI Agent Company dashboard — one page, patched in place from Server-Sent Events. */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const goalInput = $("#goal-input");
const fitGoalInput = () => {
  goalInput.style.height = "auto";
  goalInput.style.height = `${goalInput.scrollHeight + 2}px`;
};
goalInput.addEventListener("input", fitGoalInput);
const toastEl = $("#toast");
const LIVE_CHARS = 1500;

const QUEUE_LABEL = {
  running: "Đang chạy",
  waiting_you: "Chờ bạn duyệt",
  error: "Lỗi — tạm dừng",
  rejected: "Bị từ chối",
  blocked: "Bị chặn",
  waiting_deps: "Chờ đầu vào",
  queued: "Trong hàng đợi",
  done: "Xong",
};
const ENGINE_LABEL = { claude: "Claude", gemini: "Gemini", muse: "Muse", workspace: "Thư mục dự án" };
const PLAN_STATUS = {
  drafting: "Đang lập kế hoạch",
  awaiting_approval: "Chờ bạn duyệt kế hoạch",
  approved: "Đã duyệt — đang triển khai",
  failed: "Lập kế hoạch thất bại",
  discarded: "Đã huỷ",
};
const PHASES = ["Mục tiêu", "Phân tích", "Kỹ thuật", "Kiểm thử", "Chờ duyệt", "Xuất bản"];
const STAGE_PHASE = {
  ideation: "Phân tích",
  checkpoint_idea: "Phân tích",
  architecture: "Phân tích",
  architecture_review: "Phân tích",
  implementation: "Kỹ thuật",
  verification: "Kiểm thử",
  review_gemini: "Kiểm thử",
  review_claude: "Kiểm thử",
  checkpoint_final: "Chờ duyệt",
  done: "Xuất bản",
  rejected: "Kiểm thử",
};
const PHASE_CLASS = { "Phân tích": "ph-analysis", "Kỹ thuật": "ph-build", "Kiểm thử": "ph-test", "Chờ duyệt": "ph-review", "Xuất bản": "ph-ship" };
const TRACE_LABEL = {
  assign: "Giao việc",
  reassign: "Gán lại",
  priority: "Ưu tiên",
  directive: "Chỉ thị",
  gate: "Cổng duyệt",
  revise: "Yêu cầu sửa",
  recovery: "Tự phục hồi",
  input: "Nhận đầu vào",
  note: "Ghi chú",
};

const state = {
  slots: new Map(),
  plan: null,
  engines: null,
  telemetry: null,
  insights: null,
  control: { paused: false, directives: [], gates: {} },
  view: "org",
  filter: "all",
  showAllEdges: false,
  hoverSlot: null,
  /** Agent pinned with 🎯: unrelated cards stay dimmed until cleared. */
  focusSlot: null,
  engineModal: null,
  inbox: { open: false, tab: "waiting", sig: "" },
  /** Waiting items the CEO chose to look at later ("Bỏ qua"). */
  snoozed: new Set(),
  tl: { group: "agent", color: "status", range: "all", statuses: new Set(["running", "review", "error", "stopped", "done"]), agents: null, collapsed: new Set() },
  tlSpans: [],
  /** slotId -> taskId chosen in that card's queue */
  selected: new Map(),
  live: new Map(),
  liveStage: new Map(),
  liveTotal: new Map(),
  /** ids of <details> the user opened, so re-renders keep them open */
  open: new Set(),
  drawer: { taskId: null, tab: "overview", detail: null, sig: "" },
  artifacts: { list: [], selected: null, agent: "", q: "" },
  timeline: null,
  rebalance: null,
  /** Composer ("Dự án mới") open state: null = follow the plan automatically, true/false = the user's choice until the plan changes. */
  composer: { manual: null, sig: "" },
  /** Org chart: "compact" node cards or the full "detailed" cards. */
  orgDensity: localStorage.getItem("dash-org-density") === "detailed" ? "detailed" : "compact",
  /** Which tab the org view's side column shows: the plan tree or hand-offs & bottlenecks. */
  sideTab: "plan",
  /** leadId -> staff ids (see computeTeams). */
  teams: new Map(),
  /** The company's teams as the server defines them: { id, name, leadId, mission }. */
  teamsDef: [],
  /** Lesson counts per role: { pending: {slotId: n}, accepted: {slotId: n} }. */
  lessons: { pending: {}, accepted: {} },
  /** The role panel (playbook + lessons) — which role, which tab, what the server sent. */
  role: { slotId: null, tab: "playbook", detail: null },
  scoreboard: null,
};

// ---------- utils ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
function elapsed(sinceIso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(sinceIso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}
function fmtTok(n) {
  if (!n) return "0";
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
function fmtCost(n) {
  return n ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : "$0";
}
function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "";
}
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 5000);
}
async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error || `Lỗi ${res.status}`);
    return null;
  }
  return data;
}
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
function findTaskSnapshot(taskId) {
  for (const slot of state.slots.values()) {
    const t = slot.tasks?.find((x) => x.id === taskId);
    if (t) return t;
  }
  return state.drawer.detail?.snapshot?.id === taskId ? state.drawer.detail.snapshot : null;
}

/** Which plan a task belongs to — tasks of different plans can share a title ("E3.S1"). */
function planTag(ref) {
  if (!ref?.planId) return "";
  return ` <span class="plan-tag" title="Kế hoạch ${esc(ref.planId)}">KH·${esc(ref.planId.slice(-4))}</span>`;
}

function redAlerts(t) {
  return t && t.stage === "checkpoint_final" ? (t.alerts ?? []).filter((a) => a.level === "warn").map((a) => a.text) : [];
}

/** The warnings gathered during this task's run: red ones block a one-click ship. */
function alertsBlock(t) {
  const alerts = t?.alerts ?? [];
  if (!alerts.length) return "";
  return alerts
    .map((a) => `<div class="feedback-box ${a.level === "warn" ? "is-error" : "alert-info"}">${a.level === "warn" ? "⚠" : "ℹ"} ${esc(a.text)}</div>`)
    .join("");
}

function shipWarningNote(t) {
  const n = redAlerts(t).length;
  return n ? `<div class="gate-note ship-warn">⚠ Có ${n} cảnh báo đỏ — bấm Duyệt sẽ phải xác nhận thêm một lần.</div>` : "";
}

/** Where the plan's code goes and how it's verified — editable in the plan panel, a summary in the inbox. */
function planProjectBlock(plan, editable) {
  const p = plan.project ?? { dir: "", verifyCommands: [], warnings: [] };
  const warnings = [...(p.warnings ?? []), ...(p.commandWarnings ?? [])].map((w) => `<div class="feedback-box is-error">⚠ ${esc(w)}</div>`).join("");
  const missing = !p.verifyCommands?.length ? `<div class="feedback-box is-error">⚠ Chưa có lệnh kiểm tra — không duyệt được cho tới khi điền.</div>` : "";
  if (!editable) {
    return `<div class="plan-project small"><div>📁 <code>${esc(p.dir || "(chưa chọn)")}</code>${p.autoApprove ? ` · <span class="why">⚡ tự duyệt khi xanh</span>` : ""}${p.skipClaudeReviewWhenGreen ? ` · <span class="why">bỏ Claude review khi xanh</span>` : ""}${p.githubUrl ? ` · <a href="${esc(p.githubUrl)}" target="_blank" rel="noopener">GitHub</a>` : p.githubRepo ? ` · <span class="why">sẽ tạo repo GitHub</span>` : ""}</div><div>🧪 ${p.verifyCommands?.length ? p.verifyCommands.map((c) => `<code>${esc(c)}</code>`).join(" → ") : "<em>chưa có lệnh</em>"}</div>${warnings}${missing}</div>`;
  }
  return `<div class="plan-project">
    <label class="panel-sub">Thư mục dự án (Muse ghi code vào đây, lệnh kiểm tra chạy ở đây)</label>
    <input class="feedback-input" data-plan-dir="${esc(plan.id)}" value="${esc(p.dir)}" placeholder="/đường/dẫn/tuyệt/đối" />
    <label class="panel-sub">Lệnh kiểm tra nền (mọi task đều chạy) — mỗi dòng một lệnh${p.commandsByCeo ? "" : ", Claude đề xuất"}. Lệnh riêng của từng task xem trong cây việc.</label>
    <textarea class="feedback-input" rows="3" data-plan-cmds="${esc(plan.id)}" placeholder="ví dụ: swift build&#10;swift test">${esc((p.verifyCommands ?? []).join("\n"))}</textarea>
    ${warnings}${missing}
    <label class="panel-sub">Khi nào task sau được bắt đầu</label>
    <select class="feedback-input" data-plan-handoff="${esc(plan.id)}">
      <option value="done"${p.handoffOn === "done" ? " selected" : ""}>Chỉ sau khi tôi duyệt task trước (an toàn — nên dùng khi sửa dự án có sẵn)</option>
      <option value="checkpoint_final"${p.handoffOn === "checkpoint_final" ? " selected" : ""}>Ngay khi task trước chờ duyệt (nhanh hơn)</option>
    </select>
    <label class="check"><input type="checkbox" data-plan-autoapprove="${esc(plan.id)}"${p.autoApprove ? " checked" : ""} /> Tự duyệt task khi mọi thứ xanh (qua kiểm tra, Gemini & Claude đều duyệt, không cảnh báo đỏ) — task có cảnh báo vẫn chờ bạn; dự án có git thì mỗi task là một commit, hoàn tác được</label>
    <label class="check"><input type="checkbox" data-plan-github="${esc(plan.id)}"${p.githubRepo ? " checked" : ""} /> Tạo repo GitHub riêng tư cho dự án và push mỗi task được duyệt${p.githubUrl ? ` — <a href="${esc(p.githubUrl)}" target="_blank" rel="noopener">${esc(p.githubUrl)}</a>` : ""}</label>
    <label class="check"><input type="checkbox" data-plan-skipreview="${esc(plan.id)}"${p.skipClaudeReviewWhenGreen ? " checked" : ""} /> Bỏ Claude review khi Gemini đã duyệt và không có cảnh báo đỏ (task nghiệm thu và yêu cầu sửa của bạn luôn qua Claude)</label>
    <div class="row-inline"><button class="btn btn-small-inline" data-action="plan-project-save" data-plan="${esc(plan.id)}">Lưu thư mục & lệnh</button></div>
  </div>`;
}

function planProjectInputs(planId) {
  const dir = document.querySelector(`[data-plan-dir="${CSS.escape(planId)}"]`);
  const cmds = document.querySelector(`[data-plan-cmds="${CSS.escape(planId)}"]`);
  const out = {};
  if (dir) out.projectDir = dir.value.trim();
  if (cmds) out.verifyCommands = cmds.value;
  const handoff = document.querySelector(`[data-plan-handoff="${CSS.escape(planId)}"]`);
  if (handoff) out.handoffOn = handoff.value;
  const auto = document.querySelector(`[data-plan-autoapprove="${CSS.escape(planId)}"]`);
  if (auto) out.autoApprove = auto.checked;
  const skip = document.querySelector(`[data-plan-skipreview="${CSS.escape(planId)}"]`);
  if (skip) out.skipClaudeReviewWhenGreen = skip.checked;
  const ghBox = document.querySelector(`[data-plan-github="${CSS.escape(planId)}"]`);
  if (ghBox) out.githubRepo = ghBox.checked;
  return out;
}

function details(id, summary, inner, cls = "") {
  return `<details class="${cls}" data-open-id="${esc(id)}"${state.open.has(id) ? " open" : ""}><summary>${summary}</summary>${inner}</details>`;
}
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
const slotName = (id) => state.slots.get(id)?.name.replace(/^AI /, "") ?? id;
const ownerChip = (id, lead = false) => `<span class="owner${lead ? " lead" : ""}" data-hover-slot="${esc(id)}">${esc(id)} ${esc(slotName(id))}</span>`;

// ---------- live text ----------
function liveText(id, stage, serverTail, serverTotal) {
  if (state.liveStage.get(id) !== stage) {
    state.live.set(id, serverTail || "");
    state.liveStage.set(id, stage);
    state.liveTotal.set(id, serverTotal || 0);
  }
  return state.live.get(id);
}
function appendLive(id, stage, start, text) {
  if (state.liveStage.get(id) !== stage) {
    state.live.set(id, "");
    state.liveStage.set(id, stage);
    state.liveTotal.set(id, start);
  }
  const known = state.liveTotal.get(id) ?? 0;
  const fresh = known > start ? text.slice(known - start) : text;
  if (!fresh) return state.live.get(id);
  const next = ((state.live.get(id) ?? "") + fresh).slice(-LIVE_CHARS);
  state.live.set(id, next);
  state.liveTotal.set(id, Math.max(known, start + text.length));
  return next;
}

// ---------- telemetry & control ----------
function renderTelemetry() {
  const t = state.telemetry;
  const el = $("#telemetry");
  if (!t) return;
  const end = t.runEndedAt ? new Date(t.runEndedAt).getTime() : null;
  const runClock = t.runStartedAt
    ? `<span class="tm"><b class="run-clock" data-start="${esc(t.runStartedAt)}" ${end ? `data-end="${end}"` : ""}>${fmtDur((end ?? Date.now()) - new Date(t.runStartedAt).getTime())}</b> thời gian chạy</span>`
    : `<span class="tm muted">Chưa chạy</span>`;
  const engineTip = Object.entries(t.byEngine)
    .map(([e, u]) => `${ENGINE_LABEL[e] ?? e}: ${fmtTok(u.input)} in / ${fmtTok(u.output)} out${u.costUsd ? ` · ${fmtCost(u.costUsd)}` : ""}`)
    .join("\n");
  const claudeUsage = t.byEngine.claude;
  const claudeTok = claudeUsage ? claudeUsage.input + claudeUsage.output : 0;
  const engines = state.engines
    ? Object.entries(state.engines)
        .map(([name, s]) => `<button class="engine eng-${name} ${s.running >= s.limit ? "busy" : ""}" data-action="engine-open" data-engine="${name}" title="${esc(ENGINE_LABEL[name])}: ${s.running}/${s.limit} đang chạy${s.waiting ? `, ${s.waiting} đang chờ lượt` : ""} — bấm để xem hàng đợi"><b>${ENGINE_LABEL[name] ?? name}</b> ${s.running}/${s.limit}${s.waiting ? ` · chờ ${s.waiting}` : ""}</button>`)
        .join("")
    : "";
  const c = t.counts;
  const kpi = (cls, n, label, extra = "") => `<div class="kpi ${cls}${n > 0 ? " hot" : ""}"${extra}><b>${n}</b><span>${label}</span></div>`;
  el.innerHTML = `
    <div class="tm-progress" title="% hoàn thành toàn công ty (theo bước của từng task)">
      <div class="ring${t.percent >= 100 ? " full" : ""}" style="--p:${t.percent}"><span class="tm-pct">${t.percent}<small>%</small></span></div>
      <div class="tm-progress-text"><b>${t.percent >= 100 ? "Hoàn tất" : c.running ? "Đang chạy" : t.paused ? "Tạm dừng" : "Tiến độ"}</b><span class="muted small">${c.done}/${c.total} task xong</span></div>
    </div>
    <div class="kpi-group">
      ${kpi("q-running", c.running, "Đang chạy")}
      ${kpi("q-queued", c.queued, "Hàng đợi")}
      <button class="kpi tm-link q-waiting_you${c.waitingYou > 0 ? " hot" : ""}" data-action="inbox-open" data-tab="waiting" title="Mở hộp duyệt"><b>${c.waitingYou}</b><span>Chờ bạn duyệt</span></button>
      ${kpi("q-error", c.errors, "Lỗi / chặn")}
      <div class="kpi q-done${c.total && c.done === c.total ? " hot" : ""}"><b>${c.done}<small>/${c.total}</small></b><span>Đã xong</span></div>
    </div>
    <div class="kpi-group">
      ${t.runStartedAt
        ? `<div class="kpi"><b class="run-clock" data-start="${esc(t.runStartedAt)}" ${end ? `data-end="${end}"` : ""}>${fmtDur((end ?? Date.now()) - new Date(t.runStartedAt).getTime())}</b><span>Thời gian chạy</span></div>`
        : `<div class="kpi"><b>—</b><span>Chưa chạy</span></div>`}
      <div class="kpi" title="${esc(engineTip)}"><b>${fmtTok(t.tokens.input + t.tokens.output)}${t.tokensEstimated ? "*" : ""}</b><span>Token</span></div>
      <div class="kpi eng-claude" title="Riêng Claude đã dùng trong phiên này${claudeUsage ? ` — ${fmtTok(claudeUsage.input)} in / ${fmtTok(claudeUsage.output)} out${claudeUsage.costUsd ? ` · ${fmtCost(claudeUsage.costUsd)}` : ""}` : ""}"><b>${fmtTok(claudeTok)}</b><span>Token Claude</span></div>
      <div class="kpi" title="Claude CLI tự báo chi phí (theo giá API — gói Pro/Max không tính thêm). Gemini/Claude API chỉ tính nếu đặt giá trong .env. Muse không có số liệu."><b>${fmtCost(t.costUsd)}</b><span>Chi phí${t.costPartial ? " (ước tính)" : ""}</span></div>
      ${t.paused ? `<span class="paused-pill">⏸ Đang tạm dừng</span>` : ""}
    </div>
    <div class="engines">${engines}</div>`;
  const pauseBtn = $("#pause-btn");
  pauseBtn.textContent = state.control.paused ? "▶ Resume" : "⏸ Pause";
  pauseBtn.classList.toggle("btn-resume", state.control.paused);
  renderDoneBanner();
  renderComposer();
  renderCeoNode();
}

function renderCompanyDirectives() {
  $("#company-directives").innerHTML = (state.control.directives || [])
    .map((d) => directiveChip(d, fmtTime(d.at)))
    .join("");
}

function renderApproveAll() {
  const n = [...state.slots.values()].reduce((sum, s) => sum + s.counts.waitingYou, 0);
  const btn = $("#approve-all-btn");
  btn.hidden = n < 2;
  btn.textContent = `✓ Duyệt tất cả (${n})`;
  btn.dataset.count = String(n);
}

// ---------- composer, completion banner, theme ----------
function planFinished() {
  const t = state.telemetry;
  return !!(state.plan?.status === "approved" && t && t.counts.total > 0 && t.counts.done === t.counts.total);
}

/** The new-project form is open when there is nothing running to look at; it folds away while a plan is in flight. */
function renderComposer() {
  const plan = state.plan;
  const sig = `${plan?.id ?? ""}|${plan?.status ?? ""}|${planFinished()}`;
  if (state.composer.sig !== sig) {
    state.composer.sig = sig;
    state.composer.manual = null;
  }
  const auto = !plan || plan.status === "failed" || plan.status === "discarded";
  const open = state.composer.manual ?? auto;
  $("#composer").classList.toggle("collapsed", !open);
  const btn = $("#composer-toggle");
  btn.setAttribute("aria-expanded", String(open));
  btn.textContent = open ? "✕ Đóng khung dự án mới" : "＋ Dự án mới";
  btn.classList.toggle("active", open);
  // first paint lands in the right state without animating; later toggles slide
  requestAnimationFrame(() => $("#composer").classList.remove("no-anim"));
}

function renderDoneBanner() {
  const el = $("#done-banner");
  const plan = state.plan;
  const t = state.telemetry;
  if (!planFinished() || localStorage.getItem("dash-banner-dismissed") === plan.id) {
    el.hidden = true;
    return;
  }
  const end = t.runEndedAt ? new Date(t.runEndedAt).getTime() : Date.now();
  const dur = t.runStartedAt ? fmtDur(end - new Date(t.runStartedAt).getTime()) : "—";
  const gh = plan.project?.githubUrl;
  el.hidden = false;
  el.innerHTML = `
    <div class="db-icon" aria-hidden="true">✓</div>
    <div class="db-main">
      <div class="db-title">Dự án hoàn tất</div>
      <div class="db-goal" title="${esc(plan.goal)}">${esc(plan.goal)}</div>
      <div class="db-stats">
        <span><b>${t.counts.done}/${t.counts.total}</b> task</span>
        <span><b>${dur}</b> thời gian chạy</span>
        <span><b>${fmtTok(t.tokens.input + t.tokens.output)}</b> token</span>
        <span><b>${fmtCost(t.costUsd)}</b> chi phí${t.costPartial ? " ước tính" : ""}</span>
      </div>
    </div>
    <div class="db-actions">
      <button class="btn btn-soft" data-action="view" data-view="artifacts">📦 Xem sản phẩm</button>
      <button class="btn btn-soft" data-action="view" data-view="timeline">📈 Timeline</button>
      ${gh ? `<a class="btn btn-soft" href="${esc(gh)}" target="_blank" rel="noopener">GitHub ↗</a>` : ""}
      <button class="btn btn-primary" data-action="composer-open">＋ Dự án mới</button>
      <button class="btn btn-ghost btn-square" data-action="banner-dismiss" data-plan="${esc(plan.id)}" title="Ẩn banner">✕</button>
    </div>`;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("dash-theme", theme);
  $("#theme-btn").textContent = theme === "light" ? "☾" : "☀";
  scheduleEdges();
}

// ---------- cards ----------
function initials(name) {
  const words = String(name ?? "").replace(/^AI /, "").split(/[\s&·/-]+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}
/** Initials on a tinted disc: hue from the slot number so each agent is recognisable, ring colour from its tier. */
function avatar(slot) {
  const n = Number(String(slot.id).replace(/\D/g, "")) || 0;
  const hue = (n * 47 + 190) % 360;
  return `<span class="avatar tier-${slot.tier ?? 3}" style="--h:${hue}" title="${esc(slot.icon ?? "")} ${esc(slot.name)}" aria-hidden="true">${esc(initials(slot.name))}<span class="avatar-dot"></span></span>`;
}
/** A directive chip whose text is clamped to a few lines; clicking the text expands it. */
function directiveChip(d, tip = "") {
  const key = `dir:${d.id}`;
  const open = state.open.has(key);
  return `<span class="directive${open ? " expanded" : ""}"${tip ? ` title="${esc(tip)}"` : ""}><span class="d-text" data-action="expand" data-key="${esc(key)}" title="${open ? "Thu gọn" : "Bấm để xem đầy đủ"}">📌 ${esc(d.text)}</span><button class="x" data-action="directive-remove" data-id="${esc(d.id)}" title="Gỡ chỉ thị">×</button></span>`;
}
const STATE_ICON = { running: "▶", needs_review: "✋", blocked: "⛔", waiting_input: "⏳", ready: "●", paused: "⏸", done: "✓", idle: "○" };

function cardSkeleton(slot) {
  return `
    <div class="card${slot.isBoss ? " card-boss" : ""}" data-slot="${slot.id}">
      <div class="card-header">
        ${avatar(slot)}
        <span class="card-name" title="${esc(slot.name)}"><span class="card-role">${esc(slot.name.replace(/^AI /, ""))}</span><span class="card-id">${slot.id}</span></span>
        <span class="card-tools" data-part="tools"></span>
      </div>
      ${slot.tier === 2 ? `<div class="team-summary" data-part="team"></div>` : ""}
      <div data-part="state"></div>
      <div class="cmp" data-part="compact"></div>
      <div data-part="links"></div>
      <div class="card-body" data-part="body"></div>
      <div data-part="actions"></div>
      <div class="queue" data-part="queue"></div>
      <div data-part="directives"></div>
      <div class="card-footer">
        <button class="btn btn-small" data-action="run" data-slot="${slot.id}">Chạy riêng khung này</button>
        <button class="btn btn-icon" data-action="steer-open" data-slot="${slot.id}" title="Gửi chỉ thị riêng cho ${slot.id}">✎ Chỉ thị</button>
      </div>
      ${slot.isBoss ? `<button class="btn btn-small rebalance-btn" data-action="rebalance" title="Claude (Sếp) xem tải của từng người và đề xuất gán lại / đổi thứ tự — bạn chọn áp dụng">⚖ Sếp đề xuất cân tải</button>` : ""}
    </div>`;
}

function selectedTask(slot) {
  const want = state.selected.get(slot.id);
  return slot.tasks.find((t) => t.id === want) ?? slot.tasks[0];
}

function activityLine(t) {
  if (t.activity) {
    const verb = t.activity.state === "waiting" ? "đang chờ lượt" : "đang xử lý";
    return `<div class="activity ${t.activity.state}">⏱ <span class="elapsed" data-since="${esc(t.activity.since)}">${elapsed(t.activity.since)}</span> · ${ENGINE_LABEL[t.activity.engine] ?? t.activity.engine} ${verb}</div>`;
  }
  if (t.queueState === "running" && t.stageStartedAt) {
    return `<div class="activity running">⏱ <span class="elapsed" data-since="${esc(t.stageStartedAt)}">${elapsed(t.stageStartedAt)}</span> · ${esc(t.stage)}</div>`;
  }
  return "";
}

function metricsLine(t) {
  const parts = [];
  if (t.lastRun) {
    const lr = t.lastRun;
    parts.push(`lượt cuối ${esc(lr.stage)}: ${fmtDur(lr.durationMs)}${lr.waitMs > 1000 ? ` (chờ ${fmtDur(lr.waitMs)})` : ""} · ${fmtTok(lr.tokens)} tok${lr.costUsd ? ` · ${fmtCost(lr.costUsd)}` : ""}`);
  }
  if (t.totals.runs) parts.push(`tổng ${t.totals.runs} lượt · ${fmtDur(t.totals.activeMs)} · ${fmtTok(t.totals.tokens)} tok${t.totals.costUsd ? ` · ${fmtCost(t.totals.costUsd)}` : ""}`);
  return parts.length ? `<div class="metrics">${parts.map((p) => `<div>${p}</div>`).join("")}</div>` : "";
}

function taskBody(slot, t) {
  if (!t) {
    if (slot.isBoss && state.plan) {
      return `<div class="current"><div class="current-label">Đang điều phối</div><div class="task-title">📋 ${esc(state.plan.goal)}</div><div class="muted small">${esc(PLAN_STATUS[state.plan.status] ?? state.plan.status)} · xem cây việc bên phải →</div></div>`;
    }
    return `<div class="task-title muted">Chưa có task. Gõ mục tiêu ở trên rồi bấm "Chạy riêng khung này".</div>`;
  }
  const live = liveText(t.id, t.stage, t.liveTail, t.liveTotal);
  const ac = t.acceptanceCriteria.length
    ? details(`ac:${t.id}`, `Tiêu chí nghiệm thu (${t.acceptanceCriteria.length})`, `<ul class="ac">${t.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`)
    : "";
  const logs = t.logs.length ? t.logs.slice(-3).map((l) => `<div class="log-line" title="${esc(l.text)}">${esc(l.at)}: ${esc(l.text)}</div>`).join("") : "";
  const history = `
    ${logs ? `<div class="logs">${logs}</div>` : ""}
    ${t.lastError ? `<div class="feedback-box is-error">⚠ ${esc(t.lastError)}</div>` : ""}
    ${alertsBlock(t)}
    ${!t.waitingForYou && t.lastFeedback ? `<div class="feedback-box reject-hint">💬 ${esc(truncate(t.lastFeedback, 220))}</div>${t.lastFeedback.length > 220 ? details(`fb:${t.id}`, "Xem toàn bộ phản hồi", `<div class="feedback-box">${esc(t.lastFeedback)}</div>`) : ""}` : ""}`;
  const remaining = slot.queueRemaining ? `<span class="muted"> · còn ${slot.queueRemaining} trong hàng đợi</span>` : "";
  return `
    <div class="current" data-action="open-drawer" data-task="${esc(t.id)}" title="Bấm để xem đầy đủ output, prompt, artifact và lịch sử">
      <div class="current-label">Task hiện tại${remaining}</div>
      <div class="task-title">${esc(t.title)}${planTag(t.planRef)}</div>
      <div class="badges">
        <span class="badge ${t.colorClass}">${esc(t.label)}</span>
        <span class="qstate q-${t.queueState}">${QUEUE_LABEL[t.queueState]}</span>
        ${t.handedOff ? `<span class="qstate q-done" title="Kết quả đã bàn giao cho task phụ thuộc">↪ đã bàn giao</span>` : ""}
        ${t.redoPending ? `<span class="qstate q-waiting_you" title="Sẽ quay lại architecture khi bước hiện tại xong">↻ chờ làm lại</span>` : ""}
        ${t.architectureRounds ? `<span class="qstate round-badge" title="Số vòng Claude ↔ Gemini bàn bạc architecture">🔄 vòng ${t.architectureRounds}</span>` : ""}
        ${t.reviewRejections ? `<span class="qstate round-badge" title="Số lần bị từ chối ở review">✗ từ chối ${t.reviewRejections}x</span>` : ""}
        <span class="stage-raw">${esc(t.stage)}</span>
      </div>
      <div class="progress-track"><div class="progress-fill ${t.colorClass}" style="width:${t.progress}%"></div></div>
    </div>
    ${activityLine(t)}
    ${metricsLine(t)}
    ${t.queueState === "running" ? `<pre class="live" data-live="${esc(t.id)}">${esc(live || "…")}</pre>` : ""}
    ${ac}
    ${t.queueState === "done" ? doneHistory(t, history) : history}`;
}

/** A finished task keeps its old warnings and logs, but folded away so the card reads as "done". */
function doneHistory(t, html) {
  const n = (t.logs.length ? 1 : 0) + (t.lastError ? 1 : 0) + (t.alerts?.length ?? 0) + (!t.waitingForYou && t.lastFeedback ? 1 : 0);
  if (!n) return "";
  const warn = (t.lastError ? 1 : 0) + (t.alerts ?? []).filter((a) => a.level === "warn").length;
  return details(`hist:${t.id}`, `Lịch sử & ghi chú${warn ? ` · <span class="hist-warn">${warn} cảnh báo cũ</span>` : ""}`, html, "history");
}

function taskActions(t) {
  if (!t) return "";
  if (t.waitingForYou) {
    const box = t.checkpointBrief || t.lastFeedback;
    const final = t.stage === "checkpoint_final";
    return `
      ${box ? `<div class="checkpoint-box">${esc(box)}</div>` : ""}
      ${final && t.gated ? `<div class="gate-note">🔒 Cổng duyệt: kết quả chỉ bàn giao cho bước sau khi bạn duyệt.</div>` : ""}
      ${final ? shipWarningNote(t) : ""}
      <input class="feedback-input" placeholder="${final ? "Yêu cầu sửa / lý do từ chối (tuỳ chọn)" : "Lý do từ chối (tuỳ chọn)"}" data-feedback-for="${esc(t.id)}" />
      <div class="decision-row">
        <button class="btn btn-approve" data-action="approve" data-task="${esc(t.id)}">Duyệt</button>
        ${final ? `<button class="btn btn-revise" data-action="revise" data-task="${esc(t.id)}" title="Giữ thiết kế, chỉ sửa theo yêu cầu">Yêu cầu sửa</button>` : ""}
        <button class="btn btn-reject" data-action="reject" data-task="${esc(t.id)}" title="${final ? "Làm lại từ ý tưởng (đổi hướng)" : "Viết lại ý tưởng"}">Từ chối</button>
      </div>`;
  }
  if (t.queueState === "error" || t.queueState === "rejected") {
    return `<button class="btn btn-small btn-retry" data-action="retry" data-task="${esc(t.id)}">↻ Thử lại task này</button>`;
  }
  return "";
}

const MOVABLE = new Set(["queued", "waiting_deps", "blocked", "error", "rejected", "waiting_you"]);
function queueList(slot, current) {
  if (slot.tasks.length <= 1) return "";
  return `<div class="queue-head">Hàng đợi (${slot.tasks.length}) <span class="muted">— kéo sang thẻ khác để gán lại</span></div>` +
    slot.tasks
      .map((t, i) => {
        const movable = MOVABLE.has(t.queueState);
        return `<div class="queue-row${current && t.id === current.id ? " selected" : ""}${movable ? " movable" : ""}" ${movable ? `draggable="true" data-drag-task="${esc(t.id)}"` : ""} data-action="select" data-slot="${slot.id}" data-task="${esc(t.id)}" title="${esc(t.title)}">
          <span class="qdot q-${t.queueState}"></span><span class="queue-title">${esc(t.title)}</span><span class="queue-stage">${esc(QUEUE_LABEL[t.queueState])}</span>
          ${movable && i > 0 ? `<button class="mini" data-action="prioritize" data-task="${esc(t.id)}" data-slot="${slot.id}" title="Đưa lên đầu hàng đợi">↑</button>` : ""}
        </div>`;
      })
      .join("");
}

function slotLinks(slot, t) {
  const bits = [];
  if (t?.assignedBy) bits.push(`<span class="link assign" title="Người giao việc">⇣ giao bởi ${esc(t.assignedBy.split(" ")[0])}</span>`);
  if (slot.inFrom.length) {
    const tip = slot.tasks.flatMap((x) => x.inputsFrom).map((i) => `${i.slotId}: ${i.title}${i.handedOff ? " ✓" : " (đang chờ)"}`).join("\n");
    bits.push(`<span class="link in" title="${esc(tip)}">← từ ${slot.inFrom.map((s) => `<b data-hover-slot="${s}">${s}</b>`).join(", ")}</span>`);
  }
  if (slot.outTo.length) {
    const tip = slot.tasks.flatMap((x) => x.outputsTo).map((o) => `${o.slotId}: ${o.title}`).join("\n");
    bits.push(`<span class="link out" title="${esc(tip)}">→ giao ${slot.outTo.map((s) => `<b data-hover-slot="${s}">${s}</b>`).join(", ")}</span>`);
  }
  return bits.length ? `<div class="links">${bits.join("")}</div>` : "";
}

/** Patches one card in place. The actions part is only rebuilt when it actually changes, so text typed into a feedback box survives updates. */
function updateCard(slot) {
  const card = $(`#org .card[data-slot="${slot.id}"]`);
  if (!card) return;
  const t = selectedTask(slot);
  const st = !t && slot.isBoss && state.plan ? bossState(state.plan) : slot.state;
  if (card.dataset.state && card.dataset.state !== st.kind) {
    card.classList.remove("state-changed");
    void card.offsetWidth; // restart the animation
    card.classList.add("state-changed");
  }
  card.dataset.state = st.kind;
  card.querySelector('[data-part="tools"]').innerHTML = `
    ${slot.isBoss ? `<span class="gate on" title="Kế hoạch của Sếp luôn chờ bạn duyệt">🔒</span>` : `<button class="gate ${slot.gated ? "on" : ""}" data-action="gate" data-slot="${slot.id}" data-enabled="${slot.gated ? "0" : "1"}" title="${slot.gated ? "Cổng duyệt đang BẬT: kết quả chỉ bàn giao sau khi bạn duyệt. Bấm để tắt." : "Cổng duyệt đang tắt: bàn giao ngay khi Claude đã duyệt. Bấm để bật."}">${slot.gated ? "🔒" : "🔓"}</button>`}
    <button class="pin playbook-btn" data-action="role-open" data-slot="${slot.id}" title="Playbook & bài học của ${slot.id}${state.lessons.pending[slot.id] ? ` — ${state.lessons.pending[slot.id]} bài học chờ duyệt` : ""}">📘${state.lessons.pending[slot.id] ? `<span class="lesson-dot">${state.lessons.pending[slot.id]}</span>` : ""}</button>
    <button class="pin ${state.focusSlot === slot.id ? "on" : ""}" data-action="focus" data-slot="${slot.id}" title="${state.focusSlot === slot.id ? "Bỏ tập trung" : `Tập trung vào ${slot.id}: làm mờ nhân sự không liên quan, hiện đường nối`}">🎯</button>
    <span class="parallel" title="Số task đang chạy / tối đa">${slot.counts.running}/${slot.parallel}</span>`;
  card.querySelector('[data-part="state"]').innerHTML = `
    <div class="state-row"><span class="state-pill s-${st.kind}">${STATE_ICON[st.kind] ?? ""} ${esc(st.label)}</span>${
      st.kind === "running" ? engineBadge(slot.tasks.find((x) => x.queueState === "running")) : st.detail ? `<span class="state-detail" title="${esc(st.detail)}">${esc(st.detail)}</span>` : ""
    }</div>`;
  card.querySelector('[data-part="compact"]').innerHTML = compactBody(slot, t);
  card.querySelector(".avatar")?.style.setProperty("--p", slotProgress(slot));
  if (slot.tier === 2) renderTeamSummary(slot);
  card.querySelector('[data-part="links"]').innerHTML = slotLinks(slot, t);
  card.querySelector('[data-part="body"]').innerHTML = taskBody(slot, t);
  const actions = card.querySelector('[data-part="actions"]');
  const sig = t ? `${t.id}|${t.queueState}|${t.stage}|${t.checkpointBrief ? 1 : 0}|${t.gated}` : "";
  if (actions.dataset.sig !== sig) {
    actions.dataset.sig = sig;
    actions.innerHTML = taskActions(t);
  }
  card.querySelector('[data-part="queue"]').innerHTML = queueList(slot, t);
  const chips = slot.directives.length ? `<div class="directive-chips">${slot.directives.map((d) => directiveChip(d)).join("")}</div>` : "";
  card.querySelector('[data-part="directives"]').innerHTML =
    chips && st.kind === "done" ? details(`dirs:${slot.id}`, `📌 Chỉ thị riêng (${slot.directives.length})`, chips, "history") : chips;
  const liveEl = card.querySelector("pre.live");
  if (liveEl) liveEl.scrollTop = liveEl.scrollHeight;
  applyFilter(card, slot);
}

/** The boss's own work is the plan: its card reflects where the plan is, not an empty task queue. */
function bossState(plan) {
  switch (plan.status) {
    case "drafting":
      return { kind: "running", label: "Running", detail: plan.phase || "đang lập kế hoạch" };
    case "awaiting_approval":
      return { kind: "needs_review", label: "Needs Review", detail: "chờ bạn duyệt kế hoạch" };
    case "failed":
      return { kind: "blocked", label: "Blocked", detail: "lập kế hoạch thất bại" };
    case "approved":
      return { kind: "done", label: "Điều phối", detail: "kế hoạch đã duyệt · đội đang làm" };
    default:
      return { kind: "idle", label: "Idle (Ready)" };
  }
}

function matchesFilter(slot) {
  switch (state.filter) {
    case "running":
      return slot.counts.running > 0;
    case "attention":
      return slot.counts.waitingYou > 0 || slot.counts.problems > 0 || slot.state.kind === "blocked";
    case "done":
      return slot.counts.done > 0 && slot.counts.running + slot.counts.queued + slot.counts.waitingYou + slot.counts.problems === 0;
    default:
      return true;
  }
}
function applyFilter(card, slot) {
  card.classList.toggle("filtered-out", !matchesFilter(slot));
}

/**
 * Groups staff under team leads. There is no fixed reporting line in the data, so each staff member joins
 * the lead they hand the most work to (counted over the lead's task inputs). Anyone with no direct hand-off
 * follows the colleagues they work with, and otherwise goes to the smallest team, so every team stays visible.
 */
function computeTeams() {
  const slots = [...state.slots.values()];
  // The server defines the teams: each lead manages the staff of its team.
  const defined = (state.teamsDef ?? []).filter((t) => t.leadId && state.slots.has(t.leadId));
  if (defined.length) {
    const teams = new Map(defined.map((t) => [t.leadId, slots.filter((s) => s.team === t.id && s.tier === 3).map((s) => s.id)]));
    const placed = new Set([...teams.values()].flat());
    return { teams, loose: slots.filter((s) => s.tier === 3 && !placed.has(s.id)).map((s) => s.id) };
  }
  // Older servers without teams: infer them from who hands work to whom.
  const leads = slots.filter((s) => s.tier === 2);
  const staff = slots.filter((s) => s.tier === 3);
  const teams = new Map(leads.map((l) => [l.id, []]));
  if (!leads.length) return { teams, loose: staff.map((s) => s.id) };
  const teamOf = new Map();
  const pick = (s, scores) => {
    let best = null;
    for (const l of leads) {
      const sc = scores.get(l.id) ?? 0;
      const b = best && (scores.get(best.id) ?? 0);
      if (!best || sc > b || (sc === b && teams.get(l.id).length < teams.get(best.id).length)) best = l;
    }
    teams.get(best.id).push(s.id);
    teamOf.set(s.id, best.id);
  };
  const direct = new Map(
    staff.map((s) => {
      const scores = new Map();
      for (const l of leads) {
        let n = l.inFrom.includes(s.id) ? 1 : 0;
        for (const t of l.tasks) n += t.inputsFrom.filter((i) => i.slotId === s.id).length;
        scores.set(l.id, n);
      }
      return [s.id, scores];
    }),
  );
  const strongest = (id) => Math.max(0, ...direct.get(id).values());
  const ordered = [...staff].sort((x, y) => strongest(y.id) - strongest(x.id) || x.id.localeCompare(y.id));
  const later = [];
  for (const s of ordered) (strongest(s.id) > 0 ? pick(s, direct.get(s.id)) : later.push(s));
  for (const s of later) {
    const scores = new Map();
    for (const other of [...s.outTo, ...s.inFrom]) {
      const lead = teamOf.get(other) ?? (teams.has(other) ? other : null);
      if (lead) scores.set(lead, (scores.get(lead) ?? 0) + 1);
    }
    pick(s, scores);
  }
  for (const [lead, members] of teams) members.sort((x, y) => (direct.get(y)?.get(lead) ?? 0) - (direct.get(x)?.get(lead) ?? 0) || x.localeCompare(y));
  return { teams, loose: [] };
}

/** You, above the boss: what is waiting for your decision right now. */
function renderCeoNode() {
  const el = $("#ceo-node");
  if (!el) return;
  const waiting = state.telemetry?.counts.waitingYou ?? 0;
  const planWaiting = state.plan?.status === "awaiting_approval" ? 1 : 0;
  const n = waiting + planWaiting;
  el.innerHTML = `<span class="ceo-avatar">CEO</span><div class="ceo-text"><b>Bạn — CEO</b><span>Duyệt kế hoạch, chốt kết quả, ra chỉ thị</span></div>${
    n ? `<button class="ceo-wait" data-action="inbox-open" data-tab="waiting">✋ ${n} chờ bạn</button>` : `<span class="ceo-idle">Không có gì chờ duyệt</span>`
  }`;
}

function renderOrg() {
  const slots = [...state.slots.values()];
  const { teams, loose } = computeTeams();
  state.teams = teams;
  const card = (id) => (state.slots.get(id) ? cardSkeleton(state.slots.get(id)) : "");
  $("#row-0").innerHTML = `<div class="ceo-node" id="ceo-node"></div>`;
  $("#row-1").innerHTML = `<div class="boss-row"><span></span>${slots.filter((s) => s.tier === 1).map(cardSkeleton).join("")}<div class="auditor" title="Gemini thẩm định độc lập: phản biện kế hoạch của Sếp, bản thiết kế của từng task và kết quả code trước khi Claude ký duyệt">
    <span class="auditor-icon">⚖</span><div><b>Gemini</b><span>Thẩm định độc lập</span></div></div></div>`;
  renderCeoNode();
  const row2 = $("#row-2");
  row2.style.setProperty("--teams", Math.max(1, teams.size));
  row2.innerHTML = [...teams]
    .map(([lead, members]) => `<div class="team" data-team="${esc(lead)}"><div class="team-name">${esc(state.slots.get(lead)?.teamName ?? "")}</div><div class="team-lead">${card(lead)}</div><div class="team-members">${members.map(card).join("")}</div></div>`)
    .join("");
  const extra = [...loose, ...slots.filter((s) => ![1, 2, 3].includes(s.tier)).map((s) => s.id)];
  $("#row-3").innerHTML = extra.length ? `<div class="loose-head">Chưa xếp nhóm</div><div class="loose-grid">${extra.map(card).join("")}</div>` : "";
  applyOrgDensity();
  for (const slot of slots) updateCard(slot);
  scheduleEdges();
}

function applyOrgDensity() {
  $("#org").classList.toggle("compact", state.orgDensity === "compact");
  $$('.seg[data-action="org-density"]').forEach((b) => b.classList.toggle("active", b.dataset.value === state.orgDensity));
}

function renderSideTabs() {
  $$(".side-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.sideTab));
  $("#plan-panel").hidden = state.sideTab !== "plan";
  $("#flow-panel").hidden = state.sideTab !== "flow";
}

/** Average progress of the slot's tasks (the boss shows the whole company's), drawn as the ring around the avatar. */
function slotProgress(slot) {
  if (slot.isBoss && !slot.tasks.length) return state.telemetry?.percent ?? 0;
  if (!slot.tasks.length) return 0;
  return Math.round(slot.tasks.reduce((sum, t) => sum + (t.progress ?? 0), 0) / slot.tasks.length);
}

/** The few lines a compact node shows: current task, its progress, and the slot's counters. */
function compactBody(slot, t) {
  if (!t) {
    if (slot.isBoss && state.plan) {
      return `<div class="cmp-task" title="${esc(state.plan.goal)}">📋 ${esc(state.plan.goal)}</div><div class="cmp-meta"><span>${esc(PLAN_STATUS[state.plan.status] ?? state.plan.status)}</span></div>`;
    }
    return `<div class="cmp-task muted">Đang rảnh — chưa có task.</div>`;
  }
  const c = slot.counts;
  const total = slot.tasks.length;
  const done = slot.tasks.filter((x) => x.queueState === "done").length;
  const act = t.activity
    ? `<span class="cmp-act ${t.activity.state}">⏱ <span class="elapsed" data-since="${esc(t.activity.since)}">${elapsed(t.activity.since)}</span> · ${esc(ENGINE_LABEL[t.activity.engine] ?? t.activity.engine)}</span>`
    : "";
  return `
    <div class="cmp-task" title="${esc(t.title)}">${esc(t.title)}</div>
    <div class="cmp-row"><div class="progress-track"><div class="progress-fill ${t.colorClass}" style="width:${t.progress}%"></div></div><span class="cmp-pct">${t.progress}%</span></div>
    <div class="cmp-meta">
      <span title="Task đã xong / tổng số task của người này">✓ ${done}/${total}</span>
      ${c.running ? `<span class="q-running" title="Đang chạy">▶ ${c.running}</span>` : ""}
      ${c.waitingYou ? `<span class="q-waiting_you" title="Chờ bạn duyệt">✋ ${c.waitingYou}</span>` : ""}
      ${c.problems ? `<span class="q-error" title="Lỗi / bị chặn">⚠ ${c.problems}</span>` : ""}
      ${act}
    </div>`;
}

/** "Nhóm 3 người · 1 đang chạy · 1 chờ duyệt" on a lead's card, summed over the lead and their team. */
function renderTeamSummary(lead) {
  const el = $(`#org .card[data-slot="${lead.id}"] [data-part="team"]`);
  if (!el) return;
  const people = [lead, ...(state.teams.get(lead.id) ?? []).map((id) => state.slots.get(id)).filter(Boolean)];
  const sum = (k) => people.reduce((n, p) => n + (p.counts[k] ?? 0), 0);
  const running = sum("running");
  const waiting = sum("waitingYou");
  const problems = sum("problems");
  const tasks = people.reduce((n, p) => n + p.tasks.length, 0);
  const done = people.reduce((n, p) => n + p.tasks.filter((t) => t.queueState === "done").length, 0);
  el.innerHTML = `<span class="ts-size">${esc(lead.teamName ?? "Nhóm")} · ${people.length} người</span><span>✓ ${done}/${tasks}</span>${running ? `<span class="q-running">▶ ${running} đang chạy</span>` : ""}${waiting ? `<span class="q-waiting_you">✋ ${waiting} chờ duyệt</span>` : ""}${problems ? `<span class="q-error">⚠ ${problems} lỗi</span>` : ""}`;
}

/** A staff update changes its lead's team summary too. */
function refreshTeamOf(slotId) {
  for (const [lead, members] of state.teams) if (members.includes(slotId)) renderTeamSummary(state.slots.get(lead));
}

// ---------- side panels ----------
function stageChip(plan, taskId) {
  const st = taskId && plan.taskStages?.[taskId];
  if (!st) return "";
  return `<span class="plan-stage q-${st.queueState}" title="${esc(st.stage)}">${esc(QUEUE_LABEL[st.queueState])}</span>`;
}

function renderPlanPanel() {
  const panel = $("#plan-panel");
  const plan = state.plan;
  if (!plan) {
    panel.innerHTML = `<div class="panel-title">Mục tiêu & cây phân việc</div><div class="muted small">Chưa có mục tiêu. Gõ mục tiêu ở thanh trên cùng rồi bấm <b>Chạy luồng cả công ty</b> — Sếp sẽ lập cây việc (Epic → Subtask + tiêu chí nghiệm thu) để bạn duyệt.</div>`;
    return;
  }
  const key = `plan:${plan.id}`;
  let body = "";
  if (plan.status === "drafting") {
    const live = liveText(key, plan.phase ?? "", plan.liveTail, plan.liveTotal);
    body += `<div class="activity running">${plan.activity ? `⏱ <span class="elapsed" data-since="${esc(plan.activity.since)}">${elapsed(plan.activity.since)}</span> · ` : ""}${esc(plan.phase ?? "Đang khởi động…")}</div>`;
    body += `<pre class="live" data-live="${esc(key)}">${esc(live || "…")}</pre>`;
  }
  if (plan.status === "failed") {
    body += `<div class="feedback-box is-error">⚠ ${esc(plan.error)}</div><button class="btn btn-small btn-retry" data-action="plan-retry" data-plan="${esc(plan.id)}">↻ Lập lại kế hoạch</button>`;
  }
  if (plan.notes?.length) body += details(`notes:${plan.id}`, `Hệ thống đã tự chỉnh ${plan.notes.length} điểm`, `<ul class="ac">${plan.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`);
  if (plan.unresolvedReview && plan.status === "awaiting_approval") {
    body += details(`unres:${plan.id}`, "⚠ Gemini vẫn còn ý kiến chưa giải quyết", `<div class="feedback-box">${esc(plan.unresolvedReview)}</div>`);
  }
  if (plan.epics?.length) {
    body += `<div class="tree">${plan.epics
      .map(
        (e) => `
        <div class="epic">
          <div class="epic-head"><b>${esc(e.id)}</b> ${esc(e.title)} ${ownerChip(e.owner, true)} ${stageChip(plan, e.taskId)}</div>
          ${details(`erat:${plan.id}:${e.id}`, "Lý do & tiêu chí", `${e.rationale ? `<div class="why">💡 ${esc(e.rationale)}</div>` : ""}<ul class="ac">${e.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`)}
          ${e.subtasks
            .map(
              (s) => `
            <div class="subtask"${s.taskId ? ` data-action="open-drawer" data-task="${esc(s.taskId)}"` : ""}>
              <div><b>${esc(s.id)}</b> ${esc(s.title)} ${ownerChip(s.owner)} ${stageChip(plan, s.taskId)}</div>
              ${s.dependsOn.length ? `<div class="deps">⏳ sau ${esc(s.dependsOn.join(", "))}</div>` : ""}
              ${details(`srat:${plan.id}:${s.id}`, "Vì sao giao cho người này?", `${s.rationale ? `<div class="why">💡 ${esc(s.rationale)}</div>` : `<div class="muted">Sếp không nêu lý do.</div>`}${s.inputs ? `<div class="why">📥 Dựa trên: ${esc(s.inputs)}</div>` : ""}<div class="epic-goal">${esc(s.description)}</div><ul class="ac">${s.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>${s.verifyCommands?.length ? `<div class="why">🧪 Lệnh kiểm tra riêng: ${s.verifyCommands.map((c) => `<code>${esc(c)}</code>`).join(" → ")}</div>` : ""}`)}
            </div>`,
            )
            .join("")}
        </div>`,
      )
      .join("")}</div>`;
  }
  const goalKey = `goal:${plan.id}`;
  const goalOpen = state.open.has(goalKey);
  const longGoal = (plan.goal?.length ?? 0) > 260 || (plan.summary?.length ?? 0) > 200;
  const sig = `${plan.id}|${plan.status}|${JSON.stringify(plan.project ?? null)}`;
  const prev = panel.querySelector('[data-part="plan-actions"]');
  const keep = prev && prev.dataset.sig === sig ? prev : null;
  panel.innerHTML = `
    <div class="panel-title">Mục tiêu & cây phân việc <span class="plan-status s-${plan.status}">${esc(PLAN_STATUS[plan.status] ?? plan.status)}</span></div>
    <div class="plan-goal${goalOpen ? "" : " clamp-3"}">${esc(plan.goal)}</div>
    ${plan.summary ? `<div class="plan-summary${goalOpen ? "" : " clamp-2"}">${esc(plan.summary)}</div>` : ""}
    ${longGoal ? `<button class="link-btn" data-action="expand" data-key="${esc(goalKey)}">${goalOpen ? "▲ Thu gọn" : "▼ Xem đầy đủ mục tiêu"}</button>` : ""}
    ${plan.reviewRounds ? `<div class="muted small">${plan.reviewRounds} vòng Claude ↔ Gemini${plan.usage ? ` · ${fmtTok(plan.usage.input + plan.usage.output)} tok${plan.usage.costUsd ? ` · ${fmtCost(plan.usage.costUsd)}` : ""}` : ""}</div>` : ""}
    ${body}
    <div data-part="plan-actions"></div>`;
  const actions = panel.querySelector('[data-part="plan-actions"]');
  if (keep) actions.replaceWith(keep);
  else {
    actions.dataset.sig = sig;
    actions.innerHTML =
      plan.status === "awaiting_approval"
        ? `${planProjectBlock(plan, true)}
           <input class="feedback-input" placeholder="Feedback nếu từ chối (Sếp sẽ lập lại theo ý này)" data-plan-feedback="${esc(plan.id)}" />
           <div class="decision-row"><button class="btn btn-approve" data-action="plan-approve" data-plan="${esc(plan.id)}">Duyệt kế hoạch — giao việc</button><button class="btn btn-reject" data-action="plan-reject" data-plan="${esc(plan.id)}">Từ chối & lập lại</button></div>`
        : "";
  }
  const liveEl = panel.querySelector("pre.live");
  if (liveEl) liveEl.scrollTop = liveEl.scrollHeight;
}

function ensureFlowPanel() {
  const panel = $("#flow-panel");
  if (!panel.querySelector("#flow-insights")) {
    panel.innerHTML = `
      <div class="panel-title">Luồng bàn giao & điểm nghẽn
        <button class="btn btn-small-inline rebalance-btn" data-action="rebalance" title="Claude (Sếp) xem tải của từng người và đề xuất gán lại / đổi thứ tự — bạn chọn áp dụng">⚖ Sếp đề xuất cân tải</button>
      </div>
      <div id="rebalance-box"></div>
      <div id="flow-insights"></div>`;
  }
}

/** Tasks currently in (or that went through) a Claude↔Gemini discuss/reject loop, for the flow panel below. */
function discussionTasks() {
  const out = [];
  for (const slot of state.slots.values()) {
    for (const t of slot.tasks) {
      if (t.queueState === "done") continue;
      if (!t.architectureRounds && !t.reviewRejections) continue;
      out.push({ slotId: slot.id, title: t.title, architectureRounds: t.architectureRounds, reviewRejections: t.reviewRejections, feedback: t.waitingForYou ? undefined : t.lastFeedback });
    }
  }
  return out;
}

function renderFlowPanel() {
  const ins = state.insights;
  ensureFlowPanel();
  const panel = $("#flow-insights");
  if (!ins) return;
  const alerts = ins.alerts.length
    ? ins.alerts.map((a) => `<li class="alert ${a.level}">${a.level === "error" ? "⛔" : a.level === "warn" ? "⚠" : "ℹ"} ${esc(a.text)}</li>`).join("")
    : `<li class="muted">Không có điểm nghẽn.</li>`;
  const discussions = discussionTasks();
  const discussionsHtml = discussions.length
    ? discussions
        .map(
          (d) =>
            `<li><b data-hover-slot="${d.slotId}">${d.slotId}</b> ${d.architectureRounds ? `🔄 vòng ${d.architectureRounds}` : ""}${d.reviewRejections ? ` ✗ từ chối ${d.reviewRejections}x` : ""}<div class="flow-title">${esc(d.title)}</div>${d.feedback ? `<div class="flow-reason">💬 ${esc(truncate(d.feedback, 160))}</div>` : ""}</li>`,
        )
        .join("")
    : `<li class="muted">Không có vòng bàn bạc/từ chối nào đang diễn ra.</li>`;
  const handoffs = ins.handoffs.length
    ? ins.handoffs
        .map((h) => `<li><span class="vtl-time">${esc(fmtTime(h.at))}</span><span class="flow-edge"><b data-hover-slot="${h.from}">${h.from}</b> → ${h.to.length ? h.to.map((s) => `<b data-hover-slot="${s}">${s}</b>`).join(", ") : "<i>(không ai phụ thuộc)</i>"}</span><div class="flow-title">${esc(h.title)}</div></li>`)
        .join("")
    : `<li class="muted">Chưa có bàn giao nào.</li>`;
  const waits = ins.waits.length
    ? ins.waits.map((w) => `<li><b data-hover-slot="${w.slotId}">${w.slotId}</b> chờ ${w.waitingOn.map((s) => `<b data-hover-slot="${s}">${s}</b>`).join(", ")} · ${fmtDur(w.sinceMs)}<div class="flow-title">${esc(w.title)}</div></li>`).join("")
    : `<li class="muted">Không ai đang chờ đầu vào.</li>`;
  const badge = $("#flow-tab-badge");
  const hot = ins.alerts.filter((a) => a.level !== "info").length + ins.waits.length;
  badge.hidden = !hot;
  badge.textContent = String(hot);
  panel.innerHTML = `
    <div class="panel-sub">Cảnh báo</div><ul class="flow-list">${alerts}</ul>
    <div class="panel-sub">Đang thảo luận / bị từ chối</div><ul class="flow-list">${discussionsHtml}</ul>
    <div class="panel-sub">Bàn giao gần đây</div><ul class="flow-list vtl">${handoffs}</ul>
    <div class="panel-sub">Đang chờ đầu vào</div><ul class="flow-list">${waits}</ul>`;
}

// ---------- boss rebalance proposal ----------
function renderRebalance() {
  ensureFlowPanel();
  const box = $("#rebalance-box");
  const p = state.rebalance;
  $$(".rebalance-btn").forEach((b) => (b.disabled = p?.status === "drafting"));
  if (!p) {
    box.innerHTML = "";
    box.dataset.sig = "";
    return;
  }
  // Rebuilt only when the proposal itself changes, so ticked boxes survive live updates.
  const sig = `${p.id}|${p.status}|${p.moves.length}|${p.notes.length}|${p.activity?.state ?? ""}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const notes = p.notes.length ? details(`rbn:${p.id}`, `Đã loại ${p.notes.length} đề xuất không hợp lệ / không áp dụng được`, `<ul class="ac">${p.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`) : "";
  const close = `<button class="btn btn-small-inline" data-action="rebalance-dismiss">Đóng</button>`;
  let inner = "";
  if (p.status === "drafting") {
    const live = liveText("rebalance", "", p.liveTail, p.liveTotal);
    inner = `<div class="activity running">${p.activity ? `⏱ <span class="elapsed" data-since="${esc(p.activity.since)}">${elapsed(p.activity.since)}</span> · Claude ${p.activity.state === "waiting" ? "đang chờ lượt" : "đang phân tích tải"}` : "Đang chuẩn bị…"}</div><pre class="live" data-live="rebalance">${esc(live || "…")}</pre>`;
  } else if (p.status === "failed") {
    inner = `<div class="feedback-box is-error">⚠ ${esc(p.error)}</div><div class="row-inline"><button class="btn btn-small-inline" data-action="rebalance">↻ Đề xuất lại</button>${close}</div>`;
  } else if (p.status === "applied") {
    inner = `<div class="rb-done">✓ Đã áp dụng ${p.applied}/${p.moves.length} đề xuất.</div>${notes}<div class="row-inline">${close}</div>`;
  } else if (!p.moves.length) {
    inner = `<div class="why">${esc(p.summary || "Sếp thấy phân bổ hiện tại ổn, không cần thay đổi.")}</div>${notes}<div class="row-inline">${close}</div>`;
  } else {
    inner = `
      ${p.summary ? `<div class="why">${esc(p.summary)}</div>` : ""}
      <div class="rb-moves">${p.moves
        .map(
          (m, i) => `<label class="rb-move">
            <input type="checkbox" data-rb-idx="${i}" checked />
            <span class="rb-main">
              <span class="rb-route">${m.kind === "priority" ? `↑ Ưu tiên lên đầu trong <b data-hover-slot="${m.to}">${m.to}</b>` : `<b data-hover-slot="${m.from}">${m.from}</b> → <b data-hover-slot="${m.to}">${m.to}</b>`}</span>
              <span class="rb-title">${esc(m.title)}</span>
              <span class="why">💡 ${esc(m.reason)}</span>
            </span>
          </label>`,
        )
        .join("")}</div>
      ${notes}
      <div class="decision-row"><button class="btn btn-approve" data-action="rebalance-apply" data-id="${esc(p.id)}">Áp dụng đề xuất đã chọn</button><button class="btn btn-ghost" data-action="rebalance-dismiss">Bỏ qua</button></div>`;
  }
  box.innerHTML = `<div class="rb"><div class="panel-sub">⚖ Đề xuất cân tải của Sếp</div>${inner}</div>`;
}

// ---------- focus, engine slots, review inbox ----------
/** The agent itself plus everyone it takes input from, hands output to, or was assigned by / assigns to. */
function relatedSlots(id) {
  const out = new Set([id]);
  const s = state.slots.get(id);
  if (!s) return out;
  s.inFrom.forEach((x) => out.add(x));
  s.outTo.forEach((x) => out.add(x));
  if (s.isBoss) {
    for (const o of state.slots.values()) if (o.tasks.some((t) => t.assignedBy?.startsWith("AG-01"))) out.add(o.id);
  } else if (s.tasks.some((t) => t.assignedBy?.startsWith("AG-01"))) {
    out.add("AG-01");
  }
  return out;
}

function setFocus(slotId) {
  state.focusSlot = slotId;
  state.tl.agents = slotId ? relatedSlots(slotId) : null;
  renderFocusChip();
  for (const slot of state.slots.values()) updateCard(slot);
  drawEdges();
  if (state.view === "flow") renderFlowView();
  if (state.view === "timeline") renderTimeline();
}

function renderFocusChip() {
  const chip = $("#focus-chip");
  const s = state.focusSlot && state.slots.get(state.focusSlot);
  chip.hidden = !s;
  if (s) chip.innerHTML = `🎯 Tập trung: <b>${s.id}</b> ${esc(s.name.replace(/^AI /, ""))} <span class="muted">(+${relatedSlots(s.id).size - 1} liên quan)</span> <button class="x" data-action="focus-clear" title="Bỏ tập trung (Esc)">×</button>`;
}

const ENGINE_HINT = { claude: "Claude", gemini: "Gemini", muse: "Muse", workspace: "Thư mục dự án" };
/** Which engine the running task is on right now — or which slot queue it is waiting in, and where. */
function engineBadge(t) {
  if (!t) return "";
  const q = t.engineQueue;
  if (!q) return `<span class="eng-badge eng-none" title="Bước này không gọi AI (ví dụ đang chạy build/test hoặc chuyển bước)">⚙ ${esc(t.stage)}</span>`;
  const name = ENGINE_HINT[q.engine] ?? q.engine;
  if (q.state === "running") {
    return `<button class="eng-badge eng-${q.engine}" data-action="engine-open" data-engine="${q.engine}" title="Đang dùng ${esc(name)} — bấm để xem hàng đợi của engine này">● ${esc(name)}</button>`;
  }
  return `<span class="eng-badge waiting eng-${q.engine}"><button class="eng-link" data-action="engine-open" data-engine="${q.engine}" title="Đang chờ tới lượt dùng ${esc(name)} — bấm để xem hàng đợi">⏳ Chờ slot ${esc(name)} #${q.position}/${q.of}</button>${
    q.position > 1 ? `<button class="mini" data-action="promote" data-engine="${q.engine}" data-id="${esc(t.id)}" title="Ưu tiên lượt này lên đầu hàng đợi ${esc(name)}">↑</button>` : ""
  }</span>`;
}

function renderEngineModal() {
  const name = state.engineModal;
  if (!name || !state.engines?.[name]) return;
  const e = state.engines[name];
  const row = (x, i, waiting) => `
    <div class="eq-row">
      <span class="eq-pos">${waiting ? `#${i + 1}` : "●"}</span>
      ${x.slotId ? ownerChip(x.slotId) : ""}
      <span class="eq-title" ${x.id.includes(":") || x.id === "rebalance" ? "" : `data-action="open-drawer" data-task="${esc(x.id)}"`}>${esc(x.label)}</span>
      ${x.since ? `<span class="muted small">${waiting ? "chờ" : "chạy"} <span class="elapsed" data-since="${esc(x.since)}">${elapsed(x.since)}</span></span>` : ""}
      ${waiting && i > 0 ? `<button class="btn btn-small-inline" data-action="promote" data-engine="${name}" data-id="${esc(x.id)}">↑ Ưu tiên</button>` : ""}
    </div>`;
  openModal(`
    <div class="modal-title">Hàng đợi ${esc(ENGINE_LABEL[name] ?? name)} · ${e.running}/${e.limit} đang chạy${e.waiting ? ` · ${e.waiting} đang chờ` : ""}</div>
    <div class="muted small">${name === "muse" ? (e.limit > 1 ? `Bể ${e.limit} tài khoản Muse — mỗi tài khoản 1 trình duyệt, chạy song song tối đa ${e.limit} lượt.` : "Muse chỉ có 1 trình duyệt nên luôn chạy từng lượt một.") : name === "workspace" ? "Bước ghi file + build/test của các task dùng chung thư mục dự án nên chạy lần lượt (không tính lúc đang chờ Muse trả lời)." : `Tối đa ${e.limit} lượt cùng lúc (đổi trong .env).`} Ưu tiên chỉ đổi thứ tự chờ, không đổi engine — mỗi bước vẫn do đúng vai trò của nó thực hiện.</div>
    <div class="panel-sub">Đang chạy</div>
    ${e.queue.running.map((x, i) => row(x, i, false)).join("") || `<div class="muted small">Không có.</div>`}
    <div class="panel-sub">Đang chờ (theo thứ tự được phục vụ)</div>
    ${e.queue.waiting.map((x, i) => row(x, i, true)).join("") || `<div class="muted small">Không ai đang chờ.</div>`}
    <div class="decision-row"><button class="btn btn-ghost" data-action="modal-close">Đóng</button></div>`);
}

function inboxData() {
  const waiting = [];
  const reviewing = [];
  const snoozed = [];
  const waitingIds = new Set();
  for (const slot of state.slots.values()) {
    for (const t of slot.tasks) {
      if (t.queueState === "waiting_you") {
        waitingIds.add(t.id);
        (state.snoozed.has(t.id) ? snoozed : waiting).push({ slot, t });
      }
      if ((t.stage === "architecture_review" || t.stage === "review_gemini") && (t.queueState === "running" || t.queueState === "queued")) reviewing.push({ slot, t });
    }
  }
  for (const id of [...state.snoozed]) if (!waitingIds.has(id)) state.snoozed.delete(id);
  waiting.sort((a, b) => (a.t.waitingSince ?? "").localeCompare(b.t.waitingSince ?? ""));
  const plan = state.plan;
  const planWaiting = plan?.status === "awaiting_approval";
  const planReviewing = plan?.status === "drafting" && /Gemini/.test(plan.phase ?? "");
  const rb = state.rebalance;
  const rbWaiting = rb?.status === "ready" && rb.moves.length > 0;
  return {
    waiting,
    reviewing,
    snoozed,
    planWaiting,
    planReviewing,
    rbWaiting,
    waitingCount: waiting.length + (planWaiting ? 1 : 0) + (rbWaiting ? 1 : 0),
    reviewingCount: reviewing.length + (planReviewing ? 1 : 0),
  };
}

function renderReviewBadges() {
  const d = inboxData();
  $("#review-badges").innerHTML = `
    <button class="rv-badge rv-reviewing${d.reviewingCount ? " has" : ""}" data-action="inbox-open" data-tab="reviewing" title="Các bước Gemini đang thẩm định (thiết kế, code, kế hoạch)">🔍 Đang thẩm định <b>${d.reviewingCount}</b></button>
    <button class="rv-badge rv-waiting${d.waitingCount ? " has" : ""}" data-action="inbox-open" data-tab="waiting" title="Các mục đang chờ bạn quyết định — bấm để duyệt nhanh">✋ Chờ bạn duyệt <b>${d.waitingCount}</b>${d.snoozed.length ? ` <span class="muted">(+${d.snoozed.length} để sau)</span>` : ""}</button>`;
}

function verdictChip(v, label) {
  const cls = v === "approve" || v === "passed" ? "ok" : v === "reject" || v === "failed" ? "bad" : "na";
  const mark = cls === "ok" ? "✓" : cls === "bad" ? "✗" : "—";
  return `<span class="rv-chip ${cls}">${label} ${mark}</span>`;
}

function inboxWaitingItem({ slot, t }, snoozed) {
  const final = t.stage === "checkpoint_final";
  const r = t.review;
  const body = final
    ? `<div class="rv-chips">${verdictChip(r.verification, "Build/test")}${verdictChip(r.gemini, r.geminiStandIn ? "Claude (thay Gemini)" : "Gemini")}${verdictChip(r.claude, "Claude chốt")}${t.acceptanceCriteria.length ? `<span class="rv-chip na">${t.acceptanceCriteria.length} tiêu chí</span>` : ""}${t.gated ? `<span class="rv-chip gate">🔒 cổng duyệt</span>` : ""}</div>${alertsBlock(t)}${t.lastFeedback ? details(`rvfb:${t.id}`, "Phản hồi gần nhất", `<div class="feedback-box">${esc(t.lastFeedback)}</div>`) : ""}`
    : `<div class="rv-brief">${esc((t.checkpointBrief || "").slice(0, 420))}${(t.checkpointBrief || "").length > 420 ? "…" : ""}</div>`;
  return `
    <div class="rv-item">
      <div class="rv-head">${ownerChip(slot.id)} <span class="qstate q-waiting_you">${final ? "Duyệt kết quả" : "Duyệt ý tưởng"}</span>${t.waitingSince ? `<span class="muted small">chờ <span class="elapsed" data-since="${esc(t.waitingSince)}">${elapsed(t.waitingSince)}</span></span>` : ""}</div>
      <div class="rv-title">${esc(t.title)}</div>
      ${body}
      ${snoozed
        ? `<div class="row-inline"><button class="btn btn-small-inline" data-action="unsnooze" data-task="${esc(t.id)}">Đưa lại vào danh sách</button><button class="btn btn-small-inline" data-action="open-drawer" data-task="${esc(t.id)}">Chi tiết</button></div>`
        : `<textarea rows="1" data-keep="rv:${esc(t.id)}" data-feedback-for="${esc(t.id)}" placeholder="${final ? "Yêu cầu sửa / lý do từ chối (tuỳ chọn)" : "Lý do từ chối (tuỳ chọn)"}"></textarea>
      <div class="decision-row">
        <button class="btn btn-approve" data-action="approve" data-task="${esc(t.id)}">Duyệt</button>
        ${final ? `<button class="btn btn-revise" data-action="revise" data-task="${esc(t.id)}">Yêu cầu sửa</button>` : ""}
        <button class="btn btn-reject" data-action="reject" data-task="${esc(t.id)}">Từ chối</button>
        <button class="btn btn-ghost" data-action="snooze" data-task="${esc(t.id)}" title="Để sau: ẩn khỏi danh sách, task vẫn chờ bạn">Bỏ qua</button>
        <button class="btn btn-ghost" data-action="open-drawer" data-task="${esc(t.id)}">Chi tiết</button>
      </div>`}
    </div>`;
}

function renderInbox() {
  const panel = $("#inbox");
  if (!state.inbox.open) {
    panel.hidden = true;
    $("#inbox-backdrop").hidden = true;
    return;
  }
  panel.hidden = false;
  $("#inbox-backdrop").hidden = false;
  const d = inboxData();
  const tab = state.inbox.tab;
  const sig = JSON.stringify([
    tab,
    d.waiting.map((x) => [x.t.id, x.t.stage]),
    d.snoozed.map((x) => x.t.id),
    d.reviewing.map((x) => [x.t.id, x.t.stage, x.t.queueState, x.t.activity?.state]),
    d.planWaiting,
    d.planReviewing,
    d.rbWaiting,
  ]);
  if (sig === state.inbox.sig) return;
  state.inbox.sig = sig;
  const keep = {};
  for (const el of $$("#inbox [data-keep]")) keep[el.dataset.keep] = el.value;
  const body = $("#inbox .drawer-body");
  const scroll = body?.scrollTop ?? 0;

  let html = "";
  if (tab === "waiting") {
    if (d.planWaiting) {
      html += `<div class="rv-item rv-plan"><div class="rv-head"><span class="owner lead">AG-01</span> <span class="qstate q-waiting_you">Duyệt kế hoạch</span></div><div class="rv-title">${esc(state.plan.goal)}</div>
        <div class="rv-brief">${esc(state.plan.summary ?? "")} · ${state.plan.epics?.length ?? 0} epic, ${(state.plan.epics ?? []).reduce((n, e) => n + e.subtasks.length, 0)} subtask${state.plan.unresolvedReview ? " · ⚠ Gemini còn ý kiến" : ""}</div>
        ${planProjectBlock(state.plan, false)}
        <textarea rows="1" data-keep="rv:plan" data-plan-feedback="${esc(state.plan.id)}" placeholder="Feedback nếu từ chối (Sếp sẽ lập lại theo ý này)"></textarea>
        <div class="decision-row"><button class="btn btn-approve" data-action="plan-approve" data-plan="${esc(state.plan.id)}">Duyệt kế hoạch</button><button class="btn btn-reject" data-action="plan-reject" data-plan="${esc(state.plan.id)}">Từ chối & lập lại</button><button class="btn btn-ghost" data-action="goto-panel" data-target="plan-panel">Xem cây việc</button></div></div>`;
    }
    if (d.rbWaiting) {
      html += `<div class="rv-item"><div class="rv-head"><span class="owner lead">AG-01</span> <span class="qstate q-waiting_you">Đề xuất cân tải</span></div><div class="rv-title">${state.rebalance.moves.length} thay đổi được đề xuất</div><div class="rv-brief">${esc(state.rebalance.summary)}</div><div class="decision-row"><button class="btn btn-small-inline" data-action="goto-panel" data-target="rebalance-box">Xem & chọn áp dụng</button></div></div>`;
    }
    html += d.waiting.map((x) => inboxWaitingItem(x, false)).join("");
    if (!html) html = `<div class="muted">Không có gì đang chờ bạn. 🎉</div>`;
  } else if (tab === "reviewing") {
    if (d.planReviewing) html += `<div class="rv-item"><div class="rv-head"><span class="owner lead">AG-01</span> <span class="qstate q-running">Gemini thẩm định kế hoạch</span></div><div class="rv-title">${esc(state.plan.goal)}</div><div class="muted small">${esc(state.plan.phase)}</div></div>`;
    html += d.reviewing
      .map(
        ({ slot, t }) => `<div class="rv-item" data-action="open-drawer" data-task="${esc(t.id)}">
        <div class="rv-head">${ownerChip(slot.id)} <span class="qstate q-${t.queueState}">${t.stage === "architecture_review" ? "Gemini thẩm định thiết kế" : "Gemini review code"}</span>${t.activity ? `<span class="muted small">${t.activity.state === "waiting" ? `chờ slot ${ENGINE_LABEL[t.activity.engine]}` : ENGINE_LABEL[t.activity.engine]} <span class="elapsed" data-since="${esc(t.activity.since)}">${elapsed(t.activity.since)}</span></span>` : t.queueState === "queued" ? `<span class="muted small">trong hàng đợi</span>` : ""}</div>
        <div class="rv-title">${esc(t.title)}</div>
      </div>`,
      )
      .join("");
    if (!html) html = `<div class="muted">Gemini không thẩm định gì lúc này.</div>`;
    html = `<div class="muted small rv-note">Gemini thẩm định trước, rồi Claude chốt, rồi mới tới bạn. Mục ở đây sẽ chuyển sang "Chờ bạn duyệt" khi xong.</div>` + html;
  } else {
    html = d.snoozed.map((x) => inboxWaitingItem(x, true)).join("") || `<div class="muted">Không có mục nào đang để sau.</div>`;
  }

  panel.innerHTML = `
    <div class="drawer-head"><div><div class="drawer-title">Hộp duyệt</div><div class="muted small">Gemini thẩm định → Claude chốt → bạn duyệt</div></div><button class="btn btn-icon" data-action="inbox-close" title="Đóng (Esc)">✕</button></div>
    <div class="drawer-tabs">
      <button class="tab${tab === "waiting" ? " active" : ""}" data-action="inbox-tab" data-tab="waiting">✋ Chờ bạn duyệt (${d.waitingCount})</button>
      <button class="tab${tab === "reviewing" ? " active" : ""}" data-action="inbox-tab" data-tab="reviewing">🔍 Đang thẩm định (${d.reviewingCount})</button>
      <button class="tab${tab === "snoozed" ? " active" : ""}" data-action="inbox-tab" data-tab="snoozed">Để sau (${d.snoozed.length})</button>
    </div>
    <div class="drawer-body">${html}</div>`;
  for (const [k, v] of Object.entries(keep)) {
    const el = $(`#inbox [data-keep="${CSS.escape(k)}"]`);
    if (el) el.value = v;
  }
  const nb = $("#inbox .drawer-body");
  if (nb) nb.scrollTop = scroll;
}

// ---------- edges (dependency / handoff arrows) ----------
function slotEdges() {
  const edges = [];
  for (const slot of state.slots.values()) {
    const seen = new Map();
    for (const t of slot.tasks) {
      const running = t.queueState === "running";
      for (const i of t.inputsFrom) {
        if (i.slotId === slot.id) continue;
        const prev = seen.get(i.slotId);
        // Lights up (regardless of the hover/toggle filters below) while a
        // task that actually took this input is running right now — a
        // visible trace of where the live flow is, not just the static map.
        const active = Boolean(prev?.active) || (running && i.handedOff);
        seen.set(i.slotId, { from: i.slotId, to: slot.id, kind: prev?.kind === "pending" || !i.handedOff ? "pending" : "done", active });
      }
    }
    edges.push(...seen.values());
    const assignedRunning = slot.tasks.some((t) => t.assignedBy?.startsWith("AG-01") && t.queueState === "running");
    if (slot.tasks.some((t) => t.assignedBy?.startsWith("AG-01")) && !slot.isBoss) edges.push({ from: "AG-01", to: slot.id, kind: "assign", active: assignedRunning });
  }
  return edges;
}

const scheduleEdges = debounce(drawEdges, 60);
function drawEdges() {
  const svg = $("#edges");
  const org = $("#org");
  if (!svg || state.view !== "org") return;
  const box = org.getBoundingClientRect();
  svg.setAttribute("width", box.width);
  svg.setAttribute("height", org.scrollHeight);
  svg.setAttribute("viewBox", `0 0 ${box.width} ${org.scrollHeight}`);
  $$("path.edge, text.edge-label, path.tree-line, circle.edge-dot", svg).forEach((p) => p.remove());
  $$(".card.related-in, .card.related-out, .card.related-self", org).forEach((c) => c.classList.remove("related-in", "related-out", "related-self"));
  const focus = state.hoverSlot ?? state.focusSlot;
  org.classList.toggle("focusing", Boolean(focus));
  $$(".card.pinned", org).forEach((c) => c.classList.remove("pinned"));
  if (state.focusSlot) $(`#org .card[data-slot="${state.focusSlot}"]`)?.classList.add("pinned");
  const all = slotEdges();
  const shown = all.filter((e) => e.active || (focus ? e.from === focus || e.to === focus : state.showAllEdges && e.kind !== "assign"));
  if (focus) {
    $(`#org .card[data-slot="${focus}"]`)?.classList.add("related-self");
    for (const e of shown) {
      if (e.to === focus) $(`#org .card[data-slot="${e.from}"]`)?.classList.add("related-in");
      if (e.from === focus) $(`#org .card[data-slot="${e.to}"]`)?.classList.add("related-out");
    }
  }
  const rect = (id) => {
    const el = $(`#org .card[data-slot="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
  };
  const NS = "http://www.w3.org/2000/svg";
  const addPath = (d, cls) => {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", cls);
    svg.appendChild(path);
    return path;
  };
  // reporting lines: boss → each lead (elbow), lead → members (a spine in the team's left gutter)
  const bossEl = $("#row-1 .card");
  const boss = bossEl ? rect(bossEl.dataset.slot) : null;
  const ceoEl = $("#ceo-node");
  if (ceoEl && boss) {
    const r = ceoEl.getBoundingClientRect();
    const cx = r.left - box.left + r.width / 2;
    addPath(`M${cx},${r.bottom - box.top} V${boss.y}`, "tree-line tree-ceo");
  }
  for (const team of $$("#row-2 .team")) {
    const lead = rect(team.dataset.team);
    if (!lead) continue;
    if (boss) {
      const x1 = boss.x + boss.w / 2;
      const y1 = boss.y + boss.h;
      const x2 = lead.x + lead.w / 2;
      const my = y1 + (lead.y - y1) / 2;
      const r = Math.min(10, Math.abs(x2 - x1) / 2, (lead.y - y1) / 4);
      const dir = Math.sign(x2 - x1);
      addPath(dir ? `M${x1},${y1} V${my - r} Q${x1},${my} ${x1 + dir * r},${my} H${x2 - dir * r} Q${x2},${my} ${x2},${my + r} V${lead.y}` : `M${x1},${y1} V${lead.y}`, "tree-line");
    }
    const members = $$(".team-members .card", team).map((c) => rect(c.dataset.slot)).filter(Boolean);
    if (!members.length) continue;
    const sx = lead.x + 12;
    const last = members.at(-1);
    let d = `M${sx},${lead.y + lead.h} V${last.y + 22 - 8} Q${sx},${last.y + 22} ${sx + 8},${last.y + 22} H${last.x}`;
    for (const m of members.slice(0, -1)) d += ` M${sx},${m.y + 22} H${m.x}`;
    addPath(d, "tree-line");
  }
  for (const e of shown) {
    const a = rect(e.from);
    const b = rect(e.to);
    if (!a || !b) continue;
    let x1, y1, x2, y2, d;
    if (Math.abs(a.y - b.y) < 20) {
      // same row: arc over the top
      x1 = a.x + a.w / 2;
      x2 = b.x + b.w / 2;
      y1 = y2 = a.y + 6;
      const lift = Math.min(60, 20 + Math.abs(x2 - x1) / 8);
      d = `M${x1},${y1} C${x1},${y1 - lift} ${x2},${y2 - lift} ${x2},${y2}`;
    } else {
      const down = b.y > a.y;
      x1 = a.x + a.w / 2;
      y1 = down ? a.y + a.h : a.y;
      x2 = b.x + b.w / 2;
      y2 = down ? b.y : b.y + b.h;
      const my = (y1 + y2) / 2;
      d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    }
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `edge e-${e.kind}${e.active ? " edge-active" : ""}`);
    path.setAttribute("marker-end", `url(#arrow-${e.kind})`);
    svg.appendChild(path);
    if (e.active) {
      // work travelling along a live hand-off
      for (const begin of ["0s", "0.8s"]) {
        const dot = document.createElementNS(NS, "circle");
        dot.setAttribute("r", "3.5");
        dot.setAttribute("class", "edge-dot");
        const move = document.createElementNS(NS, "animateMotion");
        move.setAttribute("dur", "1.6s");
        move.setAttribute("begin", begin);
        move.setAttribute("repeatCount", "indefinite");
        move.setAttribute("path", d);
        dot.appendChild(move);
        svg.appendChild(dot);
      }
    }
  }
}

// ---------- workflow view ----------
function renderFlowView() {
  const el = $("#view-flow");
  const cols = Object.fromEntries(PHASES.map((p) => [p, []]));
  const plan = state.plan;
  if (plan && (plan.status === "drafting" || plan.status === "awaiting_approval" || plan.status === "failed")) {
    cols["Mục tiêu"].push(`<div class="flow-card ph-goal"><div class="fc-top"><span class="owner lead">AG-01</span> <span class="qstate ${plan.status === "awaiting_approval" ? "q-waiting_you" : plan.status === "failed" ? "q-error" : "q-running"}">${esc(PLAN_STATUS[plan.status])}</span></div><div class="fc-title">${esc(plan.goal)}</div></div>`);
  }
  const waitingIn = Object.fromEntries(PHASES.map((p) => [p, 0]));
  const related = state.focusSlot ? relatedSlots(state.focusSlot) : null;
  for (const slot of state.slots.values()) {
    if (!matchesFilter(slot)) continue;
    for (const t of slot.tasks) {
      const phase = STAGE_PHASE[t.stage] ?? "Phân tích";
      const waiting = t.queueState === "queued" || t.queueState === "waiting_deps" || t.activity?.state === "waiting";
      if (waiting) waitingIn[phase]++;
      cols[phase].push(`
        <div class="flow-card ${PHASE_CLASS[phase] ?? ""}${t.queueState === "running" ? " is-running" : ""}${related && !related.has(slot.id) ? " dim" : ""}" data-action="open-drawer" data-task="${esc(t.id)}">
          <div class="fc-top"><span class="owner" data-hover-slot="${slot.id}">${slot.id}</span> <span class="qstate q-${t.queueState}">${QUEUE_LABEL[t.queueState]}</span>${t.activity ? ` <span class="muted small">${ENGINE_LABEL[t.activity.engine]} ${t.activity.state === "waiting" ? "chờ" : ""}</span>` : ""}${t.architectureRounds ? ` <span class="qstate round-badge" title="Số vòng Claude ↔ Gemini bàn bạc architecture">🔄 ${t.architectureRounds}</span>` : ""}${t.reviewRejections ? ` <span class="qstate round-badge" title="Số lần bị từ chối ở review">✗ ${t.reviewRejections}x</span>` : ""}</div>
          <div class="fc-title">${esc(t.title)}</div>
          <div class="fc-meta"><span class="stage-raw">${esc(t.stage)}</span>${t.queueState === "running" && t.stageStartedAt ? ` · ⏱ <span class="elapsed" data-since="${esc(t.stageStartedAt)}">${elapsed(t.stageStartedAt)}</span>` : ""}${t.deps.total ? ` · phụ thuộc ${t.deps.ready}/${t.deps.total}` : ""}</div>
          ${!t.waitingForYou && t.lastFeedback ? `<div class="fc-reject" title="${esc(t.lastFeedback)}">💬 ${esc(truncate(t.lastFeedback, 100))}</div>` : ""}
        </div>`);
    }
  }
  const worst = Object.entries(waitingIn).sort((a, b) => b[1] - a[1])[0];
  el.innerHTML = `
    <div class="view-intro">Mỗi task đi từ trái sang phải. Cột có nhiều task <b>đang chờ</b> (chờ lượt engine, chờ đầu vào, chờ trong hàng đợi) là điểm nghẽn.</div>
    <div class="flow-board">${PHASES.map((p, i) => {
      const bottleneck = worst && worst[0] === p && worst[1] >= 2;
      return `<div class="flow-col${bottleneck ? " bottleneck" : ""}">
        <div class="flow-col-head"><span>${i + 1}. ${p}</span><span class="count">${cols[p].length}</span></div>
        ${bottleneck ? `<div class="bottleneck-tag">⚠ Điểm nghẽn: ${waitingIn[p]} task đang chờ</div>` : waitingIn[p] ? `<div class="muted small">${waitingIn[p]} đang chờ</div>` : ""}
        <div class="flow-items">${cols[p].join("") || `<div class="muted small empty">—</div>`}</div>
      </div>`;
    }).join(`<div class="flow-arrow">→</div>`)}</div>`;
}

// ---------- timeline (Gantt) ----------
async function loadTimeline() {
  try {
    state.timeline = await fetch("/api/timeline").then((r) => r.json());
    renderTimeline();
  } catch {
    /* next update retries */
  }
}
const refreshTimeline = debounce(() => state.view === "timeline" && loadTimeline(), 1500);

const TL_STATUS = { running: "Chạy", review: "Chờ duyệt", error: "Lỗi", stopped: "Dừng", done: "Xong" };
const FILTER_STATUSES = { all: ["running", "review", "error", "stopped", "done"], running: ["running"], attention: ["review", "error", "stopped"], done: ["done"] };
const TIER_NAME = { 1: "Sếp", 2: "Trưởng nhóm", 3: "Nhân viên" };

function tlToolbar() {
  const o = state.tl;
  const seg = (action, value, label, active) => `<button class="seg${active ? " active" : ""}" data-action="${action}" data-value="${value}">${label}</button>`;
  const agents = [...state.slots.values()]
    .map((x) => `<button class="chip-agent${!o.agents || o.agents.has(x.id) ? " on" : ""}" data-action="tl-agent" data-slot="${x.id}" title="${esc(x.name)}">${x.id}</button>`)
    .join("");
  return `
    <div class="tl-toolbar">
      <div class="seg-group"><span class="bar-label">Nhóm</span>${seg("tl-group", "agent", "Theo nhân sự", o.group === "agent")}${seg("tl-group", "tier", "Theo vai trò", o.group === "tier")}</div>
      <div class="seg-group"><span class="bar-label">Màu</span>${seg("tl-color", "status", "Trạng thái", o.color === "status")}${seg("tl-color", "phase", "Khâu", o.color === "phase")}</div>
      <div class="seg-group"><span class="bar-label">Khoảng</span>${seg("tl-range", "all", "Tất cả", o.range === "all")}${seg("tl-range", "15", "15 phút", o.range === 15)}${seg("tl-range", "60", "1 giờ", o.range === 60)}</div>
      <div class="seg-group"><span class="bar-label">Trạng thái</span>${Object.entries(TL_STATUS)
        .map(([k, label]) => `<button class="chip-status st-${k}${o.statuses.has(k) ? " on" : ""}" data-action="tl-status" data-value="${k}">${label}</button>`)
        .join("")}</div>
      <div class="seg-group agents"><span class="bar-label">Nhân sự</span><button class="chip-agent${!o.agents ? " on" : ""}" data-action="tl-agents-all">Tất cả</button>${agents}</div>
    </div>`;
}

function renderTimeline() {
  const el = $("#view-timeline");
  const tl = state.timeline;
  const o = state.tl;
  if (!tl || !tl.start) {
    el.innerHTML = tlToolbar() + `<div class="view-intro">Chưa có lượt chạy nào để vẽ timeline.</div>`;
    return;
  }
  const now = Date.now();
  const tStart = new Date(tl.start).getTime();
  const t0 = o.range === "all" ? tStart : Math.max(tStart, now - o.range * 60000);
  const t1 = Math.max(now, new Date(tl.now).getTime(), t0 + 15000);
  const span = t1 - t0;
  const pct = (ms) => ((ms - t0) / span) * 100;
  const endOf = (sp) => (sp.endedAt ? new Date(sp.endedAt).getTime() : now);
  const related = state.focusSlot ? relatedSlots(state.focusSlot) : null;
  const ticks = [];
  const step = niceStep(span / 8);
  for (let x = Math.ceil(t0 / step) * step; x <= t1; x += step) ticks.push(x);

  state.tlSpans = [];
  const counts = Object.fromEntries(Object.keys(TL_STATUS).map((k) => [k, 0]));
  const bar = (sp, slotId) => {
    if (!o.statuses.has(sp.status) || endOf(sp) < t0) return "";
    counts[sp.status]++;
    const left = Math.max(0, pct(new Date(sp.startedAt).getTime()));
    const width = Math.max(0.4, pct(endOf(sp)) - left);
    const dur = endOf(sp) - new Date(sp.startedAt).getTime();
    const waitPct = dur > 0 && !sp.human ? Math.min(100, (sp.waitMs / dur) * 100) : 0;
    const colorCls = o.color === "status" ? `st-${sp.status}` : sp.human ? "ph-review" : PHASE_CLASS[STAGE_PHASE[sp.stage] ?? "Phân tích"];
    const idx = state.tlSpans.push({ ...sp, slotId, dur }) - 1;
    const cls = [colorCls, sp.critical ? "critical" : "", !sp.endedAt ? "live-bar" : "", sp.human ? "human" : ""].join(" ");
    return `<div class="bar ${cls}" style="left:${left}%;width:${width}%" data-action="open-drawer" data-task="${esc(sp.taskId)}" data-span="${idx}">${waitPct > 3 ? `<span class="wait" style="width:${waitPct}%"></span>` : ""}</div>`;
  };
  const agentRow = (r) => {
    const last = r.spans.filter((x) => !x.human).at(-1);
    const idleMs = last ? (last.endedAt ? now - new Date(last.endedAt).getTime() : 0) : 0;
    return `<div class="g-row${related && !related.has(r.slotId) ? " dim" : ""}"><div class="g-label" data-hover-slot="${r.slotId}"><b>${r.slotId}</b> ${esc(r.name.replace(/^AI /, ""))}${idleMs > 5 * 60000 ? `<span class="idle" title="Không chạy gì từ ${fmtDur(idleMs)}">💤 ${fmtDur(idleMs)}</span>` : ""}</div><div class="g-track">${r.spans.map((sp) => bar(sp, r.slotId)).join("")}</div></div>`;
  };
  const visible = tl.rows.filter((r) => !o.agents || o.agents.has(r.slotId));
  let rowsHtml;
  if (o.group === "tier") {
    rowsHtml = [1, 2, 3]
      .map((tier) => {
        const lane = visible.filter((r) => r.tier === tier);
        if (!lane.length) return "";
        const collapsed = o.collapsed.has(tier);
        const runs = lane.reduce((n, r) => n + r.spans.length, 0);
        const head = `<div class="g-row g-lane" data-action="tl-lane" data-tier="${tier}"><div class="g-label">${collapsed ? "▸" : "▾"} <b>${TIER_NAME[tier]}</b> <span class="muted small">${lane.length} người · ${runs} lượt</span></div><div class="g-track">${
          collapsed ? lane.flatMap((r) => r.spans.map((sp) => bar(sp, r.slotId))).join("") : ""
        }</div></div>`;
        return head + (collapsed ? "" : lane.map(agentRow).join(""));
      })
      .join("");
  } else {
    rowsHtml = visible.map(agentRow).join("");
  }
  const cp = tl.criticalPath;
  const legend =
    o.color === "status"
      ? Object.entries(TL_STATUS).map(([k, label]) => `<span><i class="sw st-${k}"></i>${label}</span>`).join("")
      : Object.entries(PHASE_CLASS).map(([p, c]) => `<span><i class="sw ${c}"></i>${p}</span>`).join("");
  el.innerHTML = `
    ${tlToolbar()}
    <div class="view-intro">
      Mỗi hàng là một nhân sự, mỗi thanh là một lượt chạy hoặc một khoảng <b>chờ bạn duyệt</b>; phần sọc là thời gian <b>chờ engine</b>. Rê chuột để xem chi tiết, bấm để mở task.
      ${cp ? `<div class="critical">★ Critical path (${fmtDur(cp.totalMs)}): ${cp.tasks.map((t) => `<span class="owner" data-hover-slot="${esc(t.slotId)}">${esc(t.slotId)}</span> ${esc(t.title)}`).join(" → ")}</div>` : ""}
    </div>
    <div class="legend">${legend}<span><i class="sw critical-sw"></i>Critical path</span><span><i class="sw wait-sw"></i>Chờ engine</span><span class="muted">Đang hiện: ${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${TL_STATUS[k].toLowerCase()}`).join(" · ") || "không có lượt nào khớp bộ lọc"}</span></div>
    <div class="gantt">
      <div class="g-row g-axis"><div class="g-label"></div><div class="g-track">${ticks.map((x) => `<span class="tick" style="left:${pct(x)}%">${new Date(x).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: span < 10 * 60000 ? "2-digit" : undefined })}</span>`).join("")}<span class="now-line" style="left:${pct(now)}%"></span></div></div>
      ${rowsHtml || `<div class="muted small" style="padding:10px">Không có nhân sự nào khớp bộ lọc.</div>`}
    </div>`;
}

function showTip(e) {
  const bar = e.target.closest(".gantt .bar[data-span]");
  const tip = $("#g-tip");
  if (!bar) {
    tip.hidden = true;
    return;
  }
  const sp = state.tlSpans[Number(bar.dataset.span)];
  if (!sp) return;
  const t = (iso) => new Date(iso).toLocaleTimeString("vi-VN");
  const decision = { approve: "đã duyệt", reject: "đã từ chối", revise: "yêu cầu sửa" }[sp.decision] ?? "";
  tip.innerHTML = `
    <div class="tip-title">${esc(sp.title)}</div>
    <div><b>${esc(sp.slotId)}</b> · <span class="stage-raw">${esc(sp.stage)}</span> · <span class="tip-st st-text-${sp.status}">${TL_STATUS[sp.status]}${decision ? ` (${decision})` : ""}</span></div>
    <div>${t(sp.startedAt)} → ${sp.endedAt ? t(sp.endedAt) : "đang diễn ra"} · <b>${fmtDur(sp.dur)}</b></div>
    ${sp.human ? `<div class="muted">Thời gian chờ bạn quyết định</div>` : `<div>${sp.waitMs > 1000 ? `chờ engine ${fmtDur(sp.waitMs)} · ` : ""}${fmtTok(sp.tokens)} token${sp.costUsd ? ` · ${fmtCost(sp.costUsd)}` : ""}${sp.engines?.length ? ` · ${sp.engines.map((x) => ENGINE_LABEL[x] ?? x).join(", ")}` : ""}</div>`}
    ${sp.critical ? `<div class="critical">★ nằm trên critical path</div>` : ""}
    <div class="muted small">Bấm để mở chi tiết task</div>`;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 16 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${y}px`;
}
document.addEventListener("mousemove", (e) => state.view === "timeline" && showTip(e));

function niceStep(ms) {
  const steps = [5e3, 1e4, 3e4, 6e4, 2 * 6e4, 5 * 6e4, 10 * 6e4, 15 * 6e4, 30 * 6e4, 36e5, 2 * 36e5, 6 * 36e5];
  return steps.find((s) => s >= ms) ?? 12 * 36e5;
}

// ---------- artifacts hub ----------
async function loadArtifacts() {
  try {
    state.artifacts.list = await fetch("/api/artifacts").then((r) => r.json());
    renderArtifacts();
  } catch {
    /* ignore */
  }
}
const refreshArtifacts = debounce(() => state.view === "artifacts" && loadArtifacts(), 2000);
const KIND_ICON = { brief: "💡", spec: "📐", file: "📄", verification: "🧪" };

function renderArtifacts() {
  const el = $("#view-artifacts");
  const a = state.artifacts;
  const list = a.list.filter((x) => (!a.agent || x.slotId === a.agent) && (!a.q || `${x.title} ${x.taskTitle}`.toLowerCase().includes(a.q.toLowerCase())));
  const groups = new Map();
  for (const x of list) {
    const k = `${x.slotId ?? "?"}|${x.taskId}`;
    if (!groups.has(k)) groups.set(k, { slotId: x.slotId, taskId: x.taskId, title: x.taskTitle, items: [] });
    groups.get(k).items.push(x);
  }
  const agents = [...state.slots.values()].map((s) => `<option value="${s.id}"${a.agent === s.id ? " selected" : ""}>${s.id} ${esc(s.name.replace(/^AI /, ""))}</option>`).join("");
  const prevSearch = $("#art-search");
  const hadFocus = prevSearch && document.activeElement === prevSearch;
  el.innerHTML = `
    <div class="art-layout">
      <div class="art-list">
        <div class="art-filters">
          <select id="art-agent"><option value="">Tất cả nhân sự</option>${agents}</select>
          <input id="art-search" placeholder="Tìm file, tài liệu…" value="${esc(a.q)}" />
        </div>
        <div class="muted small">${list.length} sản phẩm từ ${groups.size} task</div>
        ${[...groups.values()]
          .map(
            (g) => `<div class="art-group"><div class="art-group-head"><span class="owner" data-hover-slot="${esc(g.slotId)}">${esc(g.slotId)}</span> ${esc(g.title)}</div>
          ${g.items.map((x) => `<button class="art-item${a.selected?.id === x.id ? " selected" : ""}" data-action="artifact-preview" data-id="${esc(x.id)}">${KIND_ICON[x.kind]} ${esc(x.title)} <span class="muted small">${fmtTok(x.size)} ký tự</span></button>`).join("")}</div>`,
          )
          .join("") || `<div class="muted">Chưa có sản phẩm nào.</div>`}
      </div>
      <div class="art-preview" id="art-preview">${artifactPreview()}</div>
    </div>`;
  if (hadFocus) {
    const s = $("#art-search");
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  }
}

function artifactPreview() {
  const sel = state.artifacts.selected;
  if (!sel) return `<div class="muted">Chọn một sản phẩm bên trái để xem trước, tải về, hoặc gửi cho nhân sự khác làm đầu vào.</div>`;
  const q = `taskId=${encodeURIComponent(sel.taskId)}&kind=${sel.kind}${sel.path ? `&path=${encodeURIComponent(sel.path)}` : ""}`;
  return `
    <div class="art-head"><b>${KIND_ICON[sel.kind]} ${esc(sel.title)}</b> <span class="muted small">từ ${esc(sel.slotId)} · ${esc(sel.taskTitle)}</span>
      <span class="art-actions">
        <a class="btn btn-small-inline" href="/api/artifacts/content?${q}&download=1">⬇ Tải về</a>
        <button class="btn btn-small-inline" data-action="artifact-send-open" data-task="${esc(sel.taskId)}" data-kind="${sel.kind}" data-path="${esc(sel.path ?? "")}" data-title="${esc(sel.title)}">↪ Gửi cho nhân sự…</button>
        <button class="btn btn-small-inline" data-action="open-drawer" data-task="${esc(sel.taskId)}">Mở task</button>
      </span>
    </div>
    <pre class="art-content">${esc(sel.content ?? "Đang tải…")}</pre>`;
}

async function previewArtifact(id) {
  const item = state.artifacts.list.find((x) => x.id === id) ?? state.drawer.detail?.artifacts.find((x) => x.id === id);
  if (!item) return;
  state.artifacts.selected = { ...item };
  if (state.view === "artifacts") renderArtifacts();
  const q = `taskId=${encodeURIComponent(item.taskId)}&kind=${item.kind}${item.path ? `&path=${encodeURIComponent(item.path)}` : ""}`;
  const data = await fetch(`/api/artifacts/content?${q}`).then((r) => r.json());
  state.artifacts.selected.content = data.content ?? data.error;
  if (state.view === "artifacts") $("#art-preview").innerHTML = artifactPreview();
  const dprev = $("#drawer-art-preview");
  if (dprev) dprev.innerHTML = artifactPreview();
}

// ---------- drawer ----------
async function openDrawer(taskId, tab) {
  state.drawer.taskId = taskId;
  if (tab) state.drawer.tab = tab;
  $("#drawer").hidden = false;
  $("#drawer-backdrop").hidden = false;
  $("#drawer").innerHTML = `<div class="drawer-loading muted">Đang tải…</div>`;
  await loadDrawer();
}
function closeDrawer() {
  state.drawer.taskId = null;
  state.drawer.detail = null;
  $("#drawer").hidden = true;
  $("#drawer-backdrop").hidden = true;
}
async function loadDrawer() {
  const id = state.drawer.taskId;
  if (!id) return;
  const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/detail`);
  const data = await res.json();
  if (!res.ok) {
    $("#drawer").innerHTML = `<div class="feedback-box is-error">${esc(data.error)}</div>`;
    return;
  }
  if (state.drawer.taskId !== id) return;
  state.drawer.detail = data;
  state.drawer.sig = drawerSig(data.snapshot);
  renderDrawer();
}
const drawerSig = (s) => `${s.stage}|${s.queueState}|${s.logs.at(-1)?.text ?? ""}|${s.totals.runs}`;
const refreshDrawer = debounce(() => state.drawer.taskId && loadDrawer(), 800);

const DRAWER_TABS = [
  ["overview", "Tổng quan"],
  ["output", "Output"],
  ["artifacts", "Artifact"],
  ["calls", "Prompt & lượt chạy"],
  ["history", "Lịch sử"],
];

function renderDrawer() {
  const d = state.drawer.detail;
  if (!d) return;
  const { task, snapshot: s } = d;
  const slotId = task.slotId;
  const tab = state.drawer.tab;
  const keepInputs = {};
  for (const el of $$("#drawer [data-keep]")) keepInputs[el.dataset.keep] = el.type === "checkbox" ? el.checked : el.value;
  const scrollEl = $("#drawer .drawer-body");
  const scroll = scrollEl?.scrollTop ?? 0;

  let body = "";
  if (tab === "overview") body = drawerOverview(d);
  if (tab === "output") body = drawerOutput(task);
  if (tab === "artifacts") body = drawerArtifacts(d);
  if (tab === "calls") body = drawerCalls(d);
  if (tab === "history") body = `<ul class="history">${task.history.map((h) => `<li><span class="muted">${esc(new Date(h.at).toLocaleString("vi-VN"))}</span> <span class="who who-${h.by}">${esc(h.by)}</span> <span class="stage-raw">${esc(h.stage)}</span><div>${esc(h.summary)}</div></li>`).reverse().join("")}</ul>`;

  $("#drawer").innerHTML = `
    <div class="drawer-head">
      <div>
        <div class="muted small">${esc(slotId)} · ${esc(slotName(slotId))}${s.gated ? " · 🔒 cổng duyệt" : ""}</div>
        <div class="drawer-title">${esc(task.context.title)}${planTag(task.planRef)}</div>
        <div class="badges"><span class="badge ${s.colorClass}">${esc(s.label)}</span><span class="qstate q-${s.queueState}">${QUEUE_LABEL[s.queueState]}</span><span class="stage-raw">${esc(task.stage)}</span></div>
      </div>
      <button class="btn btn-icon" data-action="drawer-refresh" title="Làm mới">↻</button>
      <button class="btn btn-icon" data-action="drawer-close" title="Đóng (Esc)">✕</button>
    </div>
    <div class="drawer-tabs">${DRAWER_TABS.map(([k, label]) => `<button class="tab${tab === k ? " active" : ""}" data-action="drawer-tab" data-tab="${k}">${label}${k === "calls" ? ` (${d.calls.length})` : k === "artifacts" ? ` (${d.artifacts.length})` : ""}</button>`).join("")}</div>
    <div class="drawer-body">${body}</div>`;
  for (const [k, v] of Object.entries(keepInputs)) {
    const el = $(`#drawer [data-keep="${k}"]`);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
  }
  const nb = $("#drawer .drawer-body");
  if (nb) nb.scrollTop = scroll;
}

function drawerOverview(d) {
  const { task, snapshot: s } = d;
  const slots = [...state.slots.values()];
  const movable = MOVABLE.has(s.queueState);
  const decision = s.waitingForYou
    ? `<div class="drawer-section"><div class="panel-sub">Quyết định của bạn</div>
        ${s.checkpointBrief ? `<div class="checkpoint-box">${esc(s.checkpointBrief)}</div>` : ""}
        ${task.stage === "checkpoint_final" ? shipWarningNote(s) : ""}
        <textarea data-keep="decision-fb" data-feedback-for="${esc(task.id)}" rows="2" placeholder="Yêu cầu sửa / lý do từ chối (tuỳ chọn)"></textarea>
        <div class="decision-row"><button class="btn btn-approve" data-action="approve" data-task="${esc(task.id)}">Duyệt</button>${task.stage === "checkpoint_final" ? `<button class="btn btn-revise" data-action="revise" data-task="${esc(task.id)}">Yêu cầu sửa</button>` : ""}<button class="btn btn-reject" data-action="reject" data-task="${esc(task.id)}">Từ chối</button></div></div>`
    : "";
  const trace = (task.trace ?? []).slice().reverse();
  return `
    ${decision}
    ${s.lastError ? `<div class="feedback-box is-error">⚠ ${esc(s.lastError)}</div><button class="btn btn-small btn-retry" data-action="retry" data-task="${esc(task.id)}">↻ Thử lại</button>` : ""}
    ${alertsBlock(s)}
    ${s.queueState === "rejected" ? `<button class="btn btn-small btn-retry" data-action="retry" data-task="${esc(task.id)}">↻ Thử lại với ngân sách mới</button>` : ""}
    <div class="drawer-section kpis">
      <div><b>${s.totals.runs}</b><span>lượt chạy</span></div>
      <div><b>${fmtDur(s.totals.activeMs)}</b><span>thời gian làm</span></div>
      <div><b>${fmtTok(s.totals.tokens)}</b><span>token</span></div>
      <div><b>${fmtCost(s.totals.costUsd)}</b><span>chi phí</span></div>
    </div>
    <div class="drawer-section"><div class="panel-sub">Truy vết quyết định</div>
      ${trace.length ? `<ul class="trace">${trace.map((t) => `<li><span class="trace-kind k-${t.kind}">${TRACE_LABEL[t.kind] ?? t.kind}</span> <span class="muted small">${esc(t.by)} · ${esc(new Date(t.at).toLocaleString("vi-VN"))}</span><div>${esc(t.text)}</div></li>`).join("")}</ul>` : `<div class="muted small">Chưa có quyết định nào được ghi lại.</div>`}
    </div>
    <div class="drawer-section"><div class="panel-sub">Phối hợp</div>
      <div class="small">Nhận đầu vào từ: ${s.inputsFrom.length ? s.inputsFrom.map((i) => `${ownerChip(i.slotId)} ${esc(i.title)} ${i.handedOff ? "✓" : "<span class='muted'>(đang chờ)</span>"}`).join("<br>") : "<span class='muted'>không có</span>"}</div>
      <div class="small">Bàn giao cho: ${s.outputsTo.length ? s.outputsTo.map((o) => `${ownerChip(o.slotId)} ${esc(o.title)}`).join("<br>") : "<span class='muted'>không có</span>"}</div>
    </div>
    ${s.acceptanceCriteria.length ? `<div class="drawer-section"><div class="panel-sub">Tiêu chí nghiệm thu</div><ul class="ac">${s.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>` : ""}
    <div class="drawer-section"><div class="panel-sub">Điều phối</div>
      <div class="row-inline">
        <select data-keep="move-to" id="drawer-move-to" ${movable ? "" : "disabled"}>${slots.map((x) => `<option value="${x.id}"${x.id === task.slotId ? " selected" : ""}>${x.id} ${esc(x.name.replace(/^AI /, ""))}</option>`).join("")}</select>
        <button class="btn btn-small-inline" data-action="move" data-task="${esc(task.id)}" ${movable ? "" : "disabled"}>Gán lại</button>
        <button class="btn btn-small-inline" data-action="prioritize" data-task="${esc(task.id)}" data-slot="${esc(task.slotId)}" ${movable ? "" : "disabled"}>↑ Ưu tiên lên đầu</button>
      </div>
      ${movable ? "" : `<div class="muted small">${s.queueState === "running" ? "Đang chạy — bấm Pause hoặc chờ xong bước hiện tại để gán lại." : "Task đã xong."}</div>`}
      <div class="panel-sub">Chỉ thị cho ${esc(task.slotId)}</div>
      <textarea data-keep="steer-text" id="drawer-steer" rows="2" placeholder="Ví dụ: tập trung thêm đối thủ tại thị trường VN"></textarea>
      <label class="check"><input type="checkbox" data-keep="steer-redo" id="drawer-redo" /> làm lại phần đã thiết kế theo chỉ thị này</label>
      <button class="btn btn-small-inline" data-action="steer-drawer" data-slot="${esc(task.slotId)}">Gửi chỉ thị</button>
      ${d.slotDirectives.length || d.companyDirectives.length ? `<div class="directive-chips">${[...d.companyDirectives, ...d.slotDirectives].map((x) => `<span class="directive">📌 ${x.slotId ? "" : "(cả đội) "}${esc(x.text)} <button class="x" data-action="directive-remove" data-id="${esc(x.id)}">×</button></span>`).join("")}</div>` : ""}
    </div>`;
}

function drawerOutput(task) {
  const c = task.context;
  const block = (id, title, text, open = false) =>
    text ? `<details class="out-block" data-open-id="out:${task.id}:${id}"${state.open.has(`out:${task.id}:${id}`) || open ? " open" : ""}><summary>${title} <span class="muted small">${fmtTok(text.length)} ký tự</span></summary><pre class="out-pre">${esc(text)}</pre></details>` : "";
  const out = [
    block("feedback", "Phản hồi gần nhất", (c.reviewFeedback ?? []).join("\n\n"), true),
    block("brief", "Idea brief", c.ideaBrief),
    block("shared", "Bối cảnh chung của kế hoạch", c.sharedBrief),
    block("spec", "Architecture guide (Claude)", c.architectureSpec),
    block("impl", "Bài làm của Muse (nguyên văn)", c.implementationDiff),
    block("verify", "Verification log", c.verificationLog),
    block("upstream", "Đầu vào từ bàn giao", (c.upstream ?? []).map((u) => `[${u.slotId}] ${u.title}\nFiles: ${u.files.join(", ")}\n${u.specExcerpt}`).join("\n\n---\n\n")),
    block("attach", "Tài liệu CEO chuyển tới", (c.attachments ?? []).map((a) => `[${a.title} — ${a.from}]\n${a.content}`).join("\n\n---\n\n")),
  ].join("");
  return out || `<div class="muted">Chưa có output nào.</div>`;
}

function drawerArtifacts(d) {
  if (!d.artifacts.length) return `<div class="muted">Task này chưa tạo ra sản phẩm nào.</div>`;
  return `<div class="art-mini">${d.artifacts.map((x) => `<button class="art-item${state.artifacts.selected?.id === x.id ? " selected" : ""}" data-action="artifact-preview" data-id="${esc(x.id)}">${KIND_ICON[x.kind]} ${esc(x.title)}</button>`).join("")}</div><div id="drawer-art-preview" class="art-preview">${state.artifacts.selected && d.artifacts.some((x) => x.id === state.artifacts.selected.id) ? artifactPreview() : `<div class="muted">Chọn một sản phẩm để xem.</div>`}</div>`;
}

function drawerCalls(d) {
  if (!d.calls.length) return `<div class="muted">Chưa có lượt gọi agent nào.</div>`;
  const runs = d.task.runs ?? [];
  const stageAt = (iso) => runs.filter((r) => r.startedAt <= iso).at(-1)?.stage ?? "";
  return d.calls
    .map((c, i) => {
      const dur = new Date(c.endedAt).getTime() - new Date(c.startedAt).getTime();
      const id = `call:${d.task.id}:${i}`;
      return `<div class="call${c.error ? " call-err" : ""}">
        <div class="call-head"><span class="owner">${ENGINE_LABEL[c.engine] ?? c.engine}</span> <span class="stage-raw">${esc(stageAt(c.startedAt))}</span> <span class="muted small">${esc(new Date(c.startedAt).toLocaleTimeString("vi-VN"))} · ${fmtDur(dur)}${c.waitMs > 1000 ? ` (chờ ${fmtDur(c.waitMs)})` : ""} · ${fmtTok(c.usage.inputTokens)} in / ${fmtTok(c.usage.outputTokens)} out${c.usage.estimated ? "*" : ""}${c.usage.costUsd ? ` · ${fmtCost(c.usage.costUsd)}` : ""}</span>${c.verdict ? ` <span class="qstate ${c.verdict === "approve" ? "q-done" : "q-error"}">${c.verdict}</span>` : ""}</div>
        ${c.error ? `<div class="feedback-box is-error">${esc(c.error)}</div>` : ""}
        ${details(`${id}:p`, `Prompt (${fmtTok(c.prompt.length)} ký tự)`, `<pre class="out-pre">${esc(c.prompt)}</pre>`)}
        ${details(`${id}:o`, `Output (${fmtTok(c.output.length)} ký tự)`, `<pre class="out-pre">${esc(c.output)}</pre>`)}
      </div>`;
    })
    .reverse()
    .join("") + `<div class="muted small">* ước tính theo độ dài văn bản (agent không báo số token).</div>`;
}

// ---------- modal ----------
function openModal(html) {
  $("#modal").innerHTML = html;
  $("#modal").hidden = false;
  $("#modal-backdrop").hidden = false;
  $("#modal textarea, #modal input")?.focus();
}
function closeModal() {
  state.engineModal = null;
  $("#modal").hidden = true;
  $("#modal-backdrop").hidden = true;
}
function steerModal(slotId) {
  const slot = state.slots.get(slotId);
  openModal(`
    <div class="modal-title">✎ Chỉ thị cho ${esc(slotId)} · ${esc(slot?.name ?? "")}</div>
    <div class="muted small">Áp dụng cho mọi task chưa xong của nhân sự này, từ bước kế tiếp (lượt đang chạy làm nốt). Gỡ được bất cứ lúc nào.</div>
    <textarea id="modal-steer" rows="3" placeholder="Ví dụ: Tập trung thêm vào đối thủ tại thị trường Việt Nam"></textarea>
    <label class="check"><input type="checkbox" id="modal-redo" /> Làm lại phần đã thiết kế (quay về bước architecture với chỉ thị này)</label>
    <div class="decision-row"><button class="btn btn-primary" data-action="steer-submit" data-slot="${esc(slotId)}">Gửi chỉ thị</button><button class="btn btn-ghost" data-action="modal-close">Huỷ</button></div>`);
}
function sendModal(ds) {
  const opts = [...state.slots.values()].map((s) => `<option value="${s.id}">${s.id} ${esc(s.name.replace(/^AI /, ""))}</option>`).join("");
  openModal(`
    <div class="modal-title">↪ Gửi "${esc(ds.title)}" cho nhân sự khác</div>
    <div class="muted small">Sản phẩm được đính kèm làm tài liệu đầu vào cho task chưa xong đầu tiên của người nhận (hoặc tạo task mới nếu họ đang rảnh).</div>
    <select id="modal-to">${opts}</select>
    <textarea id="modal-note" rows="2" placeholder="Ghi chú cho người nhận (tuỳ chọn), ví dụ: dùng bảng này làm dữ liệu mẫu"></textarea>
    <div class="decision-row"><button class="btn btn-primary" data-action="send-submit" data-task="${esc(ds.task)}" data-kind="${esc(ds.kind)}" data-path="${esc(ds.path ?? "")}">Gửi</button><button class="btn btn-ghost" data-action="modal-close">Huỷ</button></div>`);
}

// ---------- event handling ----------
document.addEventListener("toggle", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement) || !el.dataset.openId) return;
  if (el.open) state.open.add(el.dataset.openId);
  else state.open.delete(el.dataset.openId);
}, true);

const INTERACTIVE = "input, textarea, select, summary, details, a, label";
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (e.target.closest(INTERACTIVE) && !e.target.closest("button[data-action]") && btn.dataset.action === "open-drawer") return;
  if (e.target.closest(INTERACTIVE) && btn.dataset.action === "select") return;
  const ds = btn.dataset;
  const action = ds.action;
  // local, no network
  switch (action) {
    case "select":
      if (e.target.closest("button.mini")) break;
      state.selected.set(ds.slot, ds.task);
      updateCard(state.slots.get(ds.slot));
      return;
    case "open-drawer":
      e.stopPropagation();
      return openDrawer(ds.task);
    case "drawer-close":
      return closeDrawer();
    case "drawer-refresh":
      return loadDrawer();
    case "drawer-tab":
      state.drawer.tab = ds.tab;
      return renderDrawer();
    case "view":
      return setView(ds.view);
    case "focus":
      return setFocus(state.focusSlot === ds.slot ? null : ds.slot);
    case "focus-clear":
      return setFocus(null);
    case "engine-open":
      state.engineModal = ds.engine;
      return renderEngineModal();
    case "inbox-open":
      state.inbox.open = true;
      state.inbox.tab = ds.tab;
      state.inbox.sig = "";
      return renderInbox();
    case "inbox-tab":
      state.inbox.tab = ds.tab;
      state.inbox.sig = "";
      return renderInbox();
    case "inbox-close":
      state.inbox.open = false;
      return renderInbox();
    case "snooze":
    case "unsnooze":
      if (action === "snooze") state.snoozed.add(ds.task);
      else state.snoozed.delete(ds.task);
      state.inbox.sig = "";
      renderInbox();
      return renderReviewBadges();
    case "goto-panel":
      state.inbox.open = false;
      renderInbox();
      if (state.view !== "org") setView("org");
      state.sideTab = ds.target === "plan-panel" ? "plan" : "flow";
      renderSideTabs();
      return $(`#${ds.target}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    case "tl-group":
      state.tl.group = ds.value;
      return renderTimeline();
    case "tl-color":
      state.tl.color = ds.value;
      return renderTimeline();
    case "tl-range":
      state.tl.range = ds.value === "all" ? "all" : Number(ds.value);
      return renderTimeline();
    case "tl-status": {
      const set = state.tl.statuses;
      if (set.has(ds.value) && set.size > 1) set.delete(ds.value);
      else set.add(ds.value);
      return renderTimeline();
    }
    case "tl-agent": {
      // First click isolates one agent; later clicks add/remove.
      if (!state.tl.agents) state.tl.agents = new Set([ds.slot]);
      else if (state.tl.agents.has(ds.slot)) state.tl.agents.delete(ds.slot);
      else state.tl.agents.add(ds.slot);
      if (!state.tl.agents.size) state.tl.agents = null;
      return renderTimeline();
    }
    case "tl-agents-all":
      state.tl.agents = null;
      return renderTimeline();
    case "tl-lane": {
      const tier = Number(ds.tier);
      if (state.tl.collapsed.has(tier)) state.tl.collapsed.delete(tier);
      else state.tl.collapsed.add(tier);
      return renderTimeline();
    }
    case "filter":
      state.filter = ds.filter;
      state.tl.statuses = new Set(FILTER_STATUSES[ds.filter] ?? FILTER_STATUSES.all);
      if (state.view === "timeline") renderTimeline();
      $$(".filter[data-filter]").forEach((b) => b.classList.toggle("active", b.dataset.filter === ds.filter));
      for (const slot of state.slots.values()) applyFilter($(`#org .card[data-slot="${slot.id}"]`), slot);
      if (state.view === "flow") renderFlowView();
      return;
    case "toggle-edges":
      state.showAllEdges = !state.showAllEdges;
      btn.classList.toggle("active", state.showAllEdges);
      btn.setAttribute("aria-pressed", String(state.showAllEdges));
      btn.innerHTML = `↔ Đường nối: <b>${state.showAllEdges ? "Bật" : "Tắt"}</b>`;
      if (state.view !== "org") setView("org");
      return drawEdges();
    case "steer-open":
      return steerModal(ds.slot);
    case "artifact-send-open":
      return sendModal(ds);
    case "artifact-preview":
      return previewArtifact(ds.id);
    case "modal-close":
      return closeModal();
    case "expand":
      e.stopPropagation();
      if (state.open.has(ds.key)) state.open.delete(ds.key);
      else state.open.add(ds.key);
      if (ds.key.startsWith("goal:")) return renderPlanPanel();
      renderCompanyDirectives();
      for (const slot of state.slots.values()) updateCard(slot);
      return scheduleEdges();
    case "composer-open":
      state.composer.manual = true;
      renderComposer();
      return goalInput.focus();
    case "role-open":
      e.stopPropagation();
      return openRole(ds.slot, ds.tab);
    case "role-close":
      return closeRole();
    case "role-tab":
      state.role.tab = ds.tab;
      return renderRoleDrawer();
    case "org-density":
      state.orgDensity = ds.value;
      localStorage.setItem("dash-org-density", ds.value);
      applyOrgDensity();
      return scheduleEdges();
    case "side-tab":
      state.sideTab = ds.tab;
      return renderSideTabs();
    case "banner-dismiss":
      localStorage.setItem("dash-banner-dismissed", ds.plan);
      return renderDoneBanner();
  }
  btn.disabled = true;
  try {
    if (action === "run") await post(`/api/slots/${ds.slot}/run`, { goal: goalInput.value.trim() });
    if (action === "approve" || action === "reject" || action === "revise") {
      const fb = [...document.querySelectorAll(`[data-feedback-for="${CSS.escape(ds.task)}"]`)].map((x) => x.value).find((v) => v.trim()) ?? "";
      if (action === "revise" && !fb.trim()) {
        toast("Ghi rõ cần sửa gì vào ô phản hồi trước khi bấm Yêu cầu sửa.");
        return;
      }
      const warns = action === "approve" ? redAlerts(findTaskSnapshot(ds.task)) : [];
      if (warns.length) {
        // An in-page confirmation (not the browser's confirm()), listing every red warning.
        openModal(`
          <div class="modal-title">⚠ Kết quả có ${warns.length} cảnh báo đỏ</div>
          <ul class="ship-warn-list">${warns.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
          <div class="muted small">Duyệt nghĩa là ship kết quả này dù có các cảnh báo trên.</div>
          <div class="decision-row"><button class="btn btn-approve" data-action="approve-confirmed" data-task="${esc(ds.task)}">Vẫn duyệt</button><button class="btn btn-ghost" data-action="modal-close">Huỷ</button></div>`);
        return;
      }
      if (await post(`/api/tasks/${encodeURIComponent(ds.task)}/decision`, { action, feedback: fb })) refreshDrawer();
    }
    if (action === "approve-confirmed") {
      const fb = [...document.querySelectorAll(`[data-feedback-for="${CSS.escape(ds.task)}"]`)].map((x) => x.value).find((v) => v.trim()) ?? "";
      if (await post(`/api/tasks/${encodeURIComponent(ds.task)}/decision`, { action: "approve", feedback: fb, confirmWarnings: true })) {
        closeModal();
        refreshDrawer();
      }
    }
    if (action === "retry") (await post(`/api/tasks/${encodeURIComponent(ds.task)}/retry`)) && refreshDrawer();
    if (action === "prioritize") (await post(`/api/tasks/${encodeURIComponent(ds.task)}/move`, { toSlot: ds.slot, position: "top" })) && toast("Đã đưa lên đầu hàng đợi.");
    if (action === "move") {
      const to = $("#drawer-move-to")?.value;
      if (await post(`/api/tasks/${encodeURIComponent(ds.task)}/move`, { toSlot: to })) {
        toast(`Đã gán lại cho ${to}.`);
        refreshDrawer();
      }
    }
    if (action === "gate") await post(`/api/slots/${ds.slot}/gate`, { enabled: ds.enabled === "1" });
    if (action === "directive-remove") (await post(`/api/steer/${encodeURIComponent(ds.id)}/remove`)) && refreshDrawer();
    if (action === "steer-submit") {
      const text = $("#modal-steer").value;
      if (await post("/api/steer", { slotId: ds.slot, text, redo: $("#modal-redo").checked })) {
        closeModal();
        toast(`Đã gửi chỉ thị cho ${ds.slot}.`);
      }
    }
    if (action === "steer-drawer") {
      const text = $("#drawer-steer").value;
      if (await post("/api/steer", { slotId: ds.slot, text, redo: $("#drawer-redo").checked })) {
        $("#drawer-steer").value = "";
        toast(`Đã gửi chỉ thị cho ${ds.slot}.`);
        refreshDrawer();
      }
    }
    if (action === "send-submit") {
      const res = await post("/api/artifacts/send", { taskId: ds.task, kind: ds.kind, path: ds.path || undefined, toSlot: $("#modal-to").value, note: $("#modal-note").value });
      if (res) {
        closeModal();
        toast(res.created ? `Đã tạo task mới cho ${$("#modal-to")?.value ?? "người nhận"} với sản phẩm này làm đầu vào.` : "Đã đính kèm vào task hiện tại của người nhận.");
      }
    }
    if (action === "plan-approve" || action === "plan-reject") {
      const fb = [...document.querySelectorAll(`[data-plan-feedback="${CSS.escape(ds.plan)}"]`)].map((x) => x.value).find((v) => v.trim()) ?? "";
      await post(`/api/plan/${encodeURIComponent(ds.plan)}/decision`, { approved: action === "plan-approve", feedback: fb, ...planProjectInputs(ds.plan) });
    }
    if (action === "plan-project-save") {
      if (await post(`/api/plan/${encodeURIComponent(ds.plan)}/project`, planProjectInputs(ds.plan))) toast("Đã lưu thư mục & lệnh kiểm tra.");
    }
    if (action === "plan-retry") await post(`/api/plan/${encodeURIComponent(ds.plan)}/retry`);
    if (action === "seo-run") {
      const body = { domain: $("#seo-domain").value, keyword: $("#seo-key").value, links: $("#seo-links").value.split(/\s+/).filter(Boolean) };
      if (await post("/api/contentseo/run", body)) toast("Đã bắt đầu tạo bài — theo dõi tiến độ ngay bên dưới.");
    }
    if (action === "seo-stop") await post("/api/contentseo/run/stop");
    if (action === "seo-bot-start") (await post("/api/contentseo/bot/start")) && toast("Đã bật bot Telegram.");
    if (action === "seo-bot-stop") await post("/api/contentseo/bot/stop");
    if (action === "seo-check") await post("/api/contentseo/check");
    if (action === "seo-rerun") {
      const r = state.seo?.runs.find((x) => x.id === ds.run);
      if (r) {
        $("#seo-domain").value = r.domain;
        $("#seo-key").value = r.keyword;
        $("#seo-links").value = r.links.join("\n");
        toast("Đã điền lại form — bấm Tạo bài để chạy (chỉ tạo bù các bài còn thiếu).");
      }
    }
    if (action === "rebalance") {
      if (await post("/api/rebalance")) {
        toast("Sếp đang xem tải của từng người — đề xuất sẽ hiện ở tab Bàn giao & nghẽn bên phải.");
        if (state.view !== "org") setView("org");
        state.sideTab = "flow";
        renderSideTabs();
      }
    }
    if (action === "rebalance-apply") {
      const indexes = $$("#rebalance-box [data-rb-idx]").filter((c) => c.checked).map((c) => Number(c.dataset.rbIdx));
      if (!indexes.length) return toast("Chưa chọn đề xuất nào.");
      const res = await post(`/api/rebalance/${encodeURIComponent(ds.id)}/apply`, { indexes });
      if (res) toast(`Đã áp dụng ${res.applied} đề xuất${res.skipped ? `, bỏ qua ${res.skipped} (xem ghi chú)` : ""}.`);
    }
    if (action === "rebalance-dismiss") await post("/api/rebalance/dismiss");
    if (action === "lesson-accept" || action === "lesson-dismiss" || action === "lesson-remove") {
      const text = $(`[data-lesson-text="${CSS.escape(ds.id)}"]`)?.value;
      if (await post(`/api/lessons/${encodeURIComponent(ds.id)}/${action.slice(7)}`, { text })) {
        toast(action === "lesson-accept" ? "Đã duyệt bài học — áp dụng cho các task sau của vị trí này." : action === "lesson-dismiss" ? "Đã bỏ qua đề xuất." : "Đã xoá bài học.");
      }
    }
    if (action === "lesson-add") {
      const input = $("#lesson-new");
      if (await post(`/api/roles/${encodeURIComponent(ds.slot)}/lessons`, { text: input?.value ?? "" })) {
        if (input) input.value = "";
        toast("Đã thêm bài học.");
      }
    }
    if (action === "promote") (await post(`/api/engines/${encodeURIComponent(ds.engine)}/promote`, { id: ds.id })) && toast("Đã đưa lượt này lên đầu hàng đợi.");
  } finally {
    btn.disabled = false;
  }
});

// Clicking anywhere on a card (outside its controls) opens the current task.
$("#org").addEventListener("click", (e) => {
  if (e.target.closest("[data-action], " + INTERACTIVE + ", .queue, pre.live")) return;
  const card = e.target.closest(".card");
  if (!card) return;
  const slot = state.slots.get(card.dataset.slot);
  const t = slot && selectedTask(slot);
  if (t) openDrawer(t.id);
});

// Hover a card (or any AG-xx reference) to highlight who it takes input from and hands output to.
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-hover-slot], #org .card");
  const id = el ? el.dataset.hoverSlot || el.dataset.slot : null;
  if (id === state.hoverSlot) return;
  state.hoverSlot = id;
  if (state.view === "org") drawEdges();
});

// Drag a queued task onto another card to reassign it.
document.addEventListener("dragstart", (e) => {
  const row = e.target.closest("[data-drag-task]");
  if (!row) return;
  e.dataTransfer.setData("text/task", row.dataset.dragTask);
  e.dataTransfer.effectAllowed = "move";
  document.body.classList.add("dragging");
});
document.addEventListener("dragend", () => {
  document.body.classList.remove("dragging");
  $$(".card.drop-target").forEach((c) => c.classList.remove("drop-target"));
});
document.addEventListener("dragover", (e) => {
  const card = e.target.closest("#org .card");
  if (!card || !e.dataTransfer.types.includes("text/task")) return;
  e.preventDefault();
  $$(".card.drop-target").forEach((c) => c !== card && c.classList.remove("drop-target"));
  card.classList.add("drop-target");
});
document.addEventListener("drop", async (e) => {
  const card = e.target.closest("#org .card");
  const taskId = e.dataTransfer.getData("text/task");
  if (!card || !taskId) return;
  e.preventDefault();
  card.classList.remove("drop-target");
  if (await post(`/api/tasks/${encodeURIComponent(taskId)}/move`, { toSlot: card.dataset.slot })) toast(`Đã gán lại cho ${card.dataset.slot}.`);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#modal").hidden) closeModal();
  else if (!$("#role-drawer").hidden) closeRole();
  else if (!$("#drawer").hidden) closeDrawer();
  else if (state.inbox.open) {
    state.inbox.open = false;
    renderInbox();
  } else if (state.focusSlot) setFocus(null);
});
$("#drawer-backdrop").addEventListener("click", closeDrawer);
$("#role-backdrop").addEventListener("click", () => closeRole());
$("#inbox-backdrop").addEventListener("click", () => {
  state.inbox.open = false;
  renderInbox();
});
$("#modal-backdrop").addEventListener("click", closeModal);

document.addEventListener("input", (e) => {
  if (e.target.id === "art-search") {
    state.artifacts.q = e.target.value;
    renderArtifacts();
  }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "art-agent") {
    state.artifacts.agent = e.target.value;
    renderArtifacts();
  }
});

$("#run-all-btn").addEventListener("click", async () => {
  const goal = goalInput.value.trim();
  if (!goal) return toast("Nhập mục tiêu chung cho cả công ty trước đã.");
  const projectDir = $("#project-dir-input").value.trim();
  if (!projectDir && !state.projectsRoot) return toast("Nhập thư mục dự án (đường dẫn tuyệt đối) — nơi code của mục tiêu này được ghi và kiểm tra.");
  const autoApprove = $("#opt-autoapprove").checked;
  const skipClaudeReviewWhenGreen = $("#opt-skipreview").checked;
  const githubRepo = $("#opt-github").checked && !$("#opt-github").disabled;
  if (await post("/api/run-all", { goal, projectDir, autoApprove, skipClaudeReviewWhenGreen, githubRepo })) toast("Đã giao mục tiêu cho Sếp — đang lập cây công việc.");
});
$("#composer-toggle").addEventListener("click", () => {
  const open = !$("#composer").classList.contains("collapsed");
  state.composer.manual = !open;
  renderComposer();
  if (!open) goalInput.focus();
});
$("#theme-btn").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
setTheme(document.documentElement.dataset.theme || "dark");
$("#pause-btn").addEventListener("click", async () => {
  await post(state.control.paused ? "/api/control/resume" : "/api/control/pause");
});
$("#stop-btn").addEventListener("click", async () => {
  if (!confirm("Stop huỷ ngay mọi lượt AI đang chạy (bước đó sẽ chạy lại từ đầu khi bấm Resume). Tiếp tục?")) return;
  if (await post("/api/control/stop")) toast("Đã dừng. Bấm Resume để chạy tiếp.");
});
$("#reset-btn").addEventListener("click", async () => {
  if (!confirm("Reset sẽ bỏ gán toàn bộ task khỏi 10 khung, xoá chỉ thị và huỷ kế hoạch đang chờ (không xoá dữ liệu task). Task đang chạy dừng sau bước hiện tại. Tiếp tục?")) return;
  await post("/api/reset");
});
$("#approve-all-btn").addEventListener("click", async (e) => {
  const n = e.currentTarget.dataset.count;
  if (!confirm(`Duyệt cùng lúc ${n} task đang chờ bạn? Task ở checkpoint cuối sẽ được ship (done). Hãy chắc là bạn đã xem kết quả của chúng.`)) return;
  await post("/api/approve-all");
});
$("#company-steer-btn").addEventListener("click", async () => {
  const input = $("#company-steer");
  if (await post("/api/steer", { slotId: null, text: input.value, redo: $("#company-redo").checked })) {
    input.value = "";
    toast("Đã gửi chỉ thị cho cả đội.");
  }
});
$("#company-steer").addEventListener("keydown", (e) => e.key === "Enter" && $("#company-steer-btn").click());

function setView(view) {
  state.view = view;
  $$(".tab[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  for (const v of ["org", "flow", "timeline", "roles", "artifacts", "seo"]) $(`#view-${v}`).hidden = v !== view;
  $("#filters").classList.toggle("hidden-filters", view === "artifacts" || view === "seo" || view === "roles");
  $("#g-tip").hidden = true;
  if (view === "org") scheduleEdges();
  if (view === "flow") renderFlowView();
  if (view === "timeline") loadTimeline();
  if (view === "artifacts") loadArtifacts();
  if (view === "roles") loadScoreboard();
  if (view === "seo") loadSeo();
}

// ---------- Auto Content SEO tab ----------
const SEO_STATUS = {
  running: ["q-running", "Đang chạy"],
  done: ["q-done", "Xong"],
  partial: ["q-waiting_you", "Xong một phần"],
  quota: ["q-waiting_you", "Hết quota Gemini"],
  failed: ["q-error", "Lỗi"],
  stopped: ["q-error", "Đã dừng"],
};
const seoBadge = (s) => `<span class="qstate ${(SEO_STATUS[s] ?? ["", s])[0]}">${esc((SEO_STATUS[s] ?? ["", s])[1])}</span>`;

async function loadSeo() {
  const res = await fetch("/api/contentseo");
  state.seo = await res.json();
  renderSeo();
}

/** The form is drawn once (so typing survives live updates); status, bot and history redraw on every update. */
function renderSeo() {
  const el = $("#view-seo");
  if (!el) return;
  const d = state.seo;
  if (!d) {
    el.innerHTML = `<div class="view-intro">Chưa cấu hình. Thêm <code>CONTENTSEO_DIR=/đường/dẫn/tới/dự-án</code> vào <code>.env</code> của dashboard rồi khởi động lại.</div>`;
    return;
  }
  if (!el.querySelector("#seo-form")) {
    el.innerHTML = `
      <div class="seo-grid">
        <div class="panel seo-card">
          <div class="panel-title">✍️ Tạo bài SEO</div>
          <div id="seo-check" class="small"></div>
          <form id="seo-form" onsubmit="return false">
            <label class="panel-sub">Domain (tên folder trên Google Drive)</label>
            <input class="feedback-input" id="seo-domain" placeholder="vd: UY88" />
            <label class="panel-sub">Key (từ khoá chính)</label>
            <input class="feedback-input" id="seo-key" placeholder="vd: UY88" />
            <label class="panel-sub">Link tham khảo — mỗi dòng một link (4–5 link)</label>
            <textarea class="feedback-input" id="seo-links" rows="5" placeholder="https://..."></textarea>
            <div class="decision-row"><button class="btn btn-primary" data-action="seo-run" id="seo-run-btn">✍️ Tạo bài</button></div>
          </form>
          <div id="seo-current"></div>
        </div>
        <div class="panel seo-card">
          <div class="panel-title">🤖 Bot Telegram</div>
          <div id="seo-bot"></div>
        </div>
        <div class="panel seo-card seo-wide">
          <div class="panel-title">🗂 Lịch sử tạo bài</div>
          <div id="seo-history"></div>
        </div>
      </div>`;
  }
  const c = d.check;
  $("#seo-check").innerHTML = !c
    ? `<span class="muted">Đang kiểm tra cấu hình…</span>`
    : c.ok
      ? `<span class="why">✓ Cấu hình sẵn sàng · model <code>${esc(c.model ?? "?")}</code> · ${c.articles ?? "?"} bài mỗi lượt</span>`
      : `<div class="feedback-box is-error">⚠ ${esc(c.error ?? "Cấu hình chưa sẵn sàng")}</div><button class="btn btn-small-inline" data-action="seo-check">Kiểm tra lại</button>`;
  const run = d.current;
  $("#seo-run-btn").disabled = Boolean(run);
  $("#seo-current").innerHTML = run
    ? `<div class="seo-run">
        <div>${seoBadge(run.status)} <b>${esc(run.domain)}</b> / ${esc(run.keyword)} <span class="muted small">· bắt đầu ${esc(new Date(run.startedAt).toLocaleTimeString("vi-VN"))}</span>
          <button class="btn btn-small-inline btn-danger-ghost" data-action="seo-stop">⏹ Dừng</button></div>
        ${run.folderUrl ? `<div>📁 <a href="${esc(run.folderUrl)}" target="_blank" rel="noopener">Mở folder Drive</a></div>` : ""}
        <pre class="live seo-progress">${esc(run.progress.map((p) => p.text).join("\n") || "Đang khởi động…")}</pre>
      </div>`
    : "";
  const pre = el.querySelector(".seo-progress");
  if (pre) pre.scrollTop = pre.scrollHeight;
  const b = d.bot;
  $("#seo-bot").innerHTML = `
    <div>${b.running ? `<span class="qstate q-running">Đang chạy</span> <span class="muted small">pid ${b.pid} · từ ${esc(new Date(b.startedAt).toLocaleTimeString("vi-VN"))}</span>` : `<span class="qstate">Đã tắt</span>`}
      ${b.running ? `<button class="btn btn-small-inline btn-danger-ghost" data-action="seo-bot-stop">⏹ Tắt bot</button>` : `<button class="btn btn-small-inline" data-action="seo-bot-start">▶ Bật bot</button>`}</div>
    <div class="muted small">Bot nhận lệnh qua Telegram như trước. Bot tắt khi dashboard tắt. Đừng chạy thêm một bản bot ở nơi khác cùng lúc (Telegram sẽ báo xung đột).</div>
    <pre class="live seo-botlog">${esc(b.log.join("\n") || "(chưa có log)")}</pre>`;
  const log = el.querySelector(".seo-botlog");
  if (log) log.scrollTop = log.scrollHeight;
  $("#seo-history").innerHTML = d.runs.length
    ? `<table class="seo-table"><thead><tr><th>Thời gian</th><th>Domain / Key</th><th>Kết quả</th><th>Folder</th><th></th></tr></thead><tbody>${d.runs
        .map(
          (r) => `<tr>
            <td class="small">${esc(new Date(r.startedAt).toLocaleString("vi-VN"))}</td>
            <td><b>${esc(r.domain)}</b> / ${esc(r.keyword)}<div class="muted small">${r.links.length} link</div></td>
            <td>${seoBadge(r.status)} ${r.result ? `<span class="small">${esc(r.result)} bài</span>` : ""}${r.error ? `<div class="muted small">${esc(r.error.slice(0, 160))}</div>` : ""}</td>
            <td>${r.folderUrl ? `<a href="${esc(r.folderUrl)}" target="_blank" rel="noopener">Drive</a>` : "—"}</td>
            <td>${r.status === "running" ? "" : `<button class="btn btn-small-inline" data-action="seo-rerun" data-run="${esc(r.id)}" title="Điền lại form với cùng domain/key/link (chỉ tạo bù bài còn thiếu)">↻ Dùng lại</button>`}</td>
          </tr>`,
        )
        .join("")}</tbody></table>`
    : `<div class="muted">Chưa có lượt nào.</div>`;
}

// ---------- roles: playbook drawer & scoreboard ----------
const MODEL_TIER = { light: ["Nhẹ", "Kiến trúc dùng CLAUDE_MODEL_LIGHT nếu đã đặt"], standard: ["Chuẩn", "Dùng model mặc định"], strong: ["Mạnh", "Kiến trúc và review dùng CLAUDE_MODEL_STRONG nếu đã đặt"] };
const CHECK_LABEL = { secrets: "Quét secret", tests: "Bắt buộc có test", stubs: "Cấm code giả", ios_destination: "Build iOS đúng simulator" };

function renderLessonBadges() {
  const n = Object.values(state.lessons.pending ?? {}).reduce((a, b) => a + b, 0);
  const badge = $("#lessons-tab-badge");
  badge.hidden = !n;
  badge.textContent = String(n);
  badge.title = `${n} bài học chờ bạn duyệt`;
}

/** Just enough Markdown for a playbook: headings, quotes, bullets, inline code and bold. */
function miniMarkdown(md) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const out = [];
  let list = false;
  for (const line of md.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) out.push("</ul>");
    list = false;
    if (/^#\s/.test(line)) out.push(`<h3>${inline(line.replace(/^#\s+/, ""))}</h3>`);
    else if (/^##\s/.test(line)) out.push(`<h4>${inline(line.replace(/^##\s+/, ""))}</h4>`);
    else if (/^>\s?/.test(line)) out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("");
}

async function openRole(slotId, tab) {
  state.role = { slotId, tab: tab ?? (state.lessons.pending[slotId] ? "lessons" : "playbook"), detail: null };
  $("#role-drawer").hidden = false;
  $("#role-backdrop").hidden = false;
  $("#role-drawer").innerHTML = `<div class="drawer-loading muted">Đang tải playbook…</div>`;
  await loadRole(slotId);
}
function closeRole() {
  state.role = { slotId: null, tab: "playbook", detail: null };
  $("#role-drawer").hidden = true;
  $("#role-backdrop").hidden = true;
}
async function loadRole(slotId) {
  const res = await fetch(`/api/roles/${encodeURIComponent(slotId)}`);
  if (!res.ok) return toast("Không tải được playbook.");
  if (state.role.slotId !== slotId) return;
  state.role.detail = await res.json();
  renderRoleDrawer();
}

function renderRoleDrawer() {
  const d = state.role.detail;
  if (!d) return;
  const r = d.role;
  const pending = d.lessons.filter((l) => l.status === "pending");
  const accepted = d.lessons.filter((l) => l.status === "accepted");
  const [tierName, tierTip] = MODEL_TIER[r.modelTier] ?? MODEL_TIER.standard;
  const tab = (id, label) => `<button class="tab${state.role.tab === id ? " active" : ""}" data-action="role-tab" data-tab="${id}">${label}</button>`;
  const body =
    state.role.tab === "playbook"
      ? `<div class="pb-note muted small">Nội dung này được chèn vào prompt của mọi task thuộc ${esc(r.id)}: mỗi bước nhận đúng phần của mình. Sửa file <code>${esc(d.playbookPath)}</code> để thay đổi — áp dụng ngay từ bước kế tiếp.</div>
         <div class="playbook">${miniMarkdown(d.playbook || "_Chưa có playbook._")}</div>`
      : `<div class="pb-note muted small">Khi một task của vị trí này được ship sau khi bị trả về, hệ thống đề xuất một bài học từ các phản hồi. Bạn sửa thành quy tắc chung rồi duyệt; bài học đã duyệt được chèn vào prompt cùng mục "Bài học" của playbook.</div>
         <div class="panel-sub">Chờ bạn duyệt (${pending.length})</div>
         ${pending.length ? pending.map((l) => `
           <div class="lesson pending">
             ${l.source ? `<div class="muted small">Từ task: ${esc(l.source.title)} · ${esc(fmtTime(l.createdAt))}</div>` : ""}
             <textarea rows="5" data-lesson-text="${esc(l.id)}">${esc(l.text)}</textarea>
             <div class="decision-row"><button class="btn btn-approve" data-action="lesson-accept" data-id="${esc(l.id)}">Duyệt bài học</button><button class="btn btn-ghost" data-action="lesson-dismiss" data-id="${esc(l.id)}">Bỏ qua</button></div>
           </div>`).join("") : `<div class="muted small">Không có đề xuất nào.</div>`}
         <div class="panel-sub">Đã áp dụng (${accepted.length})</div>
         ${accepted.length ? accepted.map((l) => `<div class="lesson"><div>${esc(l.text)}</div><button class="mini" data-action="lesson-remove" data-id="${esc(l.id)}" title="Xoá bài học này">Xoá</button></div>`).join("") : `<div class="muted small">Chưa có bài học nào ngoài playbook.</div>`}
         <div class="panel-sub">Thêm bài học</div>
         <textarea id="lesson-new" rows="3" placeholder="Ví dụ: Model dùng trong List/ForEach phải Identifiable với id ổn định."></textarea>
         <div class="row-inline"><button class="btn btn-small-inline" data-action="lesson-add" data-slot="${esc(r.id)}">Thêm</button></div>`;
  $("#role-drawer").innerHTML = `
    <div class="drawer-head">
      <span class="avatar tier-${r.tier}" style="--h:${(Number(r.id.replace(/\D/g, "")) * 47 + 190) % 360};--p:100">${esc(initials(r.name))}</span>
      <div>
        <div class="muted small">${esc(r.teamName)} · ${esc(r.tierLabel)} · ${esc(r.id)}</div>
        <div class="drawer-title">${esc(r.name.replace(/^AI /, ""))}</div>
        <div class="muted small">${esc(r.summary)}</div>
        <div class="role-chips">
          <span class="rv-chip" title="${esc(tierTip)}">Model: ${tierName}</span>
          ${r.checks.map((c) => `<span class="rv-chip gate" title="Chạy ở bước kiểm tra cho mọi task của vị trí này">✓ ${esc(CHECK_LABEL[c] ?? c)}</span>`).join("")}
          ${r.gated ? `<span class="rv-chip">🔒 Cổng duyệt</span>` : ""}
        </div>
      </div>
      <button class="btn btn-ghost btn-square" data-action="role-close" title="Đóng (Esc)">✕</button>
    </div>
    <div class="drawer-tabs">${tab("playbook", "Playbook")}${tab("lessons", `Bài học${pending.length ? ` <span class="side-badge">${pending.length}</span>` : ""}`)}</div>
    <div class="drawer-body">${body}</div>`;
}

async function loadScoreboard() {
  const res = await fetch("/api/scoreboard");
  if (!res.ok) return;
  state.scoreboard = await res.json();
  renderRolesView();
}

function renderRolesView() {
  const el = $("#view-roles");
  const sb = state.scoreboard;
  if (!sb) {
    el.innerHTML = `<div class="muted">Đang tải…</div>`;
    return;
  }
  const byId = new Map(sb.roles.map((r) => [r.slotId, r]));
  const teams = state.teamsDef.length ? state.teamsDef : [{ id: null, name: "Tất cả" }];
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const rateCell = (row) => {
    const p = pct(row.firstPass, row.done);
    if (p === null) return `<span class="muted">—</span>`;
    const cls = row.done < 3 ? "few" : p >= 70 ? "good" : p >= 40 ? "mid" : "low";
    return `<div class="rate ${cls}" title="${row.firstPass}/${row.done} task xong mà không bị review từ chối, không lỗi kiểm tra, không bị CEO trả về${row.done < 3 ? " — còn ít dữ liệu" : ""}"><div class="rate-bar"><i style="width:${p}%"></i></div><b>${p}%</b></div>`;
  };
  const rows = (teamId) =>
    [...state.slots.values()]
      .filter((s) => teamId === null || s.team === teamId)
      .sort((a, b) => a.tier - b.tier)
      .map((s) => {
        const r = byId.get(s.id) ?? { tasks: 0, done: 0, rejected: 0, firstPass: 0, archRejects: 0, reviewRejects: 0, verifyFails: 0, ceoSendBacks: 0, roleCheckFails: 0, costUsd: 0, activeMs: 0 };
        const [tierName, tierTip] = MODEL_TIER[s.modelTier] ?? MODEL_TIER.standard;
        const pend = state.lessons.pending[s.id] ?? 0;
        const acc = state.lessons.accepted[s.id] ?? 0;
        return `<tr>
          <td><div class="sb-role">${avatar(s)}<div><b>${esc(s.name.replace(/^AI /, ""))}</b><span class="muted small">${esc(s.id)} · ${esc(s.tierLabel)}</span></div></div></td>
          <td><span class="rv-chip model-${s.modelTier}" title="${esc(tierTip)}">${tierName}</span></td>
          <td class="sb-checks">${s.checks.length ? s.checks.map((c) => `<span class="rv-chip gate">${esc(CHECK_LABEL[c] ?? c)}</span>`).join("") : `<span class="muted small">—</span>`}</td>
          <td class="num">${r.done}<span class="muted">/${r.tasks}</span>${r.rejected ? ` <span class="q-error" title="Bị loại hẳn">· ${r.rejected} loại</span>` : ""}</td>
          <td>${rateCell(r)}</td>
          <td class="num" title="Thiết kế bị Gemini phản biện / review từ chối / lệnh kiểm tra thất bại / CEO trả về / kiểm tra vai trò trượt">${r.archRejects} · ${r.reviewRejects} · ${r.verifyFails} · ${r.ceoSendBacks}${r.roleCheckFails ? ` · <span class="q-error">${r.roleCheckFails}</span>` : ""}</td>
          <td class="num">${fmtCost(r.costUsd)}<div class="muted small">${fmtDur(r.activeMs)}</div></td>
          <td class="num">${acc}${pend ? ` <span class="side-badge" title="${pend} chờ duyệt">${pend}</span>` : ""}</td>
          <td><button class="btn btn-small-inline" data-action="role-open" data-slot="${esc(s.id)}"${pend ? ' data-tab="lessons"' : ""}>📘 Playbook</button></td>
        </tr>`;
      })
      .join("");
  el.innerHTML = `
    <div class="view-intro">Mỗi vị trí có một playbook riêng (năng lực, cách thiết kế, cách viết code, cách review, bài học) được chèn vào prompt của mọi task thuộc vị trí đó, cùng các bài kiểm tra riêng chạy ở bước kiểm tra.
      Số liệu lấy từ <b>${sb.taskCount}</b> task${sb.since ? ` kể từ ${esc(new Date(sb.since).toLocaleDateString("vi-VN"))}` : ""}, kể cả task cũ trước khi có playbook.</div>
    <div class="sb-wrap"><table class="sb-table">
      <thead><tr><th>Vị trí</th><th>Model</th><th>Kiểm tra riêng</th><th class="num">Xong / tổng</th><th>Qua ngay lần đầu</th><th class="num" title="Thiết kế bị phản biện · review từ chối · kiểm tra thất bại · CEO trả về">Bị trả về<br><span class="muted small">TK · RV · KT · CEO</span></th><th class="num">Chi phí</th><th class="num">Bài học</th><th></th></tr></thead>
      ${teams.map((t) => `<tbody><tr class="sb-team"><td colspan="9">${esc(t.name)}${t.description ? ` <span class="muted small">— ${esc(t.description)}</span>` : ""}</td></tr>${rows(t.id)}</tbody>`).join("")}
    </table></div>`;
}

// ---------- data ----------
function applyStatus(data) {
  state.slots = new Map(data.slots.map((s) => [s.id, s]));
  state.plan = data.plan;
  state.teamsDef = data.teams ?? [];
  state.lessons = data.lessons ?? { pending: {}, accepted: {} };
  renderLessonBadges();
  const dirInput = $("#project-dir-input");
  state.projectsRoot = data.settings?.projectsRoot || null;
  const gh = $("#opt-github");
  if (gh) {
    gh.disabled = !data.settings?.githubAvailable;
    $("#opt-github-label").title = gh.disabled
      ? "Chưa dùng được: cần đăng nhập GitHub CLI (gh auth login) rồi khởi động lại dashboard."
      : "Khi duyệt kế hoạch: tạo repo GitHub riêng tư cho dự án; mỗi task được duyệt sẽ được commit và push lên đó.";
  }
  if (dirInput && state.projectsRoot) {
    dirInput.placeholder = `Để trống = thư mục mới riêng trong ${state.projectsRoot}`;
  } else if (dirInput && !dirInput.value && !dirInput.dataset.filled && data.settings?.defaultProjectDir) {
    dirInput.value = data.settings.defaultProjectDir;
    dirInput.dataset.filled = "1";
  }
  state.engines = data.engines;
  state.telemetry = data.telemetry;
  state.insights = data.insights;
  state.control = data.control;
  state.rebalance = data.rebalance;
  renderTelemetry();
  renderCompanyDirectives();
  renderOrg();
  renderPlanPanel();
  renderFlowPanel();
  renderRebalance();
  renderApproveAll();
  renderReviewBadges();
  renderFocusChip();
  renderInbox();
  if (state.view === "flow") renderFlowView();
}

async function loadStatus() {
  applyStatus(await fetch("/api/status").then((r) => r.json()));
}

const rerenderFlow = debounce(() => state.view === "flow" && renderFlowView(), 300);

function connect() {
  const es = new EventSource("/api/events");
  const conn = $("#conn");
  es.addEventListener("open", () => {
    conn.textContent = "● trực tiếp";
    conn.className = "conn ok";
    loadStatus(); // resync anything missed while disconnected
  });
  es.addEventListener("error", () => {
    conn.textContent = "● mất kết nối — đang thử lại";
    conn.className = "conn bad";
  });
  es.addEventListener("slot", (e) => {
    const slot = JSON.parse(e.data);
    if (!slot) return;
    state.slots.set(slot.id, slot);
    updateCard(slot);
    refreshTeamOf(slot.id);
    renderApproveAll();
    renderReviewBadges();
    if (state.inbox.open) renderInbox();
    scheduleEdges();
    rerenderFlow();
    refreshTimeline();
    refreshArtifacts();
    const dt = state.drawer.taskId && slot.tasks.find((t) => t.id === state.drawer.taskId);
    if (dt && drawerSig(dt) !== state.drawer.sig) refreshDrawer();
  });
  es.addEventListener("plan", (e) => {
    state.plan = JSON.parse(e.data);
    renderPlanPanel();
    renderComposer();
    renderDoneBanner();
    renderReviewBadges();
    if (state.inbox.open) renderInbox();
    const boss = [...state.slots.values()].find((s) => s.isBoss);
    if (boss) updateCard(boss);
    rerenderFlow();
  });
  es.addEventListener("engines", (e) => {
    state.engines = JSON.parse(e.data);
    renderTelemetry();
    if (state.engineModal && !$("#modal").hidden) renderEngineModal();
  });
  es.addEventListener("telemetry", (e) => {
    state.telemetry = JSON.parse(e.data);
    renderTelemetry();
  });
  es.addEventListener("insights", (e) => {
    state.insights = JSON.parse(e.data);
    renderFlowPanel();
  });
  es.addEventListener("rebalance", (e) => {
    const next = JSON.parse(e.data);
    const was = state.rebalance?.status;
    state.rebalance = next;
    renderRebalance();
    renderReviewBadges();
    if (state.inbox.open) renderInbox();
    if (was === "drafting" && next?.status === "ready") {
      toast(next.moves.length ? `Sếp đề xuất ${next.moves.length} thay đổi — chọn và bấm Áp dụng.` : "Sếp thấy phân bổ hiện tại ổn.");
    }
  });
  es.addEventListener("control", (e) => {
    state.control = JSON.parse(e.data);
    renderTelemetry();
    renderCompanyDirectives();
  });
  es.addEventListener("lessons", (e) => {
    state.lessons = JSON.parse(e.data) ?? { pending: {}, accepted: {} };
    renderLessonBadges();
    for (const slot of state.slots.values()) updateCard(slot);
    if (state.role.slotId) loadRole(state.role.slotId);
    if (state.view === "roles") loadScoreboard();
  });
  es.addEventListener("contentseo", (e) => {
    state.seo = JSON.parse(e.data);
    if (state.view === "seo") renderSeo();
  });
  es.addEventListener("live", (e) => {
    const { id, stage, start, text } = JSON.parse(e.data);
    const next = appendLive(id, stage, start, text);
    for (const el of document.querySelectorAll(`pre.live[data-live="${CSS.escape(id)}"]`)) {
      el.textContent = next;
      el.scrollTop = el.scrollHeight;
    }
  });
}

setInterval(() => {
  for (const el of document.querySelectorAll(".elapsed[data-since]")) el.textContent = elapsed(el.dataset.since);
  const clock = $(".run-clock");
  if (clock && !clock.dataset.end) clock.textContent = fmtDur(Date.now() - new Date(clock.dataset.start).getTime());
}, 1000);
setInterval(() => state.view === "timeline" && renderTimeline(), 5000);
window.addEventListener("resize", scheduleEdges);
new ResizeObserver(scheduleEdges).observe($("#org"));
renderSideTabs();
applyOrgDensity();

loadStatus().then(connect);
