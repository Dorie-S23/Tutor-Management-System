/* ============================================================
   StudyConnect — shared first-run guided tour.

   A small spotlight-and-tooltip walkthrough with no dependencies.
   Attaches window.Onboarding so it can be used from a classic
   <script> (board.js) or imported indirectly by an ES module
   (studentview.js) — both share the same window.

   Usage:
     window.Onboarding.start(steps, { tourId, userId });

   `steps` is an array of { selector, title, body, placement }.
   Each tour is only auto-shown once per (tourId, userId) pair,
   tracked in localStorage. Pass `force: true` to replay it.

   While a step is on screen the page behind it is locked down: a
   full-viewport click shield, a capture-phase click guard, and
   `inert` on the rest of the page stop pointer and keyboard input
   from reaching (or triggering) real controls mid-tour, so the tour
   can only be advanced from its own controls or left via "Skip tour".
   ============================================================ */
(function () {
  function tourKey(tourId, userId) {
    return `studyconnect.onboarding.${tourId}.${userId || "anon"}`;
  }

  function hasSeenTour(tourId, userId) {
    return localStorage.getItem(tourKey(tourId, userId)) === "done";
  }

  function markTourSeen(tourId, userId) {
    try {
      localStorage.setItem(tourKey(tourId, userId), "done");
    } catch {
      // localStorage unavailable (private browsing, etc.) — tour will just
      // show again next visit, which is a safe failure mode.
    }
  }

  function clearTourSeen(tourId, userId) {
    localStorage.removeItem(tourKey(tourId, userId));
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  let activeTour = null;

  function start(steps, { tourId, userId, force = false } = {}) {
    if (!tourId) throw new Error("Onboarding.start requires a tourId");
    if (!force && hasSeenTour(tourId, userId)) return;
    if (activeTour) return; // a tour is already running — don't stack them

    const usable = steps.filter((s) =>
      isVisible(document.querySelector(s.selector)),
    );
    if (usable.length === 0) {
      // Nothing on this page matched (e.g. wrong role, still loading) —
      // don't mark it seen, so it can still show once content is ready.
      return;
    }

    activeTour = { steps: usable, index: 0, tourId, userId };
    renderStep();
  }

  // While a step is on screen the ring and tooltip sit in viewport
  // coordinates, so the page must not move underneath them. The lock is
  // overflow: hidden on both scrollers — that stops wheel, keyboard,
  // and scrollbar scrolling — while renderStep lifts and re-applies it
  // around its scrollIntoView so step positioning still works.
  let scrollLockState = null;

  function setScrollLock(on) {
    const html = document.documentElement;
    const body = document.body;
    if (on) {
      if (!scrollLockState) {
        scrollLockState = {
          html: html.style.overflow,
          body: body.style.overflow,
        };
      }
      html.style.overflow = "hidden";
      body.style.overflow = "hidden";
    } else if (scrollLockState) {
      html.style.overflow = scrollLockState.html;
      body.style.overflow = scrollLockState.body;
      scrollLockState = null;
    }
  }

  // Everything except the tour's own elements is switched off while a
  // step shows. The click shield already eats pointer input; `inert`
  // stops keyboard focus from reaching (and Enter/Space from
  // activating) page controls behind the overlay too.
  const TOUR_UI_CLASSES = [
    "onboarding-backdrop",
    "onboarding-shield",
    "onboarding-ring",
    "onboarding-tooltip",
  ];

  function setPageInert(on) {
    for (const el of document.body.children) {
      if (TOUR_UI_CLASSES.some((cls) => el.classList.contains(cls))) continue;
      if (on) {
        // Don't stomp on inert that was already there for another reason.
        if (!el.hasAttribute("inert")) {
          el.setAttribute("inert", "");
          el.setAttribute("data-onboarding-inert", "");
        }
      } else if (el.hasAttribute("data-onboarding-inert")) {
        el.removeAttribute("inert");
        el.removeAttribute("data-onboarding-inert");
      }
    }
  }

  // Capture-phase backstop for the shield: any click that would reach a
  // real control (or a link that would navigate away) is swallowed, so
  // the tour can't fire actual actions or end itself from under the user.
  // Clicks inside the tooltip — Next, Back, Skip — pass through.
  function onGuardClick(e) {
    if (!activeTour) return;
    const tooltip = document.querySelector(".onboarding-tooltip");
    if (tooltip && tooltip.contains(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function teardown() {
    document
      .querySelectorAll(
        ".onboarding-backdrop, .onboarding-shield, .onboarding-ring, .onboarding-tooltip",
      )
      .forEach((el) => el.remove());
    window.removeEventListener("resize", renderStep);
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("click", onGuardClick, true);
    setPageInert(false);
    setScrollLock(false);
  }

  function finish() {
    if (!activeTour) return;
    markTourSeen(activeTour.tourId, activeTour.userId);
    teardown();
    activeTour = null;
  }

  function onKeydown(e) {
    if (e.key === "Escape") finish();
    else if (e.key === "ArrowRight") next();
    else if (e.key === "ArrowLeft") back();
  }

  function next() {
    if (!activeTour) return;
    if (activeTour.index >= activeTour.steps.length - 1) {
      finish();
      return;
    }
    activeTour.index += 1;
    renderStep();
  }

  function back() {
    if (!activeTour || activeTour.index === 0) return;
    activeTour.index -= 1;
    renderStep();
  }

  function spotlightClipPath(rect, pad) {
    const top = rect.top - pad;
    const left = rect.left - pad;
    const right = rect.right + pad;
    const bottom = rect.bottom + pad;
    // Outer viewport rectangle, then cut a hole for the target rectangle.
    return `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${left}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${top}px, ${left}px ${top}px)`;
  }

  function positionTooltip(tooltip, rect, placement) {
    const margin = 14;
    const ttRect = tooltip.getBoundingClientRect();
    let top;
    let left;

    switch (placement) {
      case "top":
        top = rect.top - ttRect.height - margin;
        left = rect.left;
        break;
      case "left":
        top = rect.top;
        left = rect.left - ttRect.width - margin;
        break;
      case "right":
        top = rect.top;
        left = rect.right + margin;
        break;
      case "bottom":
      default:
        top = rect.bottom + margin;
        left = rect.left;
    }

    top = Math.max(
      margin,
      Math.min(top, window.innerHeight - ttRect.height - margin),
    );
    left = Math.max(
      margin,
      Math.min(left, window.innerWidth - ttRect.width - margin),
    );

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  function renderStep() {
    if (!activeTour) return;
    teardown();

    const step = activeTour.steps[activeTour.index];
    const target = document.querySelector(step.selector);
    if (!isVisible(target)) {
      // Target disappeared (role-hidden element, layout change) — skip it
      // rather than spotlighting nothing.
      next();
      return;
    }

    target.scrollIntoView({ block: "center", behavior: "auto" });
    // Freeze the page again now the target is in place; the highlight
    // geometry below is measured against the locked layout.
    setScrollLock(true);

    const rect = target.getBoundingClientRect();
    const pad = 6;

    const backdrop = document.createElement("div");
    backdrop.className = "onboarding-backdrop";
    Object.assign(backdrop.style, {
      position: "fixed",
      inset: "0",
      zIndex: "1000",
      background: "rgba(15, 23, 42, 0.55)",
      clipPath: spotlightClipPath(rect, pad),
    });
    document.body.appendChild(backdrop);

    // Transparent full-viewport layer above the page but below the
    // tooltip: pointer input aimed at the spotlit control lands here and
    // goes nowhere, so the tour can't be derailed by a click on the very
    // button it is highlighting.
    const shield = document.createElement("div");
    shield.className = "onboarding-shield";
    shield.setAttribute("aria-hidden", "true");
    Object.assign(shield.style, {
      position: "fixed",
      inset: "0",
      zIndex: "1001",
      cursor: "default",
    });
    document.body.appendChild(shield);

    const ring = document.createElement("div");
    ring.className = "onboarding-ring";
    Object.assign(ring.style, {
      position: "fixed",
      top: `${rect.top - pad}px`,
      left: `${rect.left - pad}px`,
      width: `${rect.width + pad * 2}px`,
      height: `${rect.height + pad * 2}px`,
      borderRadius: "10px",
      boxShadow: "0 0 0 3px #fff, 0 0 0 5px #2563eb",
      zIndex: "1001",
      pointerEvents: "none",
    });
    document.body.appendChild(ring);

    const tooltip = document.createElement("div");
    tooltip.className = "onboarding-tooltip";
    tooltip.setAttribute("role", "dialog");
    tooltip.setAttribute("aria-modal", "true");
    tooltip.setAttribute("aria-label", step.title);
    Object.assign(tooltip.style, {
      position: "fixed",
      zIndex: "1002",
      width: "min(420px, calc(100vw - 28px))",
      background: "#ffffff",
      borderRadius: "18px",
      boxShadow:
        "0 24px 60px rgba(15, 23, 42, 0.28), 0 4px 14px rgba(15, 23, 42, 0.12)",
      padding: "25px 28px",
      fontFamily: "inherit",
    });

    const stepCount = document.createElement("p");
    stepCount.textContent = `Step ${activeTour.index + 1} of ${activeTour.steps.length}`;
    stepCount.style.cssText =
      "font-size:12px;color:#64748b;margin:0 0 10px;letter-spacing:0.02em;";

    const title = document.createElement("h3");
    title.textContent = step.title;
    title.style.cssText =
      'margin:0 0 8px;font-family:"Fraunces",Georgia,"Times New Roman",serif;font-size:22px;font-weight:600;letter-spacing:-0.4px;line-height:1.25;color:#0f172a;';

    const body = document.createElement("p");
    body.textContent = step.body;
    body.style.cssText =
      "margin:0 0 20px;font-size:14px;line-height:1.55;color:#475569;";

    const actions = document.createElement("div");
    actions.style.cssText =
      "display:flex;justify-content:space-between;align-items:center;gap:10px;";

    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.textContent = "Skip tour";
    skipBtn.style.cssText =
      "background:none;border:none;color:#64748b;font-size:13px;font-family:inherit;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px;";
    skipBtn.addEventListener("click", finish);

    const navGroup = document.createElement("div");
    navGroup.style.cssText = "display:flex;gap:8px;";

    if (activeTour.index > 0) {
      const backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.textContent = "Back";
      backBtn.style.cssText =
        "padding:9px 14px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#64748b;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;";
      backBtn.addEventListener("click", back);
      navGroup.appendChild(backBtn);
    }

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.textContent =
      activeTour.index === activeTour.steps.length - 1 ? "Done" : "Next";
    nextBtn.style.cssText =
      "padding:9px 16px 10px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;";
    nextBtn.addEventListener("click", next);
    navGroup.appendChild(nextBtn);

    actions.append(skipBtn, navGroup);
    tooltip.append(stepCount, title, body, actions);
    document.body.appendChild(tooltip);

    positionTooltip(tooltip, rect, step.placement);

    window.addEventListener("resize", renderStep, { once: true });
    document.addEventListener("keydown", onKeydown, { once: true });
    document.addEventListener("click", onGuardClick, true);
    setPageInert(true);

    nextBtn.focus();
  }

  window.Onboarding = { start, finish, clearTourSeen, hasSeenTour };
})();
