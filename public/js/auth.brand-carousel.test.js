// The brand panel carousel on the auth pages (login.html / register.html):
// the hero alternates between the product-highlights slide and the "who
// TutorX is for" roles slide and back, with pill dots, hover pause, a
// tab-hidden pause, and a prefers-reduced-motion fallback.
//
// Like calendar.day-view.test.js, the real page is loaded into a jsdom
// document with its <script src> tags swapped for the real inline code, so
// the test drives the same DOM the app actually builds. jsdom's window timers
// do not play well with jest fake timers, so instead the page's
// data-brand-interval override runs the rotation fast on real timers.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const NL = String.fromCharCode(10);
const TICK_MS = 50;

const authJs = fs.readFileSync(path.join(__dirname, "auth.js"), "utf8");
const authUiJs = fs.readFileSync(path.join(__dirname, "auth-ui.js"), "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadAuthPage({ register = false, reduceMotion = false } = {}) {
  const file = register ? "register.html" : "login.html";
  const html = fs.readFileSync(
    path.join(__dirname, "..", "html", file),
    "utf8",
  );

  const page = html
    .replace(
      '<div class="auth-brand-hero" data-brand-carousel>',
      '<div class="auth-brand-hero" data-brand-carousel data-brand-interval="' +
        TICK_MS +
        '">',
    )
    .replace(
      '<script src="../js/auth.js"></script>',
      "<script>" + NL + authJs + NL + "</script>",
    )
    .replace(
      '<script src="../js/auth-ui.js"></script>',
      "<script>" + NL + authUiJs + NL + "</script>",
    );

  const dom = new JSDOM(page, {
    url: "http://localhost/" + file,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom's own matchMedia is unreliable; pin it per page load so the
      // reduced-motion path is exercised deterministically.
      window.matchMedia = (query) => ({
        matches: reduceMotion && query.indexOf("prefers-reduced-motion") !== -1,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      });
    },
  });

  return dom.window;
}

function activeSlide(doc) {
  const slides = [...doc.querySelectorAll(".auth-brand-slide")];
  return slides.findIndex((slide) => slide.classList.contains("is-active"));
}

function activeDot(doc) {
  const dots = [...doc.querySelectorAll(".auth-brand-dot")];
  return dots.findIndex((dot) => dot.classList.contains("is-active"));
}

// With two slides the rotation flips state every TICK_MS; each state lasts
// one tick, so poll until the wanted slide shows up (well inside deadline).
async function waitForSlide(doc, wanted, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (activeSlide(doc) === wanted) return true;
    await sleep(10);
  }
  return activeSlide(doc) === wanted;
}

describe("auth brand panel carousel", () => {
  test("starts on the highlights slide and carries a roles slide with one card per role", () => {
    const window = loadAuthPage();
    const doc = window.document;

    expect(activeSlide(doc)).toBe(0);
    expect(activeDot(doc)).toBe(0);
    const dots = doc.querySelectorAll(".auth-brand-dot");
    expect(dots[0].getAttribute("aria-current")).toBe("true");
    expect(dots[1].getAttribute("aria-current")).toBe("false");

    const roles = [...doc.querySelectorAll(".auth-brand-roles li")];
    expect(roles.length).toBe(3);
    expect(roles.map((li) => li.querySelector("strong").textContent)).toEqual([
      "Tutors",
      "Organisers",
      "Volunteers",
    ]);
    const blurb = (i) => roles[i].textContent;
    expect(blurb(0)).toContain("Wits tutors");
    expect(blurb(1)).toContain("allocations");
    expect(blurb(2)).toContain("session cover");
  });

  test("auto-advances to the roles slide and back on its own", async () => {
    const window = loadAuthPage();
    const doc = window.document;

    expect(await waitForSlide(doc, 1)).toBe(true);
    expect(await waitForSlide(doc, 0)).toBe(true);
    expect(await waitForSlide(doc, 1)).toBe(true);
  });

  test("dot clicks jump straight to a slide and the rotation carries on", async () => {
    const window = loadAuthPage();
    const doc = window.document;
    const dots = doc.querySelectorAll(".auth-brand-dot");

    dots[1].click();
    expect(activeSlide(doc)).toBe(1);
    expect(activeDot(doc)).toBe(1);
    expect(dots[1].getAttribute("aria-current")).toBe("true");
    expect(dots[0].getAttribute("aria-current")).toBe("false");

    // The interval restarted from the click, so it flips back on its own.
    expect(await waitForSlide(doc, 0)).toBe(true);

    dots[0].click();
    expect(activeSlide(doc)).toBe(0);
  });

  test("hovering the panel pauses it and leaving resumes", async () => {
    const window = loadAuthPage();
    const doc = window.document;
    const carousel = doc.querySelector("[data-brand-carousel]");

    carousel.dispatchEvent(new window.MouseEvent("mouseenter"));
    await sleep(3 * TICK_MS);
    expect(activeSlide(doc)).toBe(0);

    carousel.dispatchEvent(new window.MouseEvent("mouseleave"));
    expect(await waitForSlide(doc, 1)).toBe(true);
  });

  test("prefers-reduced-motion leaves the first slide static", async () => {
    const window = loadAuthPage({ reduceMotion: true });
    const doc = window.document;

    await sleep(3 * TICK_MS);
    expect(activeSlide(doc)).toBe(0);
    expect(activeDot(doc)).toBe(0);
    expect(
      doc.querySelectorAll(".auth-brand-dot")[1].getAttribute("aria-current"),
    ).toBe("false");
  });

  test("register.html carries the same carousel", async () => {
    const window = loadAuthPage({ register: true });
    const doc = window.document;

    expect(doc.querySelectorAll(".auth-brand-slide").length).toBe(2);
    expect(doc.querySelectorAll(".auth-brand-roles li").length).toBe(3);
    expect(doc.querySelectorAll(".auth-brand-dot").length).toBe(2);
    expect(await waitForSlide(doc, 1)).toBe(true);
  });
});
