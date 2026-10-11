// tutors.js is the organiser's manage-tutors page: the add/edit form with
// client-side validation, the edit and delete flows, the global weekly cap,
// the per-level rates panel, and the workload spread with its stat tiles.
// Loads the real tutors.html and swaps the script tag for an inline copy
// (the my-sessions suite pattern), stubbing fetch, confirm and the
// smooth-scroll the deep-link highlight performs.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const html = fs.readFileSync(
  path.join(__dirname, "..", "html", "tutors.html"),
  "utf8",
);
const scriptSrc = fs.readFileSync(path.join(__dirname, "tutors.js"), "utf8");
const scriptUrl = pathToFileURL(path.join(__dirname, "tutors.js")).href;

const TUTORS = [
  {
    id: "t1",
    name: "Ada Lovelace",
    student_number: "2012345",
    email: "ada@wits.ac.za",
    academic_level: "honours",
    hourly_rate: 150,
  },
  {
    id: "t2",
    name: "Grace Hopper",
    student_number: "2098765",
    email: "grace@students.wits.ac.za",
    academic_level: "phd",
    hourly_rate: null,
  },
];

const WORKLOAD = [
  {
    name: "Ada Lovelace",
    assignedHours: 6,
    courses: [
      { course_code: "COMS1016A", hours_per_week: 3 },
      { course_code: "MATH2001", hours_per_week: 3 },
    ],
  },
  { name: "Grace Hopper", assignedHours: 2, courses: [] },
];

const RATES = { third_year: 125, honours: 155, masters: 175, phd: 210 };

function loadPage({
  tutors = TUTORS,
  workload = WORKLOAD,
  rates = RATES,
  tutorsFail = false,
  ratesFail = false,
  storedCap = null,
  url = "http://localhost/tutors.html",
} = {}) {
  // tutors.js is the end-of-body page script; the page's other scripts
  // (theme, nav-menu, universal search, notifications) aren't part of this
  // suite, so every external script tag is stripped and tutors.js goes back
  // in inline, with a sourceURL so v8 coverage lands on the real file.
  const pageHtml = html
    .replace(/<script[^>]*src="\.\.\/js\/[^"]*"[^>]*><\/script>/g, "")
    .replace(
      "</body>",
      `<script>${scriptSrc}\n//# sourceURL=${scriptUrl}</script></body>`,
    );

  const calls = [];

  const dom = new JSDOM(pageHtml, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      if (storedCap !== null) {
        window.localStorage.setItem("tms_global_weekly_cap", String(storedCap));
      }
      window.confirm = () => true;
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.fetch = async (fetchUrl, options = {}) => {
        const href = String(fetchUrl);
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url: href, method: options.method || "GET", body });
        const path_ = href.split("?")[0];

        if (path_ === "/api/tutors/workload") {
          return { ok: true, json: async () => workload };
        }
        if (path_ === "/api/tutors/rates") {
          if (ratesFail) throw new Error("network down");
          return { ok: true, json: async () => rates };
        }
        if (path_ === "/api/tutors/bulk") {
          return { ok: true, json: async () => ({ updated: tutors.length }) };
        }
        if (path_ === "/api/tutors/bulk-rates") {
          return { ok: true, json: async () => ({ updated: 4 }) };
        }
        if (path_ === "/api/tutors") {
          if (!options.method) {
            if (tutorsFail) {
              return { ok: false, json: async () => ({ error: "boom" }) };
            }
            return { ok: true, json: async () => tutors };
          }
        }
        // Create/update/delete echoes the submitted name for the toast.
        return {
          ok: true,
          json: async () => ({ name: (body && body.name) || "Tutor" }),
        };
      };
    },
  });

  return { window: dom.window, document: dom.window.document, calls };
}

const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

const submit = (window, document) =>
  document
    .getElementById("tutorForm")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );

const fillForm = (document, { name, studentNumber, email, level }) => {
  document.getElementById("name").value = name;
  document.getElementById("studentNumber").value = studentNumber;
  document.getElementById("email").value = email;
  document.getElementById("academicLevel").value = level;
};

