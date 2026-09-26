// Bell icon + dropdown, shared verbatim across every tutor- and
// student-facing page (there's no shared header component in this app —
// each page's <header> is hand-duplicated — so this one script is what's
// actually shared: it wires up whatever #notifBell markup exists on the
// current page, does nothing if that markup isn't there).
//
// Polling, not realtime: on load, then every 45s, GET /api/notifications
// and re-render the badge + list. Simple, fits the same fetch-based
// pattern as the rest of the app, no new client-side dependencies.

function getCurrentUser() {
  try {
    const raw = sessionStorage.getItem("user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

(function initNotifications() {
  const user = getCurrentUser();
  const bellBtn = document.getElementById("notifBellBtn");
  const badge = document.getElementById("notifBellBadge");
  const dropdown = document.getElementById("notifDropdown");
  const list = document.getElementById("notifList");
  const empty = document.getElementById("notifEmpty");
  const markAllBtn = document.getElementById("notifMarkAllBtn");

  // Nothing to do if this page has no bell markup, or nobody's signed in
  // (some pages are reachable before login redirects fire).
  if (!user || !bellBtn || !badge || !dropdown || !list || !empty) return;

  const POLL_MS = 45000;

  function timeAgo(isoString) {
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - new Date(isoString).getTime()) / 1000),
    );
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // Where a notification should take you when clicked, and what to
  // highlight once you get there. Each entry maps a notification `type` to
  // the destination page per role and the query param that page's script
  // reads to know what to scroll to and flash — see highlightTarget.js.
  // Anything not listed here just marks read with no navigation, so a
  // future notification type degrades gracefully until it's added.
  const DESTINATIONS = {
    session_change: {
      param: "highlightCourse",
      tutor: "dashboard.html",
      student: "StudentView.html",
    },
    application_status: {
      param: "highlightApplication",
      tutor: "modules.html",
    },
    volunteer_status: {
      param: "highlightApplication",
      student: "StudentView.html",
    },
    timesheet_status: {
      param: "highlightWeek",
      tutor: "timesheets.html",
    },
    timesheet_due: {
      param: "highlightWeek",
      tutor: "timesheets.html",
    },
  };

  function destinationFor(n) {
    if (!n.related_id) return null;
    const entry = DESTINATIONS[n.type];
    const page = entry?.[user.role];
    if (!page) return null;
    return `${page}?${entry.param}=${encodeURIComponent(n.related_id)}`;
  }

  async function markRead(id) {
    try {
      await fetch(`/api/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read: true }),
      });
    } catch {
      // Best-effort — a failed mark-as-read isn't worth surfacing an error
      // for for; the next poll will just show it as unread again.
    }
  }

  function render(notifications) {
    const unreadCount = notifications.filter((n) => !n.read).length;
    badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
    badge.hidden = unreadCount === 0;

    list.innerHTML = "";
    empty.hidden = notifications.length > 0;

    notifications.forEach((n) => {
      const li = document.createElement("li");
      li.className = "notif-item";
      if (!n.read) li.classList.add("notif-item--unread");

      const message = document.createElement("p");
      message.className = "notif-message";
      message.textContent = n.message;
      li.appendChild(message);

      const meta = document.createElement("p");
      meta.className = "notif-time";
      meta.textContent = timeAgo(n.created_at);
      li.appendChild(meta);

      li.addEventListener("click", async () => {
        if (!n.read) {
          n.read = true;
          render(notifications);
          await markRead(n.id);
        }
        const dest = destinationFor(n);
        if (dest) window.location.href = dest;
      });

      list.appendChild(li);
    });
  }

  async function load() {
    try {
      const res = await fetch(
        `/api/notifications?userId=${encodeURIComponent(user.id)}`,
      );
      if (!res.ok) return;
      render(await res.json());
    } catch {
      // Network hiccup — leave whatever was last rendered in place rather
      // than clearing it, and just try again on the next poll.
    }
  }

  bellBtn.addEventListener("click", () => {
    const willOpen = dropdown.hidden;
    dropdown.hidden = !willOpen;
    bellBtn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) load();
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.hidden && !e.target.closest("#notifBell")) {
      dropdown.hidden = true;
      bellBtn.setAttribute("aria-expanded", "false");
    }
  });

  markAllBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await fetch("/api/notifications/read-all", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      await load();
    } catch {
      // Best-effort, same as markRead — next poll reconciles either way.
    }
  });

  load();
  setInterval(load, POLL_MS);
})();
