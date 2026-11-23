/* AI Agent Company dashboard — one page, patched in place from Server-Sent Events. */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const goalInput = $("#goal-input");
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
  const engines = state.engines
    ? Object.entries(state.engines)
        .map(([name, s]) => `<span class="engine ${s.running >= s.limit ? "busy" : ""}" title="${esc(ENGINE_LABEL[name])}: ${s.running}/${s.limit} đang chạy${s.waiting ? `, ${s.waiting} đang chờ lượt` : ""}"><b>${ENGINE_LABEL[name] ?? name}</b> ${s.running}/${s.limit}${s.waiting ? ` · chờ ${s.waiting}` : ""}</span>`)
        .join("")
    : "";
  el.innerHTML = `
    <div class="tm-progress" title="% hoàn thành toàn công ty (theo bước của từng task)">
      <div class="tm-pct">${t.percent}%</div>
      <div class="tm-bar"><div class="tm-fill" style="width:${t.percent}%"></div></div>
    </div>
    <div class="tm-counts">
      <span class="tm q-running">▶ <b>${t.counts.running}</b> chạy</span>
      <span class="tm q-queued">⏸ <b>${t.counts.queued}</b> chờ</span>
      <span class="tm q-waiting_you">✋ <b>${t.counts.waitingYou}</b> chờ duyệt</span>
      <span class="tm q-error">⚠ <b>${t.counts.errors}</b> lỗi/chặn</span>
      <span class="tm q-done">✓ <b>${t.counts.done}</b>/${t.counts.total} xong</span>
    </div>
    <div class="tm-usage">
      ${runClock}
      <span class="tm" title="${esc(engineTip)}"><b>${fmtTok(t.tokens.input + t.tokens.output)}</b> token${t.tokensEstimated ? "*" : ""}</span>
      <span class="tm" title="Claude CLI tự báo chi phí (theo giá API — gói Pro/Max không tính thêm). Gemini/Claude API chỉ tính nếu đặt giá trong .env. Muse không có số liệu."><b>${fmtCost(t.costUsd)}</b>${t.costPartial ? " ước tính" : ""}</span>
      ${t.paused ? `<span class="tm paused-pill">⏸ Đang tạm dừng</span>` : ""}
    </div>
    <div class="engines">${engines}</div>`;
  const pauseBtn = $("#pause-btn");
  pauseBtn.textContent = state.control.paused ? "▶ Resume" : "⏸ Pause";
  pauseBtn.classList.toggle("btn-resume", state.control.paused);
}

function renderCompanyDirectives() {
  $("#company-directives").innerHTML = (state.control.directives || [])
    .map((d) => `<span class="directive" title="${esc(fmtTime(d.at))}">📌 ${esc(d.text)} <button class="x" data-action="directive-remove" data-id="${esc(d.id)}" title="Gỡ chỉ thị">×</button></span>`)
    .join("");
}

function renderApproveAll() {
  const n = [...state.slots.values()].reduce((sum, s) => sum + s.counts.waitingYou, 0);
  const btn = $("#approve-all-btn");
  btn.hidden = n < 2;
  btn.textContent = `✓ Duyệt tất cả (${n})`;
  btn.dataset.count = String(n);
}

// ---------- cards ----------
const STATE_ICON = { running: "▶", needs_review: "✋", blocked: "⛔", waiting_input: "⏳", ready: "●", paused: "⏸", done: "✓", idle: "○" };

