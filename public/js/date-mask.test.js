// date-mask.js is a plain browser IIFE (no imports/exports), so it runs
// as-is inside a real jsdom document via runScripts: "dangerously" — same
// pattern as the rest of this suite's frontend tests.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const src = fs.readFileSync(path.join(__dirname, "date-mask.js"), "utf8");

function withDom(bodyHtml, fn) {
  const dom = new JSDOM(
    `<body>${bodyHtml}\n<script>${src}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "date-mask.js")).href}</script></body>`,
    {
      url: "http://localhost/html/calendar.html",
      runScripts: "dangerously",
    },
  );
  return fn(dom.window);
}

// The field people type into is inserted just before the native input.
function typed(doc, id) {
  return doc.getElementById(`${id}-typed`);
}

// One keystroke's aftermath: the browser has already written the new text
// into the field and fired input for the page code to react to.
function type(window, field, raw) {
  field.value = raw;
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function tick(window) {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("date-mask", () => {
  test("turns a date picker into a dd/mm/yyyy field while the native input keeps the ISO value", async () => {
    await withDom(
      `<form>
        <label for="rangeFrom">From</label>
        <input type="date" id="rangeFrom" value="2026-01-15" />
      </form>`,
      (window) => {
        const doc = window.document;
        const native = doc.getElementById("rangeFrom");
        const field = typed(doc, "rangeFrom");

        expect(field).not.toBeNull();
        expect(field.type).toBe("text");
        expect(field.placeholder).toBe("dd/mm/yyyy");
        expect(field.getAttribute("inputmode")).toBe("numeric");
        expect(field.value).toBe("15/01/2026");

        // The typed field sits directly before the hidden native input.
        expect(field.nextElementSibling).toBe(native);
        expect(native.classList.contains("date-mask-native")).toBe(true);
        expect(native.tabIndex).toBe(-1);
        expect(native.getAttribute("aria-hidden")).toBe("true");

        // The label now points at what people actually type into.
        expect(doc.querySelector("label").htmlFor).toBe(field.id);
      },
    );
  });

  test("auto-inserts slashes as each segment completes", async () => {
    await withDom(`<input type="date" id="rangeFrom" />`, (window) => {
      const doc = window.document;
      const native = doc.getElementById("rangeFrom");
      const field = typed(doc, "rangeFrom");

      type(window, field, "1");
      expect(field.value).toBe("1");

      type(window, field, "15");
      expect(field.value).toBe("15/");

      type(window, field, "15/0");
      expect(field.value).toBe("15/0");

      type(window, field, "15/01");
      expect(field.value).toBe("15/01/");

      // Still typing the year: nothing lands on the native input yet.
      type(window, field, "15/01/2");
      expect(field.value).toBe("15/01/2");
      expect(native.value).toBe("");

      type(window, field, "15/01/2026");
      expect(field.value).toBe("15/01/2026");
      expect(native.value).toBe("2026-01-15");
    });
  });

  test("completes one-digit days and months as they are typed", async () => {
    await withDom(`<input type="date" id="date" />`, (window) => {
      const doc = window.document;
      const field = typed(doc, "date");

      // "4" can't start a two-digit day, so the day is done and the mask has
      // already moved on by itself.
      type(window, field, "4");
      expect(field.value).toBe("04/");

      type(window, field, "04/5");
      expect(field.value).toBe("04/05/");

      type(window, field, "04/05/2026");
      expect(field.value).toBe("04/05/2026");
      expect(doc.getElementById("date").value).toBe("2026-05-04");
    });
  });

  test("backspace unwinds through the auto-inserted slashes", async () => {
    await withDom(`<input type="date" id="date" />`, (window) => {
      const doc = window.document;
      const field = typed(doc, "date");
      type(window, field, "15/01/2026");

      // Deleting the year, keystroke by keystroke.
      type(window, field, "15/01/202");
      expect(field.value).toBe("15/01/202");
      type(window, field, "15/01/20");
      type(window, field, "15/01/2");
      type(window, field, "15/01/");
      expect(field.value).toBe("15/01/");

      // The next backspace eats the slash — the day's last digit goes with
      // it, so deleting never gets stuck on a separator.
      type(window, field, "15/01");
      expect(field.value).toBe("15/0");

      type(window, field, "15/");
      expect(field.value).toBe("15/");

      type(window, field, "15");
      expect(field.value).toBe("1");

      type(window, field, "");
      expect(field.value).toBe("");
    });
  });

  test("reports the ISO value and fires input/change once the date is real", async () => {
    await withDom(`<input type="date" id="date" />`, (window) => {
      const doc = window.document;
      const native = doc.getElementById("date");
      const field = typed(doc, "date");
      const events = [];
      native.addEventListener("input", () => events.push("input"));
      native.addEventListener("change", () => events.push("change"));

      type(window, field, "20/01/2026");
      expect(native.value).toBe("2026-01-20");
      expect(events).toEqual(["input", "change"]);

      // Editing a complete date back into a partial one clears the value
      // again, exactly like the native picker does.
      type(window, field, "20/01/202");
      expect(native.value).toBe("");
      expect(events).toEqual(["input", "change", "input", "change"]);
    });
  });

  test("rejects impossible dates instead of storing them", async () => {
    await withDom(
      `<form><input type="date" id="fromDate" required /></form>`,
      (window) => {
        const doc = window.document;
        const native = doc.getElementById("fromDate");
        const field = typed(doc, "fromDate");
        const form = doc.querySelector("form");

        type(window, field, "31/02/2026");
        expect(native.value).toBe("");
        expect(field.validationMessage).toMatch(/doesn't exist/);
        expect(field.getAttribute("aria-invalid")).toBe("true");
        expect(form.checkValidity()).toBe(false);

        // A real leap day passes; the same day a year later doesn't.
        type(window, field, "29/02/2024");
        expect(native.value).toBe("2024-02-29");
        expect(field.getAttribute("aria-invalid")).toBeNull();
        expect(form.checkValidity()).toBe(true);

        type(window, field, "29/02/2026");
        expect(native.value).toBe("");
        expect(form.checkValidity()).toBe(false);
      },
    );
  });

  test("moves required/min onto the typed field so validation has a visible target", async () => {
    await withDom(
      `<form><input type="date" id="add-class-date" required min="2026-01-15" /></form>`,
      async (window) => {
        const doc = window.document;
        const native = doc.getElementById("add-class-date");
        const field = typed(doc, "add-class-date");
        const form = doc.querySelector("form");

        // Page scripts still see the constraints on the native element…
        expect(native.required).toBe(true);
        expect(native.min).toBe("2026-01-15");
        // …but the hidden input can never be the one that blocks submission.
        expect(native.hasAttribute("required")).toBe(false);
        expect(native.hasAttribute("min")).toBe(false);

        expect(field.required).toBe(true);
        expect(form.checkValidity()).toBe(false); // empty and required

        type(window, field, "10/01/2026");
        expect(field.validationMessage).toMatch(/can't be before 15\/01\/2026/);
        expect(form.checkValidity()).toBe(false);

        type(window, field, "15/01/2026");
        expect(field.validationMessage).toBe("");
        expect(form.checkValidity()).toBe(true);

        // Dynamic updates keep working, e.g. the repeat-until field.
        native.min = "2026-02-01";
        expect(field.validationMessage).toMatch(/can't be before 01\/02\/2026/);

        // setAttribute()-style updates take the same path.
        native.setAttribute("min", "2026-06-01");
        await tick(window);
        expect(field.validationMessage).toMatch(/can't be before 01\/06\/2026/);
        expect(native.hasAttribute("min")).toBe(false);

        native.required = false;
        native.min = "";
        expect(field.required).toBe(false);
        expect(field.validationMessage).toBe("");
      },
    );
  });

  test("page scripts keep reading and writing the ISO value", async () => {
    await withDom(`<input type="date" id="date" />`, (window) => {
      const doc = window.document;
      const native = doc.getElementById("date");
      const field = typed(doc, "date");
      const events = [];
      native.addEventListener("change", () => events.push("change"));

      native.value = "2026-09-03";
      expect(native.value).toBe("2026-09-03");
      expect(field.value).toBe("03/09/2026");

      native.value = "";
      expect(field.value).toBe("");
      // Programmatic writes stay silent, as they do on a native input.
      expect(events).toEqual([]);
    });
  });

  test("readonly fields stay read-only but still show dd/mm/yyyy", async () => {
    await withDom(
      `<input type="date" id="date" required readonly value="2026-01-15" />`,
      (window) => {
        const doc = window.document;
        const field = typed(doc, "date");
        expect(field.readOnly).toBe(true);
        expect(field.value).toBe("15/01/2026");
        expect(field.classList.contains("date-mask-input")).toBe(true);
      },
    );
  });

  test("month fields mask as mm/yyyy", async () => {
    await withDom(`<input type="month" id="submitMonth" />`, (window) => {
      const doc = window.document;
      const native = doc.getElementById("submitMonth");
      const field = typed(doc, "submitMonth");

      expect(field.placeholder).toBe("mm/yyyy");

      type(window, field, "9");
      expect(field.value).toBe("09/");

      type(window, field, "09/2");
      expect(field.value).toBe("09/2");

      type(window, field, "09/2026");
      expect(field.value).toBe("09/2026");
      expect(native.value).toBe("2026-09");

      type(window, field, "13/2026");
      expect(native.value).toBe("");
      expect(field.validationMessage).toMatch(/month doesn't exist/);
    });
  });

  test("the slash key commits a one-digit segment", async () => {
    await withDom(`<input type="date" id="date" />`, (window) => {
      const doc = window.document;
      const field = typed(doc, "date");

      type(window, field, "1");
      const handled = field.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "/", cancelable: true }),
      );
      expect(handled).toBe(false); // prevented — the mask inserts it itself
      expect(field.value).toBe("01/");

      type(window, field, "15/1");
      field.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "/", cancelable: true }),
      );
      expect(field.value).toBe("15/01/");
    });
  });

  test("focus aimed at the hidden input lands on the typed field", async () => {
    await withDom(`<input type="date" id="date" />`, (window) => {
      const doc = window.document;
      doc.getElementById("date").focus();
      expect(doc.activeElement).toBe(typed(doc, "date"));
    });
  });

  test("a form reset clears the typed text too", async () => {
    await withDom(
      `<form id="entry-form"><input type="date" id="date" /></form>`,
      async (window) => {
        const doc = window.document;
        const native = doc.getElementById("date");
        const field = typed(doc, "date");

        native.value = "2026-01-15";
        expect(field.value).toBe("15/01/2026");

        doc.getElementById("entry-form").reset();
        await tick(window);
        expect(native.value).toBe("");
        expect(field.value).toBe("");
      },
    );
  });

  test("a pasted ISO date lands in the right segments", async () => {
    await withDom(`<input type="date" id="date" />`, (window) => {
      const doc = window.document;
      const field = typed(doc, "date");

      type(window, field, "2026-01-15");
      expect(field.value).toBe("15/01/2026");
      expect(doc.getElementById("date").value).toBe("2026-01-15");
    });
  });

  test("turns a time picker into an hh:mm field while the native input keeps HH:MM", async () => {
    await withDom(
      `<form>
        <label for="startTime">Start</label>
        <input type="time" id="startTime" value="14:30" />
      </form>`,
      (window) => {
        const doc = window.document;
        const native = doc.getElementById("startTime");
        const field = typed(doc, "startTime");

        expect(field).not.toBeNull();
        expect(field.placeholder).toBe("hh:mm");
        expect(field.maxLength).toBe(5);
        expect(field.value).toBe("14:30");
        expect(doc.querySelector("label").htmlFor).toBe(field.id);

        native.value = "09:05";
        expect(field.value).toBe("09:05");
        native.value = "";
        expect(field.value).toBe("");
      },
    );
  });

  test("auto-inserts the colon as the time is typed", async () => {
    await withDom(`<input type="time" id="startTime" />`, (window) => {
      const doc = window.document;
      const native = doc.getElementById("startTime");
      const field = typed(doc, "startTime");

      type(window, field, "1");
      expect(field.value).toBe("1");

      type(window, field, "14");
      expect(field.value).toBe("14:");

      type(window, field, "14:3");
      expect(field.value).toBe("14:3");

      // Still typing the minutes: nothing lands on the native input yet.
      expect(native.value).toBe("");

      type(window, field, "14:30");
      expect(field.value).toBe("14:30");
      expect(native.value).toBe("14:30");
    });
  });

  test("completes one-digit hours and minutes as they are typed", async () => {
    await withDom(`<input type="time" id="startTime" />`, (window) => {
      const doc = window.document;
      const field = typed(doc, "startTime");

      // "9" can't start a two-digit hour, so the mask has already moved on.
      type(window, field, "9");
      expect(field.value).toBe("09:");

      type(window, field, "09:3");
      expect(field.value).toBe("09:3");

      type(window, field, "09:30");
      expect(field.value).toBe("09:30");
      expect(doc.getElementById("startTime").value).toBe("09:30");

      // A first minute digit of 6-9 can only be one digit too.
      type(window, field, "14");
      expect(field.value).toBe("14:");
      type(window, field, "147");
      expect(field.value).toBe("14:07");
    });
  });

  test("backspace unwinds through the auto-inserted colon", async () => {
    await withDom(`<input type="time" id="startTime" />`, (window) => {
      const doc = window.document;
      const field = typed(doc, "startTime");
      type(window, field, "14:30");

      type(window, field, "14:3");
      expect(field.value).toBe("14:3");

      type(window, field, "14:");
      expect(field.value).toBe("14:");

      // The next backspace eats the colon — the hour's last digit goes
      // with it, so deleting never gets stuck on a separator.
      type(window, field, "14");
      expect(field.value).toBe("1");

      type(window, field, "");
      expect(field.value).toBe("");
    });
  });

  test("rejects impossible times and keeps min/max on the typed field", async () => {
    await withDom(
      `<form><input type="time" id="startTime" required min="08:00" max="16:30" /></form>`,
      (window) => {
        const doc = window.document;
        const native = doc.getElementById("startTime");
        const field = typed(doc, "startTime");
        const form = doc.querySelector("form");

        // The hidden native can never be the one that blocks submission.
        expect(native.required).toBe(true);
        expect(native.min).toBe("08:00");
        expect(native.hasAttribute("min")).toBe(false);
        expect(field.required).toBe(true);

        type(window, field, "25:00");
        expect(native.value).toBe("");
        expect(field.validationMessage).toMatch(/time doesn't exist/);
        expect(form.checkValidity()).toBe(false);

        type(window, field, "07:30");
        expect(field.validationMessage).toMatch(/can't be before 08:00/);

        type(window, field, "17:00");
        expect(field.validationMessage).toMatch(/can't be after 16:30/);

        type(window, field, "09:15");
        expect(native.value).toBe("09:15");
        expect(field.validationMessage).toBe("");
        expect(form.checkValidity()).toBe(true);
      },
    );
  });

  test("the colon key commits a one-digit segment", async () => {
    await withDom(`<input type="time" id="startTime" />`, (window) => {
      const doc = window.document;
      const field = typed(doc, "startTime");

      type(window, field, "2");
      const handled = field.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: ":", cancelable: true }),
      );
      expect(handled).toBe(false); // prevented — the mask pads it itself
      expect(field.value).toBe("02:");
    });
  });

  test("a pasted time lands in the right segments", async () => {
    await withDom(`<input type="time" id="startTime" />`, (window) => {
      const doc = window.document;
      const field = typed(doc, "startTime");

      // "14:30" parses the same either way, but "2:30" must not slide
      // into "23:0" — the paste path pads the hour first.
      type(window, field, "2:30");
      expect(field.value).toBe("02:30");
      expect(doc.getElementById("startTime").value).toBe("02:30");

      type(window, field, "14:30");
      expect(field.value).toBe("14:30");
      expect(doc.getElementById("startTime").value).toBe("14:30");
    });
  });
});
