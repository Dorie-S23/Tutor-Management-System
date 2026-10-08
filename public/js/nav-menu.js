// Collapses the always-visible row of top nav links into a single menu
// button (the "hamburger") that reveals them as a dropdown — on every page,
// at every width, not just as a mobile fallback. Handles both header shells
// in the app:
//   - app.css pages (tutor/organiser): .tab-nav is nothing but nav links,
//     so the whole element becomes the dropdown panel.
//   - global.css pages (volunteer): .header-actions holds the nav links
//     AND the notification bell side by side, so only the <a> links move
//     into a new dropdown panel — the bell stays where it was, always
//     visible next to the menu button.
// A plain classic script (like theme.js, which this mirrors), so it just
// needs a <script> tag — no bundler, no module graph.
(function initNavMenu() {
  const HAMBURGER_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="3" y1="6" x2="21" y2="6"></line>' +
    '<line x1="3" y1="12" x2="21" y2="12"></line>' +
    '<line x1="3" y1="18" x2="21" y2="18"></line>' +
    "</svg>";

  function buildToggle(extraClass) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `nav-menu-toggle ${extraClass}`;
    btn.setAttribute("aria-label", "Menu");
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = HAMBURGER_SVG;
    return btn;
  }

  // Wires open/close behaviour for one toggle+panel pair: click to open,
  // click outside or Escape to close, selecting a link closes it too (it's
  // about to navigate anyway, but this avoids a stuck-open menu on a
  // back/forward bfcache restore).
  function wire(toggle, panel) {
    function close() {
      panel.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      toggle.classList.remove("is-open");
    }
    function open() {
      panel.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      toggle.classList.add("is-open");
    }
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (panel.hidden) open();
      else close();
    });
    panel.addEventListener("click", (event) => {
      if (event.target.closest("a")) close();
    });
    document.addEventListener("click", (event) => {
      if (
        !panel.hidden &&
        !panel.contains(event.target) &&
        event.target !== toggle &&
        !toggle.contains(event.target)
      ) {
        close();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) {
        close();
        toggle.focus();
      }
    });
    panel.hidden = true;
  }

  function mountTabNav() {
    const tabNav = document.querySelector(".tab-nav");
    if (!tabNav || !tabNav.querySelector("a")) return false;

    const wrap = document.createElement("div");
    wrap.className = "nav-menu";
    tabNav.parentElement.insertBefore(wrap, tabNav);

    const toggle = buildToggle("nav-icon-btn");
    tabNav.classList.add("nav-menu-panel");
    wrap.append(toggle, tabNav);

    wire(toggle, tabNav);
    return true;
  }

  function mountHeaderActions() {
    const headerActions = document.querySelector(".header-actions");
    if (!headerActions) return false;

    const links = [...headerActions.querySelectorAll(":scope > a")];
    if (links.length === 0) return false;

    const wrap = document.createElement("div");
    wrap.className = "nav-menu";

    const panel = document.createElement("div");
    panel.className = "nav-menu-panel";
    links.forEach((a) => panel.appendChild(a));

    const toggle = buildToggle("notif-bell-btn");
    wrap.append(toggle, panel);
    headerActions.insertBefore(wrap, headerActions.firstChild);

    wire(toggle, panel);
    return true;
  }

  function mount() {
    if (!mountTabNav()) mountHeaderActions();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