function cardSkeleton(slot) {
  return `
    <div class="card${slot.isBoss ? " card-boss" : ""}" data-slot="${slot.id}">
      <div class="card-header">
        <span class="card-icon">${slot.icon}</span>
        <span class="card-name" title="${esc(slot.name)}">${slot.id} · ${esc(slot.name.replace(/^AI /, ""))}</span>
        <span class="card-tools" data-part="tools"></span>
      </div>
      <div data-part="state"></div>
      <div data-part="links"></div>
      <div class="card-body" data-part="body"></div>
      <div data-part="actions"></div>
      <div class="queue" data-part="queue"></div>
      <div data-part="directives"></div>
      <div class="card-footer">
        <button class="btn btn-small" data-action="run" data-slot="${slot.id}">Chạy riêng khung này</button>
        <button class="btn btn-icon" data-action="steer-open" data-slot="${slot.id}" title="Gửi chỉ thị riêng cho ${slot.id}">✎ Chỉ thị</button>
      </div>
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
  const remaining = slot.queueRemaining ? `<span class="muted"> · còn ${slot.queueRemaining} trong hàng đợi</span>` : "";
  return `
    <div class="current" data-action="open-drawer" data-task="${esc(t.id)}" title="Bấm để xem đầy đủ output, prompt, artifact và lịch sử">
      <div class="current-label">Task hiện tại${remaining}</div>
      <div class="task-title">${esc(t.title)}</div>
      <div class="badges">
        <span class="badge ${t.colorClass}">${esc(t.label)}</span>
        <span class="qstate q-${t.queueState}">${QUEUE_LABEL[t.queueState]}</span>
        ${t.handedOff ? `<span class="qstate q-done" title="Kết quả đã bàn giao cho task phụ thuộc">↪ đã bàn giao</span>` : ""}
        ${t.redoPending ? `<span class="qstate q-waiting_you" title="Sẽ quay lại architecture khi bước hiện tại xong">↻ chờ làm lại</span>` : ""}
        <span class="stage-raw">${esc(t.stage)}</span>
      </div>
      <div class="progress-track"><div class="progress-fill ${t.colorClass}" style="width:${t.progress}%"></div></div>
    </div>
    ${activityLine(t)}
    ${metricsLine(t)}
    ${t.queueState === "running" ? `<pre class="live" data-live="${esc(t.id)}">${esc(live || "…")}</pre>` : ""}
    ${ac}
    <div class="logs">${logs}</div>
    ${t.lastError ? `<div class="feedback-box is-error">⚠ ${esc(t.lastError)}</div>` : ""}
    ${!t.waitingForYou && t.lastFeedback ? details(`fb:${t.id}`, "Phản hồi gần nhất", `<div class="feedback-box">${esc(t.lastFeedback)}</div>`) : ""}`;
}

function taskActions(t) {
  if (!t) return "";
  if (t.waitingForYou) {
    const box = t.checkpointBrief || t.lastFeedback;
    const final = t.stage === "checkpoint_final";
    return `
      ${box ? `<div class="checkpoint-box">${esc(box)}</div>` : ""}
      ${final && t.gated ? `<div class="gate-note">🔒 Cổng duyệt: kết quả chỉ bàn giao cho bước sau khi bạn duyệt.</div>` : ""}
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
  card.dataset.state = st.kind;
  card.querySelector('[data-part="tools"]').innerHTML = `
    ${slot.isBoss ? `<span class="gate on" title="Kế hoạch của Sếp luôn chờ bạn duyệt">🔒</span>` : `<button class="gate ${slot.gated ? "on" : ""}" data-action="gate" data-slot="${slot.id}" data-enabled="${slot.gated ? "0" : "1"}" title="${slot.gated ? "Cổng duyệt đang BẬT: kết quả chỉ bàn giao sau khi bạn duyệt. Bấm để tắt." : "Cổng duyệt đang tắt: bàn giao ngay khi Claude đã duyệt. Bấm để bật."}">${slot.gated ? "🔒" : "🔓"}</button>`}
    <span class="parallel" title="Số task đang chạy / tối đa">${slot.counts.running}/${slot.parallel}</span>`;
  card.querySelector('[data-part="state"]').innerHTML = `
    <div class="state-row"><span class="state-pill s-${st.kind}">${STATE_ICON[st.kind] ?? ""} ${esc(st.label)}</span>${st.detail ? `<span class="state-detail" title="${esc(st.detail)}">${esc(st.detail)}</span>` : ""}</div>`;
  card.querySelector('[data-part="links"]').innerHTML = slotLinks(slot, t);
  card.querySelector('[data-part="body"]').innerHTML = taskBody(slot, t);
  const actions = card.querySelector('[data-part="actions"]');
  const sig = t ? `${t.id}|${t.queueState}|${t.stage}|${t.checkpointBrief ? 1 : 0}|${t.gated}` : "";
  if (actions.dataset.sig !== sig) {
    actions.dataset.sig = sig;
    actions.innerHTML = taskActions(t);
  }
  card.querySelector('[data-part="queue"]').innerHTML = queueList(slot, t);
  card.querySelector('[data-part="directives"]').innerHTML = slot.directives.length
    ? `<div class="directive-chips">${slot.directives.map((d) => `<span class="directive">📌 ${esc(d.text)} <button class="x" data-action="directive-remove" data-id="${esc(d.id)}">×</button></span>`).join("")}</div>`
    : "";
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

function renderOrg() {
  const slots = [...state.slots.values()];
  const rows = { 1: $("#row-1"), 2: $("#row-2"), 3: $("#row-3") };
  for (const tier of [1, 2, 3]) {
    $$(".card", rows[tier]).forEach((c) => c.remove());
    const html = slots.filter((s) => s.tier === tier).map(cardSkeleton).join("");
    const side = rows[tier].querySelector(".side-panel");
    if (side) side.insertAdjacentHTML("beforebegin", html);
    else rows[tier].insertAdjacentHTML("beforeend", html);
  }
  for (const slot of slots) updateCard(slot);
  scheduleEdges();
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
              ${details(`srat:${plan.id}:${s.id}`, "Vì sao giao cho người này?", `${s.rationale ? `<div class="why">💡 ${esc(s.rationale)}</div>` : `<div class="muted">Sếp không nêu lý do.</div>`}${s.inputs ? `<div class="why">📥 Dựa trên: ${esc(s.inputs)}</div>` : ""}<div class="epic-goal">${esc(s.description)}</div><ul class="ac">${s.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`)}
            </div>`,
            )
            .join("")}
        </div>`,
      )
      .join("")}</div>`;
  }
  const sig = `${plan.id}|${plan.status}`;
  const prev = panel.querySelector('[data-part="plan-actions"]');
  const keep = prev && prev.dataset.sig === sig ? prev : null;
  panel.innerHTML = `
    <div class="panel-title">Mục tiêu & cây phân việc <span class="plan-status s-${plan.status}">${esc(PLAN_STATUS[plan.status] ?? plan.status)}</span></div>
    <div class="plan-goal">${esc(plan.goal)}</div>
    ${plan.summary ? `<div class="plan-summary">${esc(plan.summary)}</div>` : ""}
    ${plan.reviewRounds ? `<div class="muted small">${plan.reviewRounds} vòng Claude ↔ Gemini${plan.usage ? ` · ${fmtTok(plan.usage.input + plan.usage.output)} tok${plan.usage.costUsd ? ` · ${fmtCost(plan.usage.costUsd)}` : ""}` : ""}</div>` : ""}
    ${body}
    <div data-part="plan-actions"></div>`;
  const actions = panel.querySelector('[data-part="plan-actions"]');
  if (keep) actions.replaceWith(keep);
  else {
    actions.dataset.sig = sig;
    actions.innerHTML =
      plan.status === "awaiting_approval"
        ? `<input class="feedback-input" placeholder="Feedback nếu từ chối (Sếp sẽ lập lại theo ý này)" data-plan-feedback="${esc(plan.id)}" />
           <div class="decision-row"><button class="btn btn-approve" data-action="plan-approve" data-plan="${esc(plan.id)}">Duyệt kế hoạch — giao việc</button><button class="btn btn-reject" data-action="plan-reject" data-plan="${esc(plan.id)}">Từ chối & lập lại</button></div>`
        : "";
  }
  const liveEl = panel.querySelector("pre.live");
  if (liveEl) liveEl.scrollTop = liveEl.scrollHeight;
}

function renderFlowPanel() {
  const ins = state.insights;
  const panel = $("#flow-panel");
  if (!ins) return;
  const alerts = ins.alerts.length
    ? ins.alerts.map((a) => `<li class="alert ${a.level}">${a.level === "error" ? "⛔" : a.level === "warn" ? "⚠" : "ℹ"} ${esc(a.text)}</li>`).join("")
    : `<li class="muted">Không có điểm nghẽn.</li>`;
  const handoffs = ins.handoffs.length
    ? ins.handoffs
        .map((h) => `<li><span class="flow-edge"><b data-hover-slot="${h.from}">${h.from}</b> → ${h.to.length ? h.to.map((s) => `<b data-hover-slot="${s}">${s}</b>`).join(", ") : "<i>(không ai phụ thuộc)</i>"}</span> <span class="muted">${esc(fmtTime(h.at))}</span><div class="flow-title">${esc(h.title)}</div></li>`)
        .join("")
    : `<li class="muted">Chưa có bàn giao nào.</li>`;
  const waits = ins.waits.length
    ? ins.waits.map((w) => `<li><b data-hover-slot="${w.slotId}">${w.slotId}</b> chờ ${w.waitingOn.map((s) => `<b data-hover-slot="${s}">${s}</b>`).join(", ")} · ${fmtDur(w.sinceMs)}<div class="flow-title">${esc(w.title)}</div></li>`).join("")
    : `<li class="muted">Không ai đang chờ đầu vào.</li>`;
  panel.innerHTML = `
    <div class="panel-title">Luồng bàn giao & điểm nghẽn</div>
    <div class="panel-sub">Cảnh báo</div><ul class="flow-list">${alerts}</ul>
    <div class="panel-sub">Bàn giao gần đây</div><ul class="flow-list">${handoffs}</ul>
    <div class="panel-sub">Đang chờ đầu vào</div><ul class="flow-list">${waits}</ul>`;
}

// ---------- edges (dependency / handoff arrows) ----------
function slotEdges() {
  const edges = [];
  for (const slot of state.slots.values()) {
    const seen = new Map();
    for (const t of slot.tasks) {
      for (const i of t.inputsFrom) {
        if (i.slotId === slot.id) continue;
        const prev = seen.get(i.slotId);
        seen.set(i.slotId, { from: i.slotId, to: slot.id, kind: prev?.kind === "pending" || !i.handedOff ? "pending" : "done" });
      }
    }
    edges.push(...seen.values());
    if (slot.tasks.some((t) => t.assignedBy?.startsWith("AG-01")) && !slot.isBoss) edges.push({ from: "AG-01", to: slot.id, kind: "assign" });
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
  $$("path.edge, text.edge-label", svg).forEach((p) => p.remove());
  $$(".card.related-in, .card.related-out, .card.related-self", org).forEach((c) => c.classList.remove("related-in", "related-out", "related-self"));
  org.classList.toggle("focusing", Boolean(state.hoverSlot));

  const focus = state.hoverSlot;
  const all = slotEdges();
  const shown = all.filter((e) => (focus ? e.from === focus || e.to === focus : state.showAllEdges && e.kind !== "assign"));
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
    path.setAttribute("class", `edge e-${e.kind}`);
    path.setAttribute("marker-end", `url(#arrow-${e.kind})`);
    svg.appendChild(path);
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
  for (const slot of state.slots.values()) {
    if (!matchesFilter(slot)) continue;
    for (const t of slot.tasks) {
      const phase = STAGE_PHASE[t.stage] ?? "Phân tích";
      const waiting = t.queueState === "queued" || t.queueState === "waiting_deps" || t.activity?.state === "waiting";
      if (waiting) waitingIn[phase]++;
      cols[phase].push(`
        <div class="flow-card ${PHASE_CLASS[phase] ?? ""}${t.queueState === "running" ? " is-running" : ""}" data-action="open-drawer" data-task="${esc(t.id)}">
          <div class="fc-top"><span class="owner" data-hover-slot="${slot.id}">${slot.id}</span> <span class="qstate q-${t.queueState}">${QUEUE_LABEL[t.queueState]}</span>${t.activity ? ` <span class="muted small">${ENGINE_LABEL[t.activity.engine]} ${t.activity.state === "waiting" ? "chờ" : ""}</span>` : ""}</div>
          <div class="fc-title">${esc(t.title)}</div>
          <div class="fc-meta"><span class="stage-raw">${esc(t.stage)}</span>${t.queueState === "running" && t.stageStartedAt ? ` · ⏱ <span class="elapsed" data-since="${esc(t.stageStartedAt)}">${elapsed(t.stageStartedAt)}</span>` : ""}${t.deps.total ? ` · phụ thuộc ${t.deps.ready}/${t.deps.total}` : ""}</div>
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

function renderTimeline() {
  const el = $("#view-timeline");
  const tl = state.timeline;
  if (!tl || !tl.start) {
    el.innerHTML = `<div class="view-intro">Chưa có lượt chạy nào để vẽ timeline.</div>`;
    return;
  }
  const t0 = new Date(tl.start).getTime();
  const t1 = Math.max(Date.now(), new Date(tl.now).getTime(), t0 + 15000);
  const span = t1 - t0;
  const pct = (iso) => (((iso ? new Date(iso).getTime() : Date.now()) - t0) / span) * 100;
  const ticks = [];
  const step = niceStep(span / 8);
  for (let x = Math.ceil(t0 / step) * step; x <= t1; x += step) ticks.push(x);

  const rows = tl.rows
    .map((r) => {
      const last = r.spans.at(-1);
      const idleMs = last ? (last.endedAt ? Date.now() - new Date(last.endedAt).getTime() : 0) : Date.now() - t0;
      const bars = r.spans
        .map((s) => {
          const left = pct(s.startedAt);
          const width = Math.max(0.4, pct(s.endedAt) - left);
          const dur = (s.endedAt ? new Date(s.endedAt).getTime() : Date.now()) - new Date(s.startedAt).getTime();
          const waitPct = dur > 0 ? Math.min(100, (s.waitMs / dur) * 100) : 0;
          const phase = STAGE_PHASE[s.stage] ?? "Phân tích";
          const cls = [PHASE_CLASS[phase], s.critical ? "critical" : "", s.outcome === "error" ? "err" : "", s.outcome === "cancelled" ? "cancelled" : "", !s.endedAt ? "live-bar" : ""].join(" ");
          return `<div class="bar ${cls}" style="left:${left}%;width:${width}%" data-action="open-drawer" data-task="${esc(s.taskId)}" title="${esc(`${s.title}\n${s.stage} · ${fmtDur(dur)}${s.waitMs > 1000 ? ` (chờ engine ${fmtDur(s.waitMs)})` : ""} · ${fmtTok(s.tokens)} tok${s.outcome && s.outcome !== "ok" ? ` · ${s.outcome}` : ""}${s.critical ? "\n★ nằm trên critical path" : ""}`)}">${waitPct > 3 ? `<span class="wait" style="width:${waitPct}%"></span>` : ""}</div>`;
        })
        .join("");
      return `<div class="g-row"><div class="g-label" data-hover-slot="${r.slotId}"><b>${r.slotId}</b> ${esc(r.name.replace(/^AI /, ""))}${idleMs > 5 * 60000 && r.spans.length ? `<span class="idle" title="Không chạy gì từ ${fmtDur(idleMs)}">💤 ${fmtDur(idleMs)}</span>` : ""}</div><div class="g-track">${bars}</div></div>`;
    })
    .join("");
  const cp = tl.criticalPath;
  el.innerHTML = `
    <div class="view-intro">
      Mỗi hàng là một nhân sự, mỗi thanh là một lượt chạy (màu theo khâu; phần sọc là thời gian <b>chờ engine</b>). Các thanh chồng nhau theo cột dọc = chạy song song.
      ${cp ? `<div class="critical">★ Critical path (${fmtDur(cp.totalMs)}): ${cp.tasks.map((t) => `<span class="owner" data-hover-slot="${esc(t.slotId)}">${esc(t.slotId)}</span> ${esc(t.title)}`).join(" → ")}</div>` : ""}
    </div>
    <div class="legend">${Object.entries(PHASE_CLASS).map(([p, c]) => `<span><i class="sw ${c}"></i>${p}</span>`).join("")}<span><i class="sw critical-sw"></i>Critical path</span><span><i class="sw wait-sw"></i>Chờ engine</span></div>
    <div class="gantt">
      <div class="g-row g-axis"><div class="g-label"></div><div class="g-track">${ticks.map((x) => `<span class="tick" style="left:${((x - t0) / span) * 100}%">${new Date(x).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: span < 10 * 60000 ? "2-digit" : undefined })}</span>`).join("")}<span class="now-line" style="left:${((Date.now() - t0) / span) * 100}%"></span></div></div>
      ${rows}
    </div>`;
}
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
        <div class="drawer-title">${esc(task.context.title)}</div>
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
        <textarea data-keep="decision-fb" data-feedback-for="${esc(task.id)}" rows="2" placeholder="Yêu cầu sửa / lý do từ chối (tuỳ chọn)"></textarea>
        <div class="decision-row"><button class="btn btn-approve" data-action="approve" data-task="${esc(task.id)}">Duyệt</button>${task.stage === "checkpoint_final" ? `<button class="btn btn-revise" data-action="revise" data-task="${esc(task.id)}">Yêu cầu sửa</button>` : ""}<button class="btn btn-reject" data-action="reject" data-task="${esc(task.id)}">Từ chối</button></div></div>`
    : "";
  const trace = (task.trace ?? []).slice().reverse();
  return `
    ${decision}
    ${s.lastError ? `<div class="feedback-box is-error">⚠ ${esc(s.lastError)}</div><button class="btn btn-small btn-retry" data-action="retry" data-task="${esc(task.id)}">↻ Thử lại</button>` : ""}
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
    case "filter":
      state.filter = ds.filter;
      $$(".filter[data-filter]").forEach((b) => b.classList.toggle("active", b.dataset.filter === ds.filter));
      for (const slot of state.slots.values()) applyFilter($(`#org .card[data-slot="${slot.id}"]`), slot);
      if (state.view === "flow") renderFlowView();
      return;
    case "toggle-edges":
      state.showAllEdges = !state.showAllEdges;
      btn.classList.toggle("active", state.showAllEdges);
      return drawEdges();
    case "steer-open":
      return steerModal(ds.slot);
    case "artifact-send-open":
      return sendModal(ds);
    case "artifact-preview":
      return previewArtifact(ds.id);
    case "modal-close":
      return closeModal();
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
      if (await post(`/api/tasks/${encodeURIComponent(ds.task)}/decision`, { action, feedback: fb })) refreshDrawer();
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
      const fb = document.querySelector(`[data-plan-feedback="${CSS.escape(ds.plan)}"]`)?.value ?? "";
      await post(`/api/plan/${encodeURIComponent(ds.plan)}/decision`, { approved: action === "plan-approve", feedback: fb });
    }
    if (action === "plan-retry") await post(`/api/plan/${encodeURIComponent(ds.plan)}/retry`);
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
  else if (!$("#drawer").hidden) closeDrawer();
});
$("#drawer-backdrop").addEventListener("click", closeDrawer);
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
  if (await post("/api/run-all", { goal })) toast("Đã giao mục tiêu cho Sếp — đang lập cây công việc.");
});
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
  for (const v of ["org", "flow", "timeline", "artifacts"]) $(`#view-${v}`).hidden = v !== view;
  $("#filters").classList.toggle("hidden-filters", view === "timeline" || view === "artifacts");
  if (view === "org") scheduleEdges();
  if (view === "flow") renderFlowView();
  if (view === "timeline") loadTimeline();
  if (view === "artifacts") loadArtifacts();
}

// ---------- data ----------
function applyStatus(data) {
  state.slots = new Map(data.slots.map((s) => [s.id, s]));
  state.plan = data.plan;
  state.engines = data.engines;
  state.telemetry = data.telemetry;
  state.insights = data.insights;
  state.control = data.control;
  renderTelemetry();
  renderCompanyDirectives();
  renderOrg();
  renderPlanPanel();
  renderFlowPanel();
  renderApproveAll();
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
    renderApproveAll();
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
    const boss = [...state.slots.values()].find((s) => s.isBoss);
    if (boss) updateCard(boss);
    rerenderFlow();
  });
  es.addEventListener("engines", (e) => {
    state.engines = JSON.parse(e.data);
    renderTelemetry();
  });
  es.addEventListener("telemetry", (e) => {
    state.telemetry = JSON.parse(e.data);
    renderTelemetry();
  });
  es.addEventListener("insights", (e) => {
    state.insights = JSON.parse(e.data);
    renderFlowPanel();
  });
  es.addEventListener("control", (e) => {
    state.control = JSON.parse(e.data);
    renderTelemetry();
    renderCompanyDirectives();
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

loadStatus().then(connect);
