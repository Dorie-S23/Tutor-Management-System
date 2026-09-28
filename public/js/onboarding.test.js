// While a tour step is on screen the page behind it must be locked: clicks
// outside the tooltip are swallowed (no real actions, no navigation out
// from under a highlighted link) and the page is made inert, so the tour
// can only be advanced from its own controls or left via "Skip tour".
// jsdom has no hit-testing, so these tests drive the same capture-phase
// guard a real click passes through and assert on the DOM the tour builds.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const onboardingJs = fs.readFileSync(
  path.join(__dirname, "onboarding.js"),
  "utf8",
);
const onboardingJsUrl = pathToFileURL(
  path.join(__dirname, "onboarding.js"),
).href;

const PAGE_HTML = `<!doctype html><html><body>
  <header class="app-navbar"><a href="login.html" id="navLink">Manage Tutors</a></header>
  <main class="app-main"><button type="button" id="cta">Add course</button></main>
</body></html>`;

const openDoms = [];

function loadPage() {
  const dom = new JSDOM(PAGE_HTML, {
    url: "http://localhost/dashboard.html",
    runScripts: "dangerously",
    beforeParse(window) {
      // jsdom lays nothing out — give every element a viewport rect so
      // isVisible() and the tooltip positioning work like in a browser.
      window.Element.prototype.getBoundingClientRect = function () {
        return {
          width: 120,
          height: 40,
          top: 50,
          left: 50,
          right: 170,
          bottom: 90,
          x: 50,
          y: 50,
        };
      };
      window.Element.prototype.scrollIntoView = () => {};
    },
  });

  // sourceURL lets Jest's v8 coverage attribute this eval'd copy of the
  // script to the real file's lines.
  dom.window.eval(onboardingJs + "\n//# sourceURL=" + onboardingJsUrl);
  openDoms.push(dom);
  return dom.window;
}

const STEPS = [
  { selector: "#cta", title: "Step one", body: "One", placement: "bottom" },
  {
    selector: ".app-navbar",
    title: "Step two",
    body: "Two",
    placement: "bottom",
  },
];

function startTour(window) {
  window.Onboarding.start(STEPS, {
    tourId: "test-tour",
    userId: "u1",
    force: true,
  });
}

function tooltipButton(window, label) {
  return [
    ...window.document.querySelectorAll(".onboarding-tooltip button"),
  ].find((b) => b.textContent === label);
}

afterEach(() => {
  openDoms.splice(0).forEach((dom) => dom.window.close());
});

describe("onboarding tour page lock", () => {
  test("builds the spotlight UI and makes the page inert while a step shows", () => {
    const window = loadPage();
    startTour(window);
    const doc = window.document;

    expect(doc.querySelector(".onboarding-backdrop")).toBeTruthy();
    expect(doc.querySelector(".onboarding-shield")).toBeTruthy();
    expect(doc.querySelector(".onboarding-tooltip")).toBeTruthy();

    expect(doc.querySelector("header").hasAttribute("inert")).toBe(true);
    expect(doc.querySelector("main").hasAttribute("inert")).toBe(true);
    // The tour's own UI must stay interactive.
    expect(doc.querySelector(".onboarding-tooltip").hasAttribute("inert")).toBe(
      false,
    );
  });

  test("swallows clicks on the page behind the tour but still advances from the tooltip", () => {
    const window = loadPage();
    startTour(window);
    const doc = window.document;

    let ctaClicks = 0;
    doc.getElementById("cta").addEventListener("click", () => {
      ctaClicks += 1;
    });

    const blocked = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    const dispatched = doc.getElementById("cta").dispatchEvent(blocked);

    expect(ctaClicks).toBe(0); // the real handler never ran
    expect(dispatched).toBe(false); // and the default action was cancelled
    expect(doc.querySelector(".onboarding-tooltip")).toBeTruthy(); // tour still up

    tooltipButton(window, "Next").click();
    expect(doc.querySelector(".onboarding-tooltip h3").textContent).toBe(
      "Step two",
    );
  });

  test("skip ends the tour, cleans up the lock, and the page becomes clickable again", () => {
    const window = loadPage();
    startTour(window);
    const doc = window.document;

    tooltipButton(window, "Skip tour").click();

    expect(doc.querySelector(".onboarding-tooltip")).toBeNull();
    expect(doc.querySelector(".onboarding-shield")).toBeNull();
    expect(doc.querySelector("main").hasAttribute("inert")).toBe(false);

    let ctaClicks = 0;
    doc.getElementById("cta").addEventListener("click", () => {
      ctaClicks += 1;
    });
    doc.getElementById("cta").click();
    expect(ctaClicks).toBe(1);

    // Seen-flag stored, so the auto-show won't fire again.
    expect(
      window.localStorage.getItem("studyconnect.onboarding.test-tour.u1"),
    ).toBe("done");
  });
});
