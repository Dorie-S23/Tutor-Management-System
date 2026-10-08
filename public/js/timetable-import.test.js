// timetable-import.js wires timetable.html's import flow: parse a chosen
// PDF through timetable-parser.js, let the user review/edit the recognised
// classes, then save them to the schedule. Its two imports are replaced
// with stubs appended after the real source (later function declarations
// win in the same eval scope) — pdf.js/Tesseract can't run here and
// addScheduleClasses would hit the API — while all of the page's own
// wiring, rendering, and validation runs for real inside jsdom, with the
// //# sourceURL tag so Jest's v8 coverage attributes the lines back to the
// real file.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const rawImportJs = fs.readFileSync(
  path.join(__dirname, "timetable-import.js"),
  "utf8",
);

const STUBS = `
function addScheduleClasses(classes) {
  window.__addedClasses = classes;
}
function parseTimetablePdf(file, onProgress) {
  window.__parseCalls = (window.__parseCalls || 0) + 1;
  if (window.__parseResult instanceof Error) {
    return Promise.reject(window.__parseResult);
  }
  onProgress?.("Reading timetable…");
  return Promise.resolve(window.__parseResult || []);
}
function firstOccurrenceOnOrAfter(startDateStr, dayOfWeek) {
  window.__firstOccurrenceCalls = (window.__firstOccurrenceCalls || 0) + 1;
  return window.__firstDate;
}
`;

const PAGE = `
  <input type="file" id="timetable-file">
  <p id="timetable-file-name" hidden></p>
  <input type="date" id="semester-start">
  <input type="date" id="semester-end">
  <button id="parse-timetable-btn"></button>
  <p id="timetable-status" hidden></p>
  <section id="timetable-review" hidden>
    <table><tbody id="timetable-review-body"></tbody></table>
  </section>
  <button id="save-timetable-btn"></button>
  <button id="cancel-timetable-btn"></button>
`;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const CLASS_A = {
  title: "MATH2000",
  dayName: "Monday",
  dayOfWeek: 1,
  startTime: "09:05",
  endTime: "10:00",
  venue: "WSS2",
};

const CLASS_B = {
  title: "PHYS3000",
  dayName: "Tuesday",
  dayOfWeek: 2,
  startTime: "11:00",
  endTime: "12:00",
  venue: "WSS1",
};

