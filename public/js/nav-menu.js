// Collapses the always-visible row of top nav links into a single menu
// button (the "hamburger") that reveals them as a dropdown — on phone-sized
// screens only. Above the breakpoint the links stay in their normal desktop
// row; crossing the breakpoint (rotating a tablet, resizing a window) mounts
// or unmounts the menu and puts every link back exactly where it was.
// Handles both header shells in the app:
//   - app.css pages (tutor/organiser): .tab-nav is nothing but nav links,
//     so the whole element becomes the dropdown panel.
//   - global.css pages (volunteer): .header-actions holds the nav links
//     AND the notification bell side by side, so only the <a> links move
//     into a new dropdown panel — the bell stays where it was, always
//     visible next to the menu button.
// Each breakpoint matches the width where that stylesheet already switches
// its header to the mobile layout.
// A plain classic script (like theme.js, which this mirrors), so it just
// needs a <script> tag — no bundler, no module graph.
(function initNavMenu() {
  const TAB_NAV_QUERY = "(max-width: 720px)";
  const HEADER_ACTIONS_QUERY = "(max-width: 860px)";

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
  // back/forward bfcache restore). Returns a function that removes the
  // document-level listeners again when the menu is unmounted.
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
    function onDocClick(event) {
      if (
        !panel.hidden &&
        !panel.contains(event.target) &&
        event.target !== toggle &&
        !toggle.contains(event.target)
      ) {
        close();
      }
    }
    function onKeydown(event) {
      if (event.key === "Escape" && !panel.hidden) {
        close();
        toggle.focus();
      }
    }
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (panel.hidden) open();
      else close();
    });
    panel.addEventListener("click", (event) => {
      if (event.target.closest("a")) close();
    });
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);
    panel.hidden = true;

    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeydown);
    };
  }

  // Returns an unmount function, or null if this page has no .tab-nav links.
  function mountTabNav() {
    const tabNav = document.querySelector(".tab-nav");
    if (!tabNav || !tabNav.querySelector("a")) return null;

    const wrap = document.createElement("div");
    wrap.className = "nav-menu";
    tabNav.parentElement.insertBefore(wrap, tabNav);

    const toggle = buildToggle("nav-icon-btn");
    tabNav.classList.add("nav-menu-panel");
    wrap.append(toggle, tabNav);

    const unwire = wire(toggle, tabNav);
    return () => {
      unwire();
      wrap.parentElement.insertBefore(tabNav, wrap);
      wrap.remove();
      tabNav.classList.remove("nav-menu-panel");
      tabNav.hidden = false;
    };
  }

  // Returns an unmount function, or null if .header-actions has no links.
  function mountHeaderActions() {
    const headerActions = document.querySelector(".header-actions");
    if (!headerActions) return null;

    const links = [...headerActions.querySelectorAll(":scope > a")];
    if (links.length === 0) return null;

    // Leave a marker where each link sat so unmounting can put it back in
    // its original spot, interleaved with the bell and any other buttons.
    const markers = links.map((a) => {
      const marker = document.createComment("nav-menu");
      a.before(marker);
      return marker;
    });

    const wrap = document.createElement("div");
    wrap.className = "nav-menu";

    const panel = document.createElement("div");
    panel.className = "nav-menu-panel";
    links.forEach((a) => panel.appendChild(a));

    const toggle = buildToggle("notif-bell-btn");
    wrap.append(toggle, panel);
    headerActions.insertBefore(wrap, headerActions.firstChild);

    const unwire = wire(toggle, panel);
    return () => {
      unwire();
      links.forEach((a, i) => markers[i].replaceWith(a));
      wrap.remove();
    };
  }

  // Mounts the menu while the media query matches and unmounts it when it
  // stops matching.
  function mountResponsive(query, mounter) {
    const mql = window.matchMedia(query);
    let unmount = null;

    function sync() {
      if (mql.matches && !unmount) {
        unmount = mounter();
      } else if (!mql.matches && unmount) {
        unmount();
        unmount = null;
      }
    }

    sync();
    mql.addEventListener("change", sync);
  }

  function mount() {
    const tabNav = document.querySelector(".tab-nav");
    if (tabNav && tabNav.querySelector("a")) {
      mountResponsive(TAB_NAV_QUERY, mountTabNav);
    } else if (document.querySelector(".header-actions > a")) {
      mountResponsive(HEADER_ACTIONS_QUERY, mountHeaderActions);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
