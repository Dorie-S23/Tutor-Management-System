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
  // Optional secondary mounts for the tutor dashboard's notifications panel —
  // absent on every other page, so the panel rendering below is skipped there.
  const dashList = document.getElementById("dashNotifList");
  const dashEmpty = document.getElementById("dashNotifEmpty");

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
      volunteer: "StudentView.html",
    },
    application_status: {
      param: "highlightApplication",
      tutor: "modules.html",
    },
    volunteer_status: {
      param: "highlightApplication",
      volunteer: "StudentView.html",
    },
    timesheet_status: {
      param: "highlightWeek",
      tutor: "timesheets.html",
    },
    timesheet_due: {
      param: "highlightWeek",
      tutor: "timesheets.html",
    },
    // A volunteer covering a tutor's excused session
    cover_assigned: {
      param: "highlightCover",
      volunteer: "StudentView.html",
    },
    cover_reminder: {
      param: "highlightCover",
      volunteer: "StudentView.html",
    },
    cover_cancelled: {
      param: "highlightCover",
      volunteer: "StudentView.html",
    },
    // Volunteers swapping a cover between themselves
    swap_request: {
      param: "highlightSwap",
      volunteer: "StudentView.html",
    },
    swap_accepted: {
      param: "highlightCover",
      volunteer: "StudentView.html",
    },
    swap_declined: {
      param: "highlightCover",
      volunteer: "StudentView.html",
    },
    swap_withdrawn: {
      param: "highlightCover",
      volunteer: "StudentView.html",
    },
    // The excused tutor, hearing who (if anyone) is covering for them
    cover_found: {
      param: "highlightExcusal",
      tutor: "dashboard.html",
    },
    cover_unavailable: {
      param: "highlightExcusal",
      tutor: "dashboard.html",
    },
  };

  function destinationFor(n) {
    if (!n.related_id) return null;
    const entry = DESTINATIONS[n.type];
    const page = entry?.[user.role];
    if (!page) return null;
    return `${page}?${entry.param}=${encodeURIComponent(n.related_id)}`;
  }

  // Sidebar-panel icons for the dashboard: a teal check for good news, a red
  // alert for problems, and a neutral info glyph for everything else.
  const DASH_ICONS = {
    check: `<svg class="dash-notif-icon dash-notif-icon--check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    alert: `<svg class="dash-notif-icon dash-notif-icon--alert" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    info: `<svg class="dash-notif-icon dash-notif-icon--info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  };

  // Anything not listed here falls back to the neutral info icon.
  const DASH_ICON_BUCKETS = {
    cover_assigned: "check",
    cover_found: "check",
    swap_accepted: "check",
    timesheet_due: "alert",
    cover_unavailable: "alert",
    cover_cancelled: "alert",
    swap_declined: "alert",
    swap_withdrawn: "alert",
  };

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

  // The latest list, kept so a click that marks an item read can re-render
  // both mounts (bell dropdown + dashboard panel) with the updated state.
  let current = [];

  // Marks read when needed, then follows the notification's destination —
  // which may be null (unknown type/role), in which case nothing happens.
  async function openNotification(n) {
    if (!n.read) {
      n.read = true;
      render(current);
      await markRead(n.id);
    }
    const dest = destinationFor(n);
    if (dest) window.location.href = dest;
  }

  function render(notifications) {
    current = notifications;
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

      li.addEventListener("click", () => openNotification(n));

      list.appendChild(li);
    });

    // Optional secondary mount: the tutor dashboard's side panel, capped at
    // the latest few so it stays a glance rather than a second inbox.
    if (dashList) {
      dashList.innerHTML = "";
      if (dashEmpty) dashEmpty.hidden = notifications.length > 0;

      notifications.slice(0, 4).forEach((n) => {
        const li = document.createElement("li");
        li.className = "dash-panel__item";
        li.insertAdjacentHTML(
          "beforeend",
          DASH_ICONS[DASH_ICON_BUCKETS[n.type] || "info"],
        );

        const body = document.createElement("div");
        const message = document.createElement("p");
        message.textContent = n.message;
        const meta = document.createElement("p");
        meta.className = "dash-notif-time";
        meta.textContent = timeAgo(n.created_at);
        body.append(message, meta);
        li.appendChild(body);

        li.addEventListener("click", () => openNotification(n));
        dashList.appendChild(li);
      });
    }
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