function loadImport({ withToast = true } = {}) {
  const importJs = rawImportJs
    .replace(/import\s*{[^}]*}\s*from\s*["']\.\/storage\.js["'];?/, "")
    .replace(
      /import\s*{[\s\S]*?}\s*from\s*["']\.\/timetable-parser\.js["'];?/,
      "",
    );

  const dom = new JSDOM(
    `<!doctype html><html><body>${withToast ? '<div id="toast"></div>' : ""}${PAGE}<script>${importJs}\n${STUBS}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "timetable-import.js")).href}</script></body></html>`,
    { url: "http://localhost/timetable.html", runScripts: "dangerously" },
  );

  return dom.window;
}

// jsdom's file inputs can't take a real file picker, so the one property
// the page reads (files[0]) gets a stand-in that the stubbed parser ignores.
function setFile(win) {
  Object.defineProperty(
    win.document.getElementById("timetable-file"),
    "files",
    { value: [{ name: "timetable.pdf" }] },
  );
}

describe("timetable-import.js", () => {
  test("asks for a file and a start date before parsing", () => {
    const win = loadImport();
    const doc = win.document;
    const parseBtn = doc.getElementById("parse-timetable-btn");
    const status = doc.getElementById("timetable-status");

    parseBtn.click();
    expect(status.textContent).toBe("Choose a PDF file first.");
    expect(status.hidden).toBe(false);
    expect(status.classList.contains("form-error")).toBe(true);

    setFile(win);
    parseBtn.click();
    expect(status.textContent).toBe(
      'Pick a "classes start on" date first — the PDF has no calendar dates of its own.',
    );
    expect(win.__parseCalls).toBeUndefined();
  });

  test("parses, reviews, edits, and adds a single class", async () => {
    const win = loadImport();
    const doc = win.document;
    win.__parseResult = [CLASS_A];
    // No usable jump date — the save path must fall back to renderCalendar.
    win.__firstDate = undefined;
    const jumpCalls = [];
    win.jumpToCalendarDate = (date) => jumpCalls.push(date);
    const renderCalls = [];
    win.renderCalendar = () => renderCalls.push(1);

    setFile(win);
    doc.getElementById("semester-start").value = "2026-09-01";
    doc.getElementById("parse-timetable-btn").click();
    await flush();

    const status = doc.getElementById("timetable-status");
    const review = doc.getElementById("timetable-review");
    expect(win.__parseCalls).toBe(1);
    expect(win.__firstOccurrenceCalls).toBe(1);
    expect(status.textContent).toBe(
      "Found 1 class — check them below before adding.",
    );
    expect(status.classList.contains("form-error")).toBe(false);
    expect(review.hidden).toBe(false);

    const row = doc.querySelector("#timetable-review-body tr");
    const checkbox = row.querySelector('input[type="checkbox"]');
    expect(checkbox.checked).toBe(true);
    expect(row.children[1].textContent).toBe("Monday (from undefined)");
    expect(row.children[2].textContent).toBe("09:05-10:00");

    // Editing the inline title/venue inputs updates the parsed class.
    const [titleInput, venueInput] = row.querySelectorAll('input[type="text"]');
    titleInput.value = "MATH2000 EDITED";
    titleInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    venueInput.value = "NEW VENUE";
    venueInput.dispatchEvent(new win.Event("input", { bubbles: true }));

    doc.getElementById("save-timetable-btn").click();
    expect(status.textContent).toBe('Pick a "repeat weekly until" date first.');

    doc.getElementById("semester-end").value = "2026-11-30";
    doc.getElementById("save-timetable-btn").click();
    await flush(); // the save waits on the server

    expect(win.__addedClasses).toEqual([
      {
        title: "MATH2000 EDITED",
        dayOfWeek: 1,
        firstDate: undefined,
        endDate: "2026-11-30",
        startTime: "09:05",
        endTime: "10:00",
        venue: "NEW VENUE",
      },
    ]);
    expect(status.textContent).toBe("Added 1 class to your calendar.");
    const toast = doc.getElementById("toast");
    expect(toast.textContent).toBe("Added 1 class to your calendar.");
    expect(toast.classList.contains("show")).toBe(true);
    expect(review.hidden).toBe(true);
    expect(renderCalls).toHaveLength(1);
    expect(jumpCalls).toHaveLength(0);

    // Cancelling just hides the review section again.
    review.hidden = false;
    doc.getElementById("cancel-timetable-btn").click();
    expect(review.hidden).toBe(true);

    win.close();
  });

  test("requires a selection, adds several classes, and jumps to the calendar", async () => {
    const win = loadImport({ withToast: false });
    const doc = win.document;
    win.__parseResult = [CLASS_A, CLASS_B];
    win.__firstDate = "2026-09-07";
    const jumpCalls = [];
    win.jumpToCalendarDate = (date) => jumpCalls.push(date);

    setFile(win);
    doc.getElementById("semester-start").value = "2026-09-01";
    doc.getElementById("parse-timetable-btn").click();
    await flush();

    const status = doc.getElementById("timetable-status");
    expect(status.textContent).toBe(
      "Found 2 classes — check them below before adding.",
    );

    const checkboxes = [
      ...doc.querySelectorAll('#timetable-review-body input[type="checkbox"]'),
    ];
    expect(checkboxes).toHaveLength(2);

    checkboxes.forEach((cb) => {
      cb.checked = false;
    });
    doc.getElementById("semester-end").value = "2026-11-30";
    doc.getElementById("save-timetable-btn").click();
    expect(status.textContent).toBe("Select at least one class to add.");

    checkboxes.forEach((cb) => {
      cb.checked = true;
    });
    doc.getElementById("save-timetable-btn").click();
    await flush(); // the save waits on the server

    expect(win.__addedClasses).toHaveLength(2);
    expect(win.__addedClasses[1].title).toBe("PHYS3000");
    expect(status.textContent).toBe("Added 2 classes to your calendar.");
    // Both classes picked the same earliest date — the page jumps there.
    // (No toast element exists on this page; the save must still complete.)
    expect(jumpCalls).toEqual(["2026-09-07"]);
  });

  test("reports when no classes could be recognised", async () => {
    const win = loadImport();
    const doc = win.document;
    win.__parseResult = [];

    setFile(win);
    doc.getElementById("semester-start").value = "2026-09-01";
    doc.getElementById("parse-timetable-btn").click();
    await flush();

    const status = doc.getElementById("timetable-status");
    expect(status.textContent).toBe(
      "No classes could be recognised in this PDF — you may need to add them manually.",
    );
    expect(status.classList.contains("form-error")).toBe(true);
    expect(doc.getElementById("timetable-review").hidden).toBe(true);
  });

  test("surfaces parse failures and re-enables the button", async () => {
    const win = loadImport();
    const doc = win.document;
    const parseBtn = doc.getElementById("parse-timetable-btn");
    const status = doc.getElementById("timetable-status");

    setFile(win);
    doc.getElementById("semester-start").value = "2026-09-01";

    win.__parseResult = new win.Error("boom");
    parseBtn.click();
    await flush();
    expect(status.textContent).toBe("boom");
    expect(status.classList.contains("form-error")).toBe(true);
    expect(parseBtn.disabled).toBe(false);

    // An error with no message falls back to the generic copy.
    win.__parseResult = new win.Error("");
    parseBtn.click();
    await flush();
    expect(status.textContent).toBe("Could not read that PDF.");
  });

  test("shows the chosen file name under the drop zone", () => {
    const win = loadImport();
    const doc = win.document;
    const fileInput = doc.getElementById("timetable-file");
    const fileName = doc.getElementById("timetable-file-name");

    expect(fileName.hidden).toBe(true);
    fileInput.dispatchEvent(new win.Event("change"));
    expect(fileName.hidden).toBe(true);

    setFile(win);
    fileInput.dispatchEvent(new win.Event("change"));
    expect(fileName.hidden).toBe(false);
    expect(fileName.textContent).toBe("Selected: timetable.pdf");
  });

  test("marks the parse button busy while the AI reads the PDF", async () => {
    const win = loadImport();
    const doc = win.document;
    const parseBtn = doc.getElementById("parse-timetable-btn");
    win.__parseResult = [CLASS_A];

    setFile(win);
    doc.getElementById("semester-start").value = "2026-09-01";
    parseBtn.click();

    expect(parseBtn.disabled).toBe(true);
    expect(parseBtn.classList.contains("is-loading")).toBe(true);
    expect(parseBtn.getAttribute("aria-busy")).toBe("true");
    expect(parseBtn.textContent).toBe("Parsing…");

    await flush();

    expect(parseBtn.disabled).toBe(false);
    expect(parseBtn.classList.contains("is-loading")).toBe(false);
    expect(parseBtn.hasAttribute("aria-busy")).toBe(false);
    expect(parseBtn.textContent).toBe("Parse PDF");
  });
});
