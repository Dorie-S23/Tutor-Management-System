/* ============================================================
   Student Dashboard
   Open Sessions (volunteer for unfilled work) + Upcoming Sessions
   (cancel one you can't make). Shared state lives in session-data.js.
   ============================================================ */

const openSessionsListEl = document.getElementById("openSessionsList");
const upcomingSessionsListEl = document.getElementById("upcomingSessionsList");

function renderOpenSessions() {
  const available = StudentData.getOpenSessions();

  openSessionsListEl.innerHTML = "";

  if (available.length === 0) {
    openSessionsListEl.innerHTML = `<p class="empty-state">No open sessions right now — check back soon.</p>`;
    return;
  }

  available.forEach((session) => {
    const article = document.createElement("article");
    article.innerHTML = `
      <h3>${session.emoji} ${session.subject}</h3>
      <p class="session-meta">${session.topic} · ${session.day}, ${session.time}</p>
      <p class="session-note">${session.student}${session.note ? " — " + session.note : ""}</p>
      <button type="button">Volunteer</button>
    `;
    article.querySelector("button").addEventListener("click", () => {
      StudentData.claimSession(session.id);
      renderOpenSessions();
      renderUpcomingSessions();
      showToast(`You volunteered for ${session.subject} with ${session.student}`);
    });
    openSessionsListEl.appendChild(article);
  });
}

function renderUpcomingSessions() {
  const sessions = StudentData.getUpcomingSessions();

  upcomingSessionsListEl.innerHTML = "";

  if (sessions.length === 0) {
    upcomingSessionsListEl.innerHTML = `<p class="empty-state">No upcoming sessions. Volunteer for one above.</p>`;
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
      renderOpenSessions();
      renderUpcomingSessions();
      showToast(`Cancelled ${session.subject} with ${session.withWho}`);
    });
    upcomingSessionsListEl.appendChild(article);
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

renderOpenSessions();
renderUpcomingSessions();
