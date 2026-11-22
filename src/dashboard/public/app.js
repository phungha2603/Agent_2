const grid = document.getElementById("grid");
const goalInput = document.getElementById("goal-input");

document.getElementById("run-all-btn").addEventListener("click", async () => {
  const goal = goalInput.value.trim();
  if (!goal) {
    alert("Nhập mục tiêu chung cho cả công ty trước đã.");
    return;
  }
  await fetch("/api/run-all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  refresh();
});

document.getElementById("reset-btn").addEventListener("click", async () => {
  if (!confirm("Reset sẽ bỏ gán task khỏi toàn bộ 10 khung (không xoá dữ liệu task cũ). Tiếp tục?")) return;
  await fetch("/api/reset", { method: "POST" });
  refresh();
});

async function runSlot(slotId) {
  const goal = goalInput.value.trim();
  await fetch(`/api/slots/${slotId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  refresh();
}

async function decide(slotId, approved, feedback) {
  await fetch(`/api/slots/${slotId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved, feedback }),
  });
  refresh();
}

function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderCard(slot) {
  const logsHtml = slot.logs.length
    ? slot.logs.map((l) => `<div class="log-line">${escapeHtml(l.at)}: ${escapeHtml(l.text)}</div>`).join("")
    : `<div class="log-line">Chưa có hoạt động.</div>`;

  let actionHtml;
  if (slot.waitingForYou) {
    const brief = slot.checkpointBrief
      ? `<div class="checkpoint-box">${escapeHtml(slot.checkpointBrief).slice(0, 600)}</div>`
      : slot.lastFeedback
        ? `<div class="checkpoint-box">${escapeHtml(slot.lastFeedback).slice(0, 600)}</div>`
        : "";
    actionHtml = `
      ${brief}
      <input class="feedback-input" placeholder="Feedback nếu từ chối (tuỳ chọn)" id="fb-${slot.id}" />
      <div class="decision-row">
        <button class="btn btn-approve" onclick="decide('${slot.id}', true, document.getElementById('fb-${slot.id}').value)">Duyệt</button>
        <button class="btn btn-reject" onclick="decide('${slot.id}', false, document.getElementById('fb-${slot.id}').value)">Từ chối</button>
      </div>`;
  } else {
    actionHtml = `<button class="btn btn-small" onclick="runSlot('${slot.id}')">Chạy riêng khung này</button>`;
  }

  return `
    <div class="card${slot.isBoss ? " card-boss" : ""}">
      <div class="card-header"><span class="card-icon">${slot.icon}</span><span>${slot.id}: ${escapeHtml(slot.name)}</span></div>
      <div class="badge ${slot.colorClass}">${slot.label}</div>
      <div class="task-title">${slot.title ? escapeHtml(slot.title) : "Chưa gán task."}</div>
      <div class="progress-track"><div class="progress-fill ${slot.colorClass}" style="width:${slot.progress}%"></div></div>
      <div class="logs">${logsHtml}</div>
      ${actionHtml}
    </div>`;
}

function renderTierSection(tier, tierLabel, slots) {
  if (slots.length === 0) return "";
  return `
    <section class="tier-section">
      <h2 class="tier-heading tier-heading-${tier}">${tierLabel}</h2>
      <div class="tier-grid">${slots.map(renderCard).join("")}</div>
    </section>`;
}

async function refresh() {
  const res = await fetch("/api/status");
  const data = await res.json();
  const byTier = { 1: [], 2: [], 3: [] };
  for (const slot of data.slots) (byTier[slot.tier] ?? byTier[3]).push(slot);
  grid.innerHTML = [1, 2, 3]
    .map((tier) => renderTierSection(tier, byTier[tier][0]?.tierLabel ?? "", byTier[tier]))
    .join("");
}

// Expose for inline onclick handlers.
window.runSlot = runSlot;
window.decide = decide;

refresh();
setInterval(refresh, 3000);
