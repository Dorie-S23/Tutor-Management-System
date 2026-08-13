/* ============================================================
   My Sessions
   Full history for the student: upcoming sessions (cancellable)
   plus a read-only log of past ones. Shared state in session-data.js.
   ============================================================ */

const upcomingListEl = document.getElementById("upcomingList");
const pastListEl = document.getElementById("pastList");

function renderUpcoming() {
  const sessions = StudentData.getUpcomingSessions();

  upcomingListEl.innerHTML = "";

  if (sessions.length === 0) {
    upcomingListEl.innerHTML = `<p class="empty-state">No upcoming sessions. Head to the Dashboard to volunteer for one.</p>`;
    return;
  }

  sessions.forEach((session) => {
    const article = document.createElement("article");
    article.innerHTML = `
      <h3>${session.subject}</h3>
      <p>With ${session.withWho} • ${session.when}</p>
      <strong>Confirmed</strong>
      <button type="button" class="btn-cancel">Can't make it</button>
    `;
    article.querySelector(".btn-cancel").addEventListener("click", () => {
      StudentData.cancelUpcomingSession(session.id);
      renderUpcoming();
      showToast(`Cancelled ${session.subject} with ${session.withWho}`);
    });
    upcomingListEl.appendChild(article);
  });
}

function renderPast() {
  const sessions = StudentData.getPastSessions();

  pastListEl.innerHTML = "";

  if (sessions.length === 0) {
    pastListEl.innerHTML = `<p class="empty-state">No past sessions yet.</p>`;
    return;
  }

  sessions.forEach((session) => {
    const article = document.createElement("article");
    const statusClass = session.status === "Completed" ? "completed" : "missed";
    article.innerHTML = `
      <h3>${session.subject}</h3>
      <p>With ${session.withWho} • ${session.when}</p>
      <span class="status-pill ${statusClass}">${session.status}</span>
    `;
    pastListEl.appendChild(article);
  });
}

// ---------- toast ----------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- init ----------

renderUpcoming();
renderPast();
