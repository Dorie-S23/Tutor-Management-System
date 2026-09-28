/* UI-only helpers for the auth pages:
   - reveal / hide password fields
   - the brand-panel carousel on the left of login.html / register.html

   Kept deliberately separate from auth.js so the login and register
   logic (validation, API calls, redirects) stays exactly as it was. */

document.querySelectorAll(".password-toggle").forEach((button) => {
  const input = document.getElementById(button.dataset.target);

  if (!input) {
    return;
  }

  button.addEventListener("click", () => {
    const revealed = input.type === "password";

    input.type = revealed ? "text" : "password";

    button.classList.toggle("is-revealed", revealed);

    button.setAttribute("aria-pressed", String(revealed));

    button.setAttribute(
      "aria-label",
      revealed ? "Hide password" : "Show password",
    );
  });
});

/* Brand panel carousel — each auth page carries two slides in the decorative
   panel: the product highlights, and "who TutorX is for" with one card per
   role. The active slide crossfades every few seconds and back, and the pill
   dots jump straight to a slide. Hovering the panel pauses the rotation,
   the rotation stops while the tab is hidden, and users with
   prefers-reduced-motion get a static first slide. */

const BRAND_CAROUSEL_INTERVAL = 6000;

document.querySelectorAll("[data-brand-carousel]").forEach((carousel) => {
  const slides = [...carousel.querySelectorAll(".auth-brand-slide")];
  const dots = [...carousel.querySelectorAll(".auth-brand-dot")];
  if (slides.length < 2) return;

  // A page (or a test) may override the rotation speed in ms via
  // data-brand-interval; the auth tests run it fast on real timers.
  const interval =
    Number(carousel.dataset.brandInterval) || BRAND_CAROUSEL_INTERVAL;

  let current = 0;
  let timer = null;

  function show(index) {
    current = (index + slides.length) % slides.length;
    slides.forEach((slide, i) =>
      slide.classList.toggle("is-active", i === current),
    );
    dots.forEach((dot, i) => {
      const active = i === current;
      dot.classList.toggle("is-active", active);
      dot.setAttribute("aria-current", active ? "true" : "false");
    });
  }

  function start() {
    stop();
    timer = setInterval(() => show(current + 1), interval);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  dots.forEach((dot, i) =>
    dot.addEventListener("click", () => {
      show(i);
      start();
    }),
  );

  carousel.addEventListener("mouseenter", stop);
  carousel.addEventListener("mouseleave", start);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion) start();
});
