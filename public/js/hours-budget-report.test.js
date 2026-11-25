// hours-budget-report.js drives the hours-budget-report page: it fetches
// the per-course report, groups rows by course into one collapsible card
// per course — budget and spend in the card's summary, the tutor
// breakdown in the table inside — and rolls the page totals into the stat
// tiles and allocation bars. Plain browser script — loaded into a real
// jsdom window with a stubbed fetch and the //# sourceURL tag so Jest's
// v8 coverage attributes executed lines back to the real file.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const reportJs = fs.readFileSync(
  path.join(__dirname, "hours-budget-report.js"),
  "utf8",
);
const dateMaskJs = fs.readFileSync(
  path.join(__dirname, "date-mask.js"),
  "utf8",
);

const PAGE = `
  <input type="date" id="fromDate">
  <input type="date" id="toDate">
  <button id="applyFilterBtn"></button>
  <button id="clearFilterBtn"></button>
  <main id="reportSections"></main>
  <p id="emptyCopy" hidden></p>
  <p id="unlinkedWarning" hidden></p>
  <div id="budgetBars"></div>
  <p id="budgetBarsEmpty" hidden></p>
  <div id="statTotalHours"></div>
  <div id="statTotalCost"></div>
  <div id="statBudgetUsed"></div>
  <div id="statOverBudget"></div>
  <div id="toast"></div>
`;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

const REPORT = {
  rows: [
    {
      courseId: "c1",
      courseCode: "MATH1000",
      courseName: "Intro Maths",
      budget: 1000,
      tutorName: "Ann Smith",
      hours: 2.5,
      hourlyRate: 100,
      cost: 250,
    },
    {
      courseId: "c1",
      courseCode: "MATH1000",
      courseName: "Intro Maths",
      budget: 1000,
      tutorName: null,
      hours: 1.5,
      hourlyRate: null,
      cost: null,
    },
    {
      courseId: "c2",
      courseCode: "PHYS2000",
      courseName: "Physics",
      budget: 100,
      tutorName: "Bob",
      hours: 5,
      hourlyRate: 50,
      cost: 250,
    },
  ],
  unlinkedHours: 3.5,
  unlinkedEntryCount: 2,
};

function loadReport(respond) {
  const calls = [];
  const state = { respond };
  const dom = new JSDOM(
    `<!doctype html><html><body>${PAGE}<script>${dateMaskJs}</script><script>${reportJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "hours-budget-report.js")).href}</script></body></html>`,
    {
      url: "http://localhost/hours-budget-report.html",
      runScripts: "dangerously",
      beforeParse(window) {
        window.fetch = (url) => {
          calls.push(String(url));
          return state.respond(String(url));
        };
      },
    },
  );

  return { win: dom.window, calls, state };
}

