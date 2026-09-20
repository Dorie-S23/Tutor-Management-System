// Plain classic script (no imports), same as board.js — this page is
// organiser-only and board.js itself has no login guard beyond reading
// sessionStorage, so this mirrors that rather than inventing a stricter
// pattern just for this page.
function getSessionUserId() {
  try {
    const raw = sessionStorage.getItem("user");
    return raw ? JSON.parse(raw).id : "anon";
  } catch {
    return "anon";
  }
}

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

const draftsListEl = document.getElementById("draftsList");
const historyListEl = document.getElementById("historyList");

function formatTimestamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// draft/published/reverted don't have their own status-pill colours, so
// these borrow the closest existing meaning (approved = green, rejected =
// red) rather than adding a whole new colour variant for three statuses.
function draftPillClass(status) {
  if (status === "published") return "approved";
  if (status === "reverted") return "rejected";
  return "pending";
}

function actionPillClass(action) {
  if (["approved", "claimed", "published"].includes(action)) return "approved";
  if (["rejected", "withdrawn", "restored"].includes(action)) return "rejected";
  return "pending";
}

async function renderDrafts() {
  draftsListEl.innerHTML = "";

  let drafts;
  try {
    const res = await fetch("/api/allocation-drafts");
    if (!res.ok) throw new Error("Failed to load allocation runs");
    drafts = await res.json();
  } catch (err) {
    draftsListEl.innerHTML = `<p class="empty-state">Couldn't load past allocation runs right now.</p>`;
    return;
  }

  if (drafts.length === 0) {
    draftsListEl.innerHTML = `<p class="empty-state">No auto allocation has been run yet.</p>`;
    return;
  }

  drafts.forEach((draft) => {
    const article = document.createElement("article");
    article.innerHTML = `
      <span class="session-meta">${draft.name}</span>
      <p class="session-note">
        ${draft.assignmentCount} assignment${draft.assignmentCount === 1 ? "" : "s"}
        &bull; created ${formatTimestamp(draft.created_at)}
        ${draft.published_at ? `&bull; published ${formatTimestamp(draft.published_at)}` : ""}
      </p>
      <span class="status-pill ${draftPillClass(draft.status)}">${draft.status}</span>
    `;

    if (draft.status === "published") {
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "btn btn-ghost";
      restoreBtn.textContent = "Restore";
      restoreBtn.addEventListener("click", () =>
        restoreDraft(draft, restoreBtn),
      );
      article.appendChild(restoreBtn);
    }

    draftsListEl.appendChild(article);
  });
}

async function restoreDraft(draft, button) {
  const confirmed = window.confirm(
    `Restore "${draft.name}"? Every application it approved goes back to its previous status, and those course slots open up again.`,
  );
  if (!confirmed) return;

  button.disabled = true;
  try {
    const res = await fetch(`/api/allocation-drafts/${draft.id}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organiserId: getSessionUserId() }),
    });
    const body = await res.json();
    if (!res.ok) {
      showToast(body.error || "Couldn't restore that run.");
      button.disabled = false;
      return;
    }
    const failed = body.results.filter((r) => !r.success);
    const succeeded = body.results.length - failed.length;
    showToast(
      failed.length === 0
        ? `Restored ${succeeded} application${succeeded === 1 ? "" : "s"}.`
        : `Restored ${succeeded}, left ${failed.length} alone — they'd already been changed since.`,
    );
    await Promise.all([renderDrafts(), renderHistory()]);
  } catch (err) {
    showToast("Network error — couldn't reach the server.");
    button.disabled = false;
  }
}

async function renderHistory() {
  historyListEl.innerHTML = "";

  let entries;
  try {
    const res = await fetch("/api/audit-log?limit=200");
    if (!res.ok) throw new Error("Failed to load change history");
    entries = await res.json();
  } catch (err) {
    historyListEl.innerHTML = `<p class="empty-state">Couldn't load change history right now.</p>`;
    return;
  }

  if (entries.length === 0) {
    historyListEl.innerHTML = `<p class="empty-state">No changes recorded yet.</p>`;
    return;
  }

  entries.forEach((entry) => {
    const actor = entry.users?.name || entry.actor_id || "System";
    const article = document.createElement("article");
    article.innerHTML = `
      <span class="session-meta">${entry.entity_type} ${entry.entity_id}</span>
      <p class="session-note">
        ${actor} &bull; ${formatTimestamp(entry.created_at)}
      </p>
      <span class="status-pill ${actionPillClass(entry.action)}">${entry.action}</span>
    `;
    historyListEl.appendChild(article);
  });
}

Promise.all([renderDrafts(), renderHistory()]);
