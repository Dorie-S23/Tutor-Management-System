// Fills the navbar's user pill (#user-name / #user-role-badge) from whoever
// is signed in. Plain script (like notifications.js and logout.js) so every
// redesigned app page includes it with a simple <script src> tag.
(function initUserBadge() {
  const nameEl = document.getElementById("user-name");
  const roleEl = document.getElementById("user-role-badge");
  if (!nameEl && !roleEl) return;

  let user = null;
  try {
    user = JSON.parse(sessionStorage.getItem("user") || "null");
  } catch {
    user = null;
  }
  if (!user) return;

  if (nameEl) nameEl.textContent = user.name || "Account";

  if (roleEl) {
    const role = String(user.role || "").toLowerCase();
    // Accounts created before the Volunteer rename were stored with role
    // "student" — show them as volunteers here too.
    const label = role === "student" ? "volunteer" : role;
    roleEl.textContent = label
      ? label.charAt(0).toUpperCase() + label.slice(1)
      : "Member";
  }
})();