describe("hours-budget-report.js", () => {
  test("renders per-course budget math and re-fetches on filter actions", async () => {
    const { win, calls } = loadReport(() => jsonResponse(REPORT));
    await flush();

    const doc = win.document;
    expect(calls[0]).toBe("/api/hour-entries/report?");

    const sections = doc.querySelectorAll(
      "#reportSections details.report-course",
    );
    expect(sections).toHaveLength(2);
    expect(sections[0].open).toBe(true); // the first card starts expanded

    // Cards are sorted by course code; MATH1000 comes first. en-ZA groups
    // thousands with a no-break space ("1 000"), so the expected hint is
    // built with the same locale call the page uses — via textContent,
    // since innerHTML would escape it to &nbsp;.
    const r1000 = `R${(1000).toLocaleString("en-ZA")}`;
    const mathHtml = sections[0].innerHTML;
    expect(mathHtml).toContain("MATH1000 — Intro Maths");
    expect(sections[0].textContent).toContain(`4.0 hrs · R250 of ${r1000}`); // 2.5 + 1.5 hrs, 1000 budget
    expect(mathHtml).toContain(
      "Some tutors on this course have no hourly rate set",
    );
    expect(mathHtml).toContain("R250.00"); // Ann's cost: 2.5 hrs × R100
    expect(mathHtml).toContain("Unknown tutor"); // null tutorName row
    expect(mathHtml).toContain("—"); // null hourly rate / cost
    expect(mathHtml).toContain("2.5 hrs");

    const physHtml = sections[1].innerHTML;
    expect(physHtml).toContain("5.0 hrs · R250 of R100"); // 100 budget, 250 spent

    expect(doc.getElementById("emptyCopy").hidden).toBe(true);
    expect(doc.getElementById("unlinkedWarning").hidden).toBe(false);
    expect(doc.getElementById("unlinkedWarning").textContent).toContain(
      "3.5 hrs across 2 entries",
    );

    // Stat tiles and allocation bars roll up the page totals.
    expect(doc.getElementById("statTotalHours").textContent).toBe("9.0h");
    expect(doc.getElementById("statTotalCost").textContent).toBe("R500");
    expect(doc.getElementById("statBudgetUsed").textContent).toBe("45%");
    expect(doc.getElementById("statOverBudget").textContent).toBe("1");
    expect(doc.getElementById("budgetBarsEmpty").hidden).toBe(true);
    expect(doc.querySelectorAll("#budgetBars .budget-row")).toHaveLength(2);
    expect(doc.getElementById("budgetBars").innerHTML).toContain(
      "budget-row__fill--over",
    );

    // Applying a filter re-fetches with the chosen dates.
    doc.getElementById("fromDate").value = "2026-09-01";
    doc.getElementById("toDate").value = "2026-09-30";
    doc.getElementById("applyFilterBtn").click();
    await flush();
    expect(calls[1]).toBe(
      "/api/hour-entries/report?from=2026-09-01&to=2026-09-30",
    );

    // Clearing the filter blanks the inputs and reloads everything.
    doc.getElementById("clearFilterBtn").click();
    await flush();
    expect(doc.getElementById("fromDate").value).toBe("");
    expect(doc.getElementById("toDate").value).toBe("");
    expect(calls[2]).toBe("/api/hour-entries/report?");
  });

  // A typed "32/13/2026" never reaches the native value (see date-mask), so
  // before this check Apply fired anyway and silently dropped the filter;
  // now the impossible date blocks it with the field's own message.
  test("an impossible typed date blocks Apply and the field carries the message", async () => {
    const { win, calls } = loadReport(() => jsonResponse(REPORT));
    await flush();
    const doc = win.document;

    const field = doc.getElementById("fromDate-typed");
    field.value = "32/13/2026";
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(field.getAttribute("aria-invalid")).toBe("true");

    doc.getElementById("applyFilterBtn").click();
    await flush();
    // Only the initial load ran — the impossible date blocked the re-fetch.
    expect(calls).toHaveLength(1);

    // Fixing the date lets the filter through to the server.
    field.value = "01/09/2026";
    field.dispatchEvent(new win.Event("input", { bubbles: true }));
    doc.getElementById("applyFilterBtn").click();
    await flush();
    expect(calls[1]).toBe("/api/hour-entries/report?from=2026-09-01");

    win.close();
  });

  test("shows the empty state and singular unlinked wording", async () => {
    const { win } = loadReport(() =>
      jsonResponse({ rows: [], unlinkedHours: 0.5, unlinkedEntryCount: 1 }),
    );
    await flush();

    const doc = win.document;
    expect(doc.getElementById("emptyCopy").hidden).toBe(false);
    expect(doc.getElementById("reportSections").innerHTML).toBe("");
    expect(doc.getElementById("unlinkedWarning").hidden).toBe(false);
    expect(doc.getElementById("unlinkedWarning").textContent).toContain(
      "0.5 hrs across 1 entry",
    );
  });

  test("surfaces load failures through the toast", async () => {
    let phase = "network";
    const { win } = loadReport(() =>
      phase === "network"
        ? Promise.reject(new Error(""))
        : jsonResponse({ error: "Nope" }, false),
    );
    await flush();

    const doc = win.document;
    // A rejection with no message falls back to the generic copy.
    expect(doc.getElementById("toast").textContent).toBe(
      "Couldn't load the report right now.",
    );
    expect(doc.getElementById("reportSections").innerHTML).toBe("");

    // A server-reported error is shown verbatim.
    phase = "server";
    doc.getElementById("applyFilterBtn").click();
    await flush();
    expect(doc.getElementById("toast").textContent).toBe("Nope");

    win.close();
  });
});
