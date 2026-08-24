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
  // No real backing data for past sessions yet (nothing in Supabase for
  // this), so just say so rather than showing fake local data.
  pastListEl.innerHTML = `<p class="empty-state">No past sessions</p>`;
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
