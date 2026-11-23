const grid = document.getElementById("grid");
const goalInput = document.getElementById("goal-input");
const planPanel = document.getElementById("plan-panel");
const enginesEl = document.getElementById("engines");
const connEl = document.getElementById("conn");
const toastEl = document.getElementById("toast");

const TIER_ORDER = [1, 2, 3];
const LIVE_CHARS = 1500;

const QUEUE_LABEL = {
  running: "Đang chạy",
  waiting_you: "Chờ bạn duyệt",
  error: "Lỗi — tạm dừng",
  rejected: "Bị từ chối",
  blocked: "Bị chặn",
  waiting_deps: "Chờ phụ thuộc",
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

const state = {
  slots: new Map(),
  plan: null,
  engines: null,
  /** slotId -> taskId the user clicked on in that card's queue */
  selected: new Map(),
  /** taskId|plan:<id> -> streamed text for its current stage */
  live: new Map(),
  /** taskId|plan:<id> -> the stage (or plan phase) that text belongs to */
  liveStage: new Map(),
  /** taskId|plan:<id> -> how many characters of that stage's output the text already covers */
  liveTotal: new Map(),
  /** ids of <details> the user opened, so re-renders keep them open */
  open: new Set(),
};

// ---------- utils ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function elapsed(sinceIso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(sinceIso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), 5000);
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    toast(data.error || `Lỗi ${res.status}`);
    return false;
  }
  return true;
}

function details(id, summary, inner) {
  return `<details data-open-id="${esc(id)}"${state.open.has(id) ? " open" : ""}><summary>${summary}</summary>${inner}</details>`;
}

// ---------- approve all ----------
const approveAllBtn = document.getElementById("approve-all-btn");
function renderApproveAll() {
  const n = [...state.slots.values()].reduce((sum, s) => sum + s.counts.waitingYou, 0);
  approveAllBtn.hidden = n < 2;
  approveAllBtn.textContent = `✓ Duyệt tất cả đang chờ (${n})`;
  approveAllBtn.dataset.count = String(n);
}
approveAllBtn.addEventListener("click", async () => {
  const n = approveAllBtn.dataset.count;
  if (!confirm(`Duyệt cùng lúc ${n} task đang chờ bạn? Task ở checkpoint cuối sẽ được ship (done). Hãy chắc là bạn đã xem kết quả của chúng.`)) return;
  approveAllBtn.disabled = true;
  try {
    await post("/api/approve-all");
  } finally {
    approveAllBtn.disabled = false;
  }
});

// ---------- engines ----------
function renderEngines() {
  const e = state.engines;
  if (!e) return;
  enginesEl.innerHTML = Object.entries(e)
    .map(([name, s]) => {
      const busy = s.running >= s.limit;
      return `<span class="engine ${busy ? "busy" : ""}"><b>${ENGINE_LABEL[name] ?? name}</b> ${s.running}/${s.limit}${s.waiting ? ` · chờ ${s.waiting}` : ""}</span>`;
    })
    .join("");
}

