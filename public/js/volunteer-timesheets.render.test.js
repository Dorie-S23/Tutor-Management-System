// volunteer-timesheets.js groups hour entries by month + module and renders
// them. Worth covering directly after timesheets moved from weekly to
// monthly periods — the reported bug shape here was a week-range label.
// Loads the real storage.js + volunteer-timesheets.js sources into jsdom,
// the same way storage.test.js does, stubbing only the network and nav.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const rawStorageJs = fs.readFileSync(
  path.join(__dirname, "storage.js"),
  "utf8",
);
const storageJsUrl = pathToFileURL(path.join(__dirname, "storage.js")).href;
const volunteerJsUrl = pathToFileURL(
  path.join(__dirname, "volunteer-timesheets.js"),
).href;
// The identical newline-free shadow line storage.test.js prepends to its
// eval'd copy of storage.js — Jest's v8 coverage only merges the two
// suites' copies cleanly when their text layouts match.
const shadowWindow = `var __fakeLocation = { href: "" }; const window = { location: __fakeLocation }; `;
const rawVolunteerJs = fs
  .readFileSync(path.join(__dirname, "volunteer-timesheets.js"), "utf8")
  // `export` isn't valid inside dom.window.eval (classic script semantics).
  .replace(/^import .*$/gm, "");

const ENTRIES = [
  {
    id: "e1",
    date: "2026-08-31",
    hours: 2,
    taskType: "Peer support",
    subject: "COMS1018A",
  },
  {
    id: "e2",
    date: "2026-09-01",
    hours: 1.5,
    taskType: "Peer support",
    subject: "COMS1018A",
  },
  {
    id: "e3",
    date: "2026-09-30",
    hours: 2.5,
    taskType: "Peer support",
    subject: "APPM2021",
  },
  {
    id: "e4",
    date: "2026-10-01",
    hours: 3,
    taskType: "Peer support",
    subject: "COMS1018A",
  },
];

function renderPage(entries) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="timesheetList"></div></body></html>',
    {
      url: "http://localhost/volunteer-timesheets.html",
      runScripts: "dangerously",
      beforeParse(window) {
        window.fetch = () =>
          Promise.resolve({
            ok: true,
            json: async () =>
              entries.map((e) => ({
                id: e.id,
                date: e.date,
                hours: e.hours,
                start_time: "",
                end_time: "",
                task_type: e.taskType,
                subject: e.subject,
                notes: "",
              })),
          });
        window.sessionStorage.setItem(
          "user",
          JSON.stringify({ id: "v1", role: "volunteer" }),
        );
      },
    },
  );

  const storageJs = rawStorageJs.replace(
    /^export (async function|function)/gm,
    "$1",
  );
  // highlightActiveTab is the one thing not worth loading nav.js for.
  dom.window.highlightActiveTab = function () {};
  // One sourceURL per eval so each file's coverage lands on its own lines
  // (both evaluate in the window's global scope, so they still share
  // bindings across the two calls).
  dom.window.eval(`${shadowWindow}${storageJs}\n//# sourceURL=${storageJsUrl}`);
  dom.window.eval(`${rawVolunteerJs}\n//# sourceURL=${volunteerJsUrl}`);

  return dom.window;
}

describe("volunteer timesheets render", () => {
  test("groups entries by calendar month + module and labels them with month names", async () => {
    const window = renderPage(ENTRIES);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = [...window.document.querySelectorAll(".timesheet-row")].map(
      (row) => ({
        course: row.querySelector(".timesheet-course").textContent,
        month: row.querySelector(".timesheet-week").textContent,
        hours: row.querySelector(".timesheet-hours").textContent,
      }),
    );

    // One row per (month, module), sorted by month then module: the 31 Aug
    // entry stays in its own August row rather than joining September.
    expect(rows).toEqual([
      { course: "COMS1018A", month: "August 2026", hours: "2h" },
      { course: "APPM2021", month: "September 2026", hours: "2.5h" },
      { course: "COMS1018A", month: "September 2026", hours: "1.5h" },
      { course: "COMS1018A", month: "October 2026", hours: "3h" },
    ]);
  });
});