describe("tutors.js", () => {
  test("boots the table, workload spread and stat tiles from the API", async () => {
    const { document } = loadPage();
    await wait();

    const rows = document.querySelectorAll("#tutorsTableBody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Ada Lovelace");
    expect(rows[0].textContent).toContain("Honours");
    expect(rows[0].querySelector(".tutor-rate-badge").textContent).toBe(
      "R150/h",
    );
    // No hourly rate yet — the cell reads as an em dash, not a badge.
    expect(rows[1].querySelector(".tutor-rate-badge")).toBeNull();
    expect(document.getElementById("emptyCopy").hidden).toBe(true);

    // Busiest tutor first; 6 of the default 6-hour cap warns, 2 of 6 is calm.
    const workloadRows = document.querySelectorAll(".workload-row");
    expect(workloadRows[0].querySelector(".workload-name").textContent).toBe(
      "Ada Lovelace",
    );
    expect(
      workloadRows[0]
        .querySelector(".workload-bar-fill")
        .classList.contains("warn"),
    ).toBe(true);
    expect(workloadRows[0].querySelector(".workload-hours").textContent).toBe(
      "100% 6 / 6 hrs",
    );
    expect(workloadRows[0].title).toBe("COMS1016A (3h), MATH2001 (3h)");
    expect(workloadRows[1].querySelector(".workload-bar-fill").className).toBe(
      "workload-bar-fill ",
    );
    expect(workloadRows[1].title).toBe("No approved courses");

    expect(document.getElementById("statTutorCount").textContent).toBe("2");
    expect(document.getElementById("statTotalHours").textContent).toBe("8h");
    // Only Ada has a rate yet.
    expect(document.getElementById("statAvgRate").textContent).toBe("R150/h");
    expect(document.getElementById("statNearCap").textContent).toBe("1");
  });

  test("a stored weekly cap drives the workload bars, cap field and near-cap stat", async () => {
    const { document } = loadPage({ storedCap: 4 });
    await wait();

    expect(document.getElementById("globalWeeklyCap").value).toBe("4");
    // 6 of a 4-hour cap is over the line: blocked, and reported over 100%.
    const workloadRows = document.querySelectorAll(".workload-row");
    expect(
      workloadRows[0]
        .querySelector(".workload-bar-fill")
        .classList.contains("blocked"),
    ).toBe(true);
    expect(workloadRows[0].querySelector(".workload-hours").textContent).toBe(
      "150% 6 / 4 hrs",
    );
    expect(document.getElementById("statNearCap").textContent).toBe("1");
  });

  test("a failed tutors load toasts the server's error", async () => {
    const { document } = loadPage({ tutorsFail: true });
    await wait();

    expect(document.getElementById("toast").textContent).toBe("boom");
    expect(document.querySelectorAll("#tutorsTableBody tr")).toHaveLength(0);
  });

  test("the rates panel falls back to built-in defaults when the API is down", async () => {
    const { document } = loadPage({ ratesFail: true });
    await wait();

    const values = {};
    document.querySelectorAll(".rate-input").forEach((input) => {
      values[input.dataset.level] = input.value;
    });
    expect(values).toEqual({
      third_year: "120",
      honours: "150",
      masters: "170",
      phd: "200",
    });
  });

  test("saving rates posts every level, clamping negatives to zero", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    document.querySelector('.rate-input[data-level="honours"]').value = "-5";
    document.getElementById("saveRatesBtn").click();
    await wait();

    const post = calls.find(
      (c) => c.url === "/api/tutors/bulk-rates" && c.method === "POST",
    );
    expect(post.body).toEqual({
      rates: { third_year: 125, honours: 0, masters: 175, phd: 210 },
    });
    expect(document.getElementById("toast").textContent).toBe(
      "Rates saved for 4 levels.",
    );
    expect(document.getElementById("saveRatesBtn").disabled).toBe(false);
  });

  test.each([
    [
      "every field empty → the level prompt (the last error) shows",
      { name: "", studentNumber: "", email: "", level: "" },
      "Please select an academic level.",
    ],
    [
      "a one-character name is too short",
      {
        name: "A",
        studentNumber: "2033344",
        email: "v@wits.ac.za",
        level: "honours",
      },
      "Name must be at least 2 characters.",
    ],
    [
      "a 3-digit student number is too short",
      {
        name: "Valid Tutor",
        studentNumber: "123",
        email: "v@wits.ac.za",
        level: "honours",
      },
      "Student number must be 5–10 digits.",
    ],
    [
      "a non-Wits email is rejected",
      {
        name: "Valid Tutor",
        studentNumber: "2033344",
        email: "x@gmail.com",
        level: "honours",
      },
      "Email must end with @wits.ac.za or @students.wits.ac.za.",
    ],
  ])("validation: %s", async (_label, fields, message) => {
    const { window, document, calls } = loadPage();
    await wait();

    fillForm(document, fields);
    submit(window, document);

    expect(document.getElementById("toast").textContent).toBe(message);
    expect(calls.some((c) => c.method === "POST" || c.method === "PUT")).toBe(
      false,
    );
  });

  test("a valid submission POSTs the tutor with the weekly cap and reloads", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    fillForm(document, {
      name: "New Tutor",
      studentNumber: "2033344",
      email: "new@wits.ac.za",
      level: "honours",
    });
    submit(window, document);
    await wait();

    const post = calls.find(
      (c) => c.method === "POST" && c.url === "/api/tutors",
    );
    expect(post.body).toEqual({
      name: "New Tutor",
      student_number: "2033344",
      email: "new@wits.ac.za",
      academic_level: "honours",
      weekly_hour_cap: 6,
    });
    expect(document.getElementById("toast").textContent).toBe(
      "Added New Tutor",
    );
    // The form is back in add mode with cleared fields.
    expect(document.getElementById("submitBtn").textContent).toContain(
      "Add tutor",
    );
    expect(document.getElementById("tutorId").value).toBe("");
    expect(document.getElementById("name").value).toBe("");
  });

  test("Edit fills the form and a resubmit PUTs, skipping client validation", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    document
      .querySelector('tr[data-tutor-id="t2"] [data-action="edit"]')
      .click();
    expect(document.getElementById("tutorId").value).toBe("t2");
    expect(document.getElementById("name").value).toBe("Grace Hopper");
    expect(document.getElementById("academicLevel").value).toBe("phd");
    expect(document.getElementById("submitBtn").textContent).toContain(
      "Save changes",
    );
    expect(document.getElementById("cancelEditBtn").hidden).toBe(false);

    // Editing skips the create-time validation: a cleared email is fine.
    document.getElementById("email").value = "";
    submit(window, document);
    await wait();

    const put = calls.find(
      (c) => c.method === "PUT" && c.url === "/api/tutors/t2",
    );
    expect(put.body.email).toBeNull();
    expect(put.body.weekly_hour_cap).toBe(6);
    expect(document.getElementById("toast").textContent).toBe(
      "Updated Grace Hopper",
    );
  });

  test("Cancel abandons the edit and restores add mode", async () => {
    const { document } = loadPage();
    await wait();

    document
      .querySelector('tr[data-tutor-id="t1"] [data-action="edit"]')
      .click();
    document.getElementById("cancelEditBtn").click();

    expect(document.getElementById("tutorId").value).toBe("");
    expect(document.getElementById("name").value).toBe("");
    expect(document.getElementById("submitBtn").textContent).toContain(
      "Add tutor",
    );
    expect(document.getElementById("cancelEditBtn").hidden).toBe(true);
  });

  test("delete confirms first, then removes and refreshes", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    window.confirm = () => false;
    document
      .querySelector('tr[data-tutor-id="t2"] [data-action="delete"]')
      .click();
    await wait();
    expect(
      calls.some((c) => c.method === "DELETE" && c.url === "/api/tutors/t2"),
    ).toBe(false);

    window.confirm = () => true;
    document
      .querySelector('tr[data-tutor-id="t1"] [data-action="delete"]')
      .click();
    await wait();
    expect(
      calls.some((c) => c.method === "DELETE" && c.url === "/api/tutors/t1"),
    ).toBe(true);
    expect(document.getElementById("toast").textContent).toBe(
      "Removed Ada Lovelace",
    );
  });

  test("the weekly cap validates, clamps to 6, and applies to every tutor", async () => {
    const { window, document, calls } = loadPage();
    await wait();
    const capField = document.getElementById("globalWeeklyCap");
    const applyBtn = document.getElementById("applyCapBtn");
    const bulkCalls = () =>
      calls.filter((c) => c.method === "PUT" && c.url === "/api/tutors/bulk");

    // The field is type=number, so the UI can only feed it numbers — the
    // guard's reachable branch is a negative value (non-numeric input is
    // sanitised away by the browser before the script ever sees it).
    capField.value = "-1";
    applyBtn.click();
    expect(document.getElementById("toast").textContent).toBe(
      "Enter a valid number of hours.",
    );
    expect(bulkCalls()).toHaveLength(0);

    capField.value = "7";
    applyBtn.click();
    expect(document.getElementById("toast").textContent).toBe(
      "Weekly cap cannot exceed 6 hours.",
    );
    expect(capField.value).toBe("6");
    expect(bulkCalls()).toHaveLength(0);

    capField.value = "5";
    applyBtn.click();
    await wait();
    expect(bulkCalls()).toHaveLength(1);
    expect(bulkCalls()[0].body).toEqual({ weekly_hour_cap: 5 });
    expect(window.localStorage.getItem("tms_global_weekly_cap")).toBe("5");
    expect(document.getElementById("toast").textContent).toBe(
      "Updated weekly cap to 5 hrs for 2 tutors.",
    );
    expect(applyBtn.disabled).toBe(false);
    expect(applyBtn.textContent).toContain("Apply to all");
  });

  test("a highlight deep-link flashes the tutor's row", async () => {
    const { document } = loadPage({
      url: "http://localhost/tutors.html?highlight=t2",
    });
    await wait();

    const row = document.querySelector('tr[data-tutor-id="t2"]');
    expect(row.classList.contains("search-highlight")).toBe(true);
  });
});
