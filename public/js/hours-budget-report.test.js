// hours-budget-report.js drives the hours-budget-report page: it fetches
// the per-course report, groups rows by course, and renders budget/spent/
// remaining headers plus a per-tutor table. Plain browser script — loaded
// into a real jsdom window with a stubbed fetch and the //# sourceURL tag
// so Jest's v8 coverage attributes executed lines back to the real file.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const reportJs = fs.readFileSync(
  path.join(__dirname, "hours-budget-report.js"),
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
    `<!doctype html><html><body>${PAGE}<script>${reportJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "hours-budget-report.js")).href}</script></body></html>`,
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

    const sections = doc.querySelectorAll("#reportSections section.card");
    expect(sections).toHaveLength(2);

    // Sections are sorted by course code; MATH1000 comes first.
    const mathHtml = sections[0].innerHTML;
    expect(mathHtml).toContain("MATH1000 — Intro Maths");
    expect(mathHtml).toContain("Budget: R1000.00");
    expect(mathHtml).toContain("partial — some tutors have no hourly rate set");
    expect(mathHtml).toContain("R750.00"); // 1000 budget − 250 spent
    expect(mathHtml).toContain("Unknown tutor"); // null tutorName row
    expect(mathHtml).toContain("—"); // null hourly rate / cost
    expect(mathHtml).toContain("2.5 hrs");

    const physHtml = sections[1].innerHTML;
    expect(physHtml).toContain("(over budget)"); // 100 budget, 250 spent
    expect(physHtml).toContain("stat-value--attention");

    expect(doc.getElementById("emptyCopy").hidden).toBe(true);
    expect(doc.getElementById("unlinkedWarning").hidden).toBe(false);
    expect(doc.getElementById("unlinkedWarning").textContent).toContain(
      "3.5 hrs across 2 entries",
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