// ---------- cards ----------
function cardSkeleton(slot) {
  return `
    <div class="card${slot.isBoss ? " card-boss" : ""}" data-slot="${slot.id}">
      <div class="card-header"><span class="card-icon">${slot.icon}</span><span>${slot.id}: ${esc(slot.name)}</span><span class="parallel" data-part="parallel"></span></div>
      <div class="slot-counts" data-part="counts"></div>
      <div class="card-body" data-part="body"></div>
      <div data-part="actions"></div>
      <div class="queue" data-part="queue"></div>
      <button class="btn btn-small" data-action="run" data-slot="${slot.id}">Chạy riêng khung này</button>
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

/** Text for a live box: what streamed in for this stage, seeded from the server's tail when we joined mid-stage. */
function liveText(id, stage, serverTail, serverTotal) {
  if (state.liveStage.get(id) !== stage) {
    state.live.set(id, serverTail || "");
    state.liveStage.set(id, stage);
    state.liveTotal.set(id, serverTotal || 0);
  }
  return state.live.get(id);
}

/** Appends a streamed chunk, skipping any part this page already has (e.g. from a snapshot taken while it was buffered). */
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

function taskBody(t) {
  if (!t) return `<div class="task-title muted">Chưa gán task.</div>`;
  const live = liveText(t.id, t.stage, t.liveTail, t.liveTotal);
  const deps = t.deps.total
    ? `<div class="deps">Phụ thuộc: ${t.deps.ready}/${t.deps.total} đã bàn giao${t.deps.blockedBy ? ` — <span class="bad">${esc(t.deps.blockedBy)}</span>` : t.deps.waitingOn.length ? ` — chờ ${esc(t.deps.waitingOn.join(", "))}` : ""}</div>`
    : "";
  const ac = t.acceptanceCriteria.length
    ? details(`ac:${t.id}`, `Tiêu chí nghiệm thu (${t.acceptanceCriteria.length})`, `<ul class="ac">${t.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`)
    : "";
  const logs = t.logs.length ? t.logs.map((l) => `<div class="log-line" title="${esc(l.text)}">${esc(l.at)}: ${esc(l.text)}</div>`).join("") : `<div class="log-line">Chưa có hoạt động.</div>`;
  return `
    <div class="badges"><span class="badge ${t.colorClass}">${esc(t.label)}</span><span class="qstate q-${t.queueState}">${QUEUE_LABEL[t.queueState]}</span>${t.handedOff ? `<span class="qstate q-done" title="Kết quả đã bàn giao cho task phụ thuộc">↪ bàn giao</span>` : ""}</div>
    <div class="stage-raw">${esc(t.stage)}</div>
    <div class="task-title" title="${esc(t.title)}">${esc(t.title)}</div>
    <div class="progress-track"><div class="progress-fill ${t.colorClass}" style="width:${t.progress}%"></div></div>
    ${activityLine(t)}
    ${deps}
    ${ac}
    ${t.queueState === "running" ? `<pre class="live" data-live="${esc(t.id)}">${esc(live || "…")}</pre>` : ""}
    <div class="logs">${logs}</div>
    ${t.lastError ? `<div class="feedback-box is-error">⚠ ${esc(t.lastError)}</div>` : ""}
    ${!t.waitingForYou && t.lastFeedback ? `<div class="feedback-box">${esc(t.lastFeedback)}</div>` : ""}`;
}

function taskActions(t) {
  if (!t) return "";
  if (t.waitingForYou) {
    const box = t.checkpointBrief || t.lastFeedback;
    return `
      ${box ? `<div class="checkpoint-box">${esc(box)}</div>` : ""}
      <input class="feedback-input" placeholder="Feedback nếu từ chối (tuỳ chọn)" data-feedback-for="${esc(t.id)}" />
      <div class="decision-row">
        <button class="btn btn-approve" data-action="approve" data-task="${esc(t.id)}">Duyệt</button>
        <button class="btn btn-reject" data-action="reject" data-task="${esc(t.id)}">Từ chối</button>
      </div>`;
  }
  if (t.queueState === "error" || t.queueState === "rejected") {
    return `<button class="btn btn-small btn-retry" data-action="retry" data-task="${esc(t.id)}">↻ Thử lại task này</button>`;
  }
  return "";
}

function queueList(slot, current) {
  if (slot.tasks.length <= 1) return "";
  return slot.tasks
    .map(
      (t) => `<button class="queue-row${current && t.id === current.id ? " selected" : ""}" data-action="select" data-slot="${slot.id}" data-task="${esc(t.id)}" title="${esc(t.title)}">
        <span class="qdot q-${t.queueState}"></span><span class="queue-title">${esc(t.title)}</span><span class="queue-stage">${esc(QUEUE_LABEL[t.queueState])}</span>
      </button>`,
    )
    .join("");
}

/** Patches one card in place. The actions part is only rebuilt when it actually changes, so text typed into a feedback box survives updates. */
function updateCard(slot) {
  const card = grid.querySelector(`[data-slot="${slot.id}"]`);
  if (!card) return;
  const t = selectedTask(slot);
  const c = slot.counts;
  card.querySelector('[data-part="parallel"]').textContent = `luồng ${c.running}/${slot.parallel}`;
  card.querySelector('[data-part="counts"]').innerHTML = [
    c.running && `<span class="q-running">▶ ${c.running} chạy</span>`,
    c.queued && `<span class="q-queued">⏸ ${c.queued} chờ</span>`,
    c.waitingYou && `<span class="q-waiting_you">✋ ${c.waitingYou} chờ duyệt</span>`,
    c.problems && `<span class="q-error">⚠ ${c.problems} lỗi</span>`,
    c.done && `<span class="q-done">✓ ${c.done} xong</span>`,
  ]
    .filter(Boolean)
    .join("");
  card.querySelector('[data-part="body"]').innerHTML =
    !t && slot.isBoss && state.plan
      ? `<div class="activity running">📋 Kế hoạch: ${esc(PLAN_STATUS[state.plan.status] ?? state.plan.status)}</div><div class="task-title" title="${esc(state.plan.goal)}">${esc(state.plan.goal)}</div>`
      : taskBody(t);
  const actions = card.querySelector('[data-part="actions"]');
  const sig = t ? `${t.id}|${t.queueState}|${t.stage}|${t.checkpointBrief ? 1 : 0}` : "";
  if (actions.dataset.sig !== sig) {
    actions.dataset.sig = sig;
    actions.innerHTML = taskActions(t);
  }
  card.querySelector('[data-part="queue"]').innerHTML = queueList(slot, t);
  const liveEl = card.querySelector("pre.live");
  if (liveEl) liveEl.scrollTop = liveEl.scrollHeight;
}

function renderGrid() {
  const slots = [...state.slots.values()];
  grid.innerHTML = TIER_ORDER.map((tier) => {
    const inTier = slots.filter((s) => s.tier === tier);
    if (!inTier.length) return "";
    return `<section class="tier-section"><h2 class="tier-heading tier-heading-${tier}">${esc(inTier[0].tierLabel)}</h2><div class="tier-grid">${inTier.map(cardSkeleton).join("")}</div></section>`;
  }).join("");
  for (const slot of slots) updateCard(slot);
  renderApproveAll();
}

// ---------- plan ----------
function ownerName(id) {
  const s = state.slots.get(id);
  return s ? `${id} ${s.name.replace(/^AI /, "")}` : id;
}

function stageChip(plan, taskId) {
  if (!taskId) return "";
  const stage = plan.taskStages?.[taskId];
  return stage ? `<span class="plan-stage">${esc(stage)}</span>` : "";
}

function renderPlan() {
  const plan = state.plan;
  if (!plan) {
    planPanel.hidden = true;
    planPanel.innerHTML = "";
    return;
  }
  planPanel.hidden = false;
  const key = `plan:${plan.id}`;
  const live = liveText(key, plan.phase ?? "", plan.liveTail, plan.liveTotal);
  const head = `
    <div class="plan-head">
      <div>
        <div class="plan-kicker">Cây công việc của Sếp · ${esc(PLAN_STATUS[plan.status] ?? plan.status)}${plan.reviewRounds ? ` · ${plan.reviewRounds} vòng Claude↔Gemini` : ""}</div>
        <div class="plan-goal">${esc(plan.goal)}</div>
        ${plan.summary ? `<div class="plan-summary">${esc(plan.summary)}</div>` : ""}
      </div>
      <div class="plan-status s-${plan.status}">${esc(PLAN_STATUS[plan.status] ?? plan.status)}</div>
    </div>`;

  let body = "";
  if (plan.status === "drafting") {
    body += `<div class="activity running">${plan.activity ? `⏱ <span class="elapsed" data-since="${esc(plan.activity.since)}">${elapsed(plan.activity.since)}</span> · ` : ""}${esc(plan.phase ?? "Đang khởi động…")}</div>`;
    body += `<pre class="live" data-live="${esc(key)}">${esc(live || "…")}</pre>`;
  }
  if (plan.status === "failed") {
    body += `<div class="feedback-box is-error">⚠ ${esc(plan.error)}</div><button class="btn btn-small btn-retry" data-action="plan-retry" data-plan="${esc(plan.id)}">↻ Lập lại kế hoạch</button>`;
  }
  if (plan.notes?.length) body += details(`notes:${plan.id}`, `Hệ thống đã tự chỉnh ${plan.notes.length} điểm`, `<ul class="ac">${plan.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`);
  if (plan.unresolvedReview && plan.status === "awaiting_approval") {
    body += `<div class="feedback-box"><b>Gemini vẫn còn ý kiến chưa được giải quyết:</b>\n${esc(plan.unresolvedReview)}</div>`;
  }
  if (plan.epics?.length) {
    body += `<div class="epics">${plan.epics
      .map(
        (e) => `
        <div class="epic">
          <div class="epic-head"><b>${esc(e.id)}</b> ${esc(e.title)} <span class="owner lead">${esc(ownerName(e.owner))}</span>${stageChip(plan, e.taskId)}</div>
          ${e.goal ? `<div class="epic-goal">${esc(e.goal)}</div>` : ""}
          ${details(`eac:${plan.id}:${e.id}`, `Tiêu chí nghiệm thu epic (${e.acceptanceCriteria.length})`, `<ul class="ac">${e.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`)}
          ${e.subtasks
            .map(
              (s) => `
            <div class="subtask">
              <div><b>${esc(s.id)}</b> ${esc(s.title)} <span class="owner">${esc(ownerName(s.owner))}</span>${stageChip(plan, s.taskId)}</div>
              ${s.dependsOn.length ? `<div class="deps">sau ${esc(s.dependsOn.join(", "))}</div>` : ""}
              ${details(`sac:${plan.id}:${s.id}`, `Tiêu chí (${s.acceptanceCriteria.length})`, `<div class="epic-goal">${esc(s.description)}</div><ul class="ac">${s.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`)}
            </div>`,
            )
            .join("")}
        </div>`,
      )
      .join("")}</div>`;
  }

  // Keep the decision area (and anything typed into it) unless the plan's state changed.
  const sig = `${plan.id}|${plan.status}`;
  let actions = planPanel.querySelector('[data-part="plan-actions"]');
  const keep = actions && actions.dataset.sig === sig ? actions : null;
  planPanel.innerHTML = head + body + `<div data-part="plan-actions"></div>`;
  actions = planPanel.querySelector('[data-part="plan-actions"]');
  if (keep) {
    actions.replaceWith(keep);
  } else {
    actions.dataset.sig = sig;
    actions.innerHTML =
      plan.status === "awaiting_approval"
        ? `<input class="feedback-input" placeholder="Feedback nếu từ chối kế hoạch (Sếp sẽ lập lại theo ý này)" data-plan-feedback="${esc(plan.id)}" />
           <div class="decision-row"><button class="btn btn-approve" data-action="plan-approve" data-plan="${esc(plan.id)}">Duyệt kế hoạch — giao việc</button><button class="btn btn-reject" data-action="plan-reject" data-plan="${esc(plan.id)}">Từ chối & lập lại</button></div>`
        : "";
  }
  const liveEl = planPanel.querySelector("pre.live");
  if (liveEl) liveEl.scrollTop = liveEl.scrollHeight;
}

// ---------- events ----------
document.addEventListener("toggle", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement) || !el.dataset.openId) return;
  if (el.open) state.open.add(el.dataset.openId);
  else state.open.delete(el.dataset.openId);
}, true);

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, slot, task, plan } = btn.dataset;
  if (action === "select") {
    state.selected.set(slot, task);
    updateCard(state.slots.get(slot));
    return;
  }
  btn.disabled = true;
  try {
    if (action === "run") await post(`/api/slots/${slot}/run`, { goal: goalInput.value.trim() });
    if (action === "approve" || action === "reject") {
      const fb = document.querySelector(`[data-feedback-for="${CSS.escape(task)}"]`)?.value ?? "";
      await post(`/api/tasks/${encodeURIComponent(task)}/decision`, { approved: action === "approve", feedback: fb });
    }
    if (action === "retry") await post(`/api/tasks/${encodeURIComponent(task)}/retry`);
    if (action === "plan-approve" || action === "plan-reject") {
      const fb = document.querySelector(`[data-plan-feedback="${CSS.escape(plan)}"]`)?.value ?? "";
      await post(`/api/plan/${encodeURIComponent(plan)}/decision`, { approved: action === "plan-approve", feedback: fb });
    }
    if (action === "plan-retry") await post(`/api/plan/${encodeURIComponent(plan)}/retry`);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("run-all-btn").addEventListener("click", async () => {
  const goal = goalInput.value.trim();
  if (!goal) return toast("Nhập mục tiêu chung cho cả công ty trước đã.");
  if (await post("/api/run-all", { goal })) toast("Đã giao mục tiêu cho Sếp — đang lập cây công việc.");
});

document.getElementById("reset-btn").addEventListener("click", async () => {
  if (!confirm("Reset sẽ bỏ gán toàn bộ task khỏi 10 khung và huỷ kế hoạch đang chờ (không xoá dữ liệu task). Task đang chạy dừng sau bước hiện tại. Tiếp tục?")) return;
  await post("/api/reset");
});

// ---------- data ----------
async function loadStatus() {
  const data = await fetch("/api/status").then((r) => r.json());
  state.slots = new Map(data.slots.map((s) => [s.id, s]));
  state.plan = data.plan;
  state.engines = data.engines;
  renderEngines();
  renderGrid();
  renderPlan();
}

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("open", () => {
    connEl.textContent = "● trực tiếp";
    connEl.className = "conn ok";
    loadStatus(); // resync anything missed while disconnected
  });
  es.addEventListener("error", () => {
    connEl.textContent = "● mất kết nối — đang thử lại";
    connEl.className = "conn bad";
  });
  es.addEventListener("slot", (e) => {
    const slot = JSON.parse(e.data);
    if (!slot) return;
    state.slots.set(slot.id, slot);
    updateCard(slot);
    renderApproveAll();
  });
  es.addEventListener("plan", (e) => {
    state.plan = JSON.parse(e.data);
    renderPlan();
    for (const s of state.slots.values()) if (s.isBoss) updateCard(s);
  });
  es.addEventListener("engines", (e) => {
    state.engines = JSON.parse(e.data);
    renderEngines();
  });
  es.addEventListener("live", (e) => {
    const { id, stage, start, text } = JSON.parse(e.data);
    const next = appendLive(id, stage, start, text);
    const el = document.querySelector(`pre.live[data-live="${CSS.escape(id)}"]`);
    if (el) {
      el.textContent = next;
      el.scrollTop = el.scrollHeight;
    }
  });
}

setInterval(() => {
  for (const el of document.querySelectorAll(".elapsed[data-since]")) el.textContent = elapsed(el.dataset.since);
}, 1000);

loadStatus().then(connect);
