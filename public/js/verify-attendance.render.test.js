// verify-attendance.js lays the organiser's verification queue out like the
// tutor's log-hours page: module chips (with pending badges) → upcoming
// session previews → past sessions grouped by the occurrence that was
// logged, with the tutors/volunteers who logged it under each. It's a plain
// browser script (sessionStorage + fetch), so it runs in a real jsdom window
// with a stubbed fetch — the same harness as notifications.test.js, with the
// //# sourceURL tag so Jest's v8 coverage attributes lines to the real file.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const verifyAttendanceJs = fs.readFileSync(
  path.join(__dirname, "verify-attendance.js"),
  "utf8",
);
const verifyAttendanceJsUrl = pathToFileURL(
  path.join(__dirname, "verify-attendance.js"),
).href;

// Every element handle the script grabs at load time.
const MARKUP = `
  <div id="courseChips"></div>
  <section id="upcomingStep" hidden><div id="sessionChips"></div></section>
  <h2 id="sessionsHeading">Logged hours to verify</h2>
  <ul id="sessionList"></ul>
  <p id="sessionsEmpty" hidden></p>
  <div id="statusChips">
    <button type="button" class="filter-chip" data-status="pending">Pending</button>
    <button type="button" class="filter-chip" data-status="verified">Verified</button>
    <button type="button" class="filter-chip" data-status="flagged">Flagged</button>
    <button type="button" class="filter-chip" data-status="">All</button>
  </div>
  <select id="statusFilter" hidden>
    <option value="pending" selected>Pending</option>
    <option value="verified">Verified</option>
    <option value="flagged">Flagged</option>
    <option value="">All</option>
  </select>
  <button id="reviewPendingBtn"></button>
  <button id="showFlaggedBtn"></button>
  <span id="verifyPendingMeta"></span>
  <span id="verifyDecidedMeta"></span>
  <span id="verifyFlaggedMeta"></span>
  <span id="verifyVerifiedMeta"></span>
  <dialog id="reasonModal">
    <form id="reasonForm">
      <h2 id="reasonModalHeading"></h2>
      <p id="reasonFormError" hidden></p>
      <span id="reasonFieldLabel"></span>
      <textarea id="reasonInput"></textarea>
      <button id="reasonModalCloseBtn" type="button"></button>
      <button id="reasonCancelBtn" type="button"></button>
      <button id="reasonSubmitBtn" type="submit"></button>
    </form>
  </dialog>
  <output id="toast"></output>
`;

function user(id, name, role) {
  return { id, name, email: `${id}@wits.ac.za`, role };
}

function entry(overrides = {}) {
  return {
    id: "e1",
    user_id: "u1",
    course_id: 5,
    date: "2026-09-14",
    hours: 2,
    start_time: "10:00:00",
    end_time: "12:00:00",
    task_type: "Tutoring",
    subject: "COMS1018A",
    notes: "",
    verification_status: "pending",
    session_type: "Tutorial",
    venue: "MSL004",
    user: user("u1", "Alice Ndlovu", "tutor"),
    ...overrides,
  };
}

// Fresh copies per render: the PATCH stub mutates the served rows in place,
// like the real database would.
function fixtures() {
  return {
    courses: [
      {
        id: 9,
        course_code: "APPM2021",
        course_name: "Applied Mathematics",
        Day_of_tut: null,
        tutor_start_time: null,
        tutor_end_time: null,
        venues: null,
        Day_of_lab: null,
        lab_start_time: null,
        lab_end_time: null,
        lab_venues: null,
      },
      {
        id: 5,
        course_code: "COMS1018A",
        course_name: "Computer Networks",
        Day_of_tut: "Monday",
        tutor_start_time: "10:00:00",
        tutor_end_time: "12:00:00",
        venues: "MSL004",
        Day_of_lab: null,
        lab_start_time: null,
        lab_end_time: null,
        lab_venues: null,
      },
      // Outside the signed-in organiser's scope — must not get a chip.
      { id: 12, course_code: "MATH1000", course_name: "Mathematics" },
    ],
    entries: [
      entry(),
      entry({
        id: "e2",
        user_id: "u2",
        user: user("u2", "Bongani Sithole", "volunteer"),
      }),
      // Legacy row with no course link: its subject still files it under
      // the matching module chip.
      entry({
        id: "e4",
        course_id: null,
        user_id: "u4",
        user: user("u4", "Chandra Pillay", "tutor"),
      }),
      // A later, flagged session of the same module.
      entry({
        id: "e5",
        date: "2026-09-21",
        start_time: "14:00:00",
        end_time: "16:00:00",
        session_type: "Lab",
        venue: "Lab 2",
        verification_status: "flagged",
        verification_note: "No one saw you at the lab",
        user_id: "u5",
        user: user("u5", "Dana Fourie", "tutor"),
      }),
      // The other scoped module's only entry — already decided.
      entry({
        id: "e3",
        course_id: 9,
        subject: "APPM2021",
        date: "2026-09-16",
        start_time: "09:00:00",
        end_time: "10:00:00",
        hours: 1,
        session_type: "Tutorial",
        venue: "Braam 1",
        verification_status: "verified",
        user_id: "u3",
        user: user("u3", "Ebrahim Patel", "tutor"),
      }),
    ],
  };
}

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

function renderPage({ highlightEntry = null } = {}) {
  const data = fixtures();
  const calls = [];
  const url = highlightEntry
    ? `http://localhost/verify-attendance.html?highlightEntry=${highlightEntry}`
    : "http://localhost/verify-attendance.html";

  const dom = new JSDOM(`<!doctype html><html><body>${MARKUP}`, {
    url,
    runScripts: "dangerously",
    beforeParse(window) {
      // jsdom doesn't implement scrolling — the highlight path calls it.
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.sessionStorage.setItem(
        "user",
        JSON.stringify({ id: "org1", role: "organiser", courseIds: [5, 9] }),
      );
      window.fetch = (url, options = {}) => {
        const target = String(url);
        calls.push({
          url: target,
          method: options.method || "GET",
          body: options.body || null,
        });
        if (target.startsWith("/api/courses")) {
          return jsonResponse(data.courses);
        }
        if (target.startsWith("/api/attendance-verification/")) {
          const body = JSON.parse(options.body || "{}");
          const row = data.entries.find(
            (e) => e.id === target.split("/").pop(),
          );
          if (row) {
            row.verification_status = body.status;
          }
          return jsonResponse(row || {});
        }
        return jsonResponse(data.entries);
      };
    },
  });

  // The page script is a classic script — inline it with a sourceURL so it
  // runs immediately and coverage lands on the real file's lines.
  dom.window.eval(
    `${verifyAttendanceJs}\n//# sourceURL=${verifyAttendanceJsUrl}`,
  );

  return { win: dom.window, calls, data };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function chipsOf(win) {
  return [...win.document.querySelectorAll("#courseChips .course-chip")];
}

function groupsOf(win) {
  return [...win.document.querySelectorAll("#sessionList .session-group")];
}

function rowsOf(group) {
  return [...group.querySelectorAll(".session-group__list > li")];
}

describe("verify-attendance render", () => {
  test("chips scope to the organiser, badge pending counts, and group the picked module's pending sessions", async () => {
    const { win } = renderPage();
    await flush();

    const chips = chipsOf(win);
    // APPM2021 sorts first but has nothing pending, so the initial pick is
    // COMS1018A — the first module with a queue to work through.
    expect(
      chips.map((c) => c.querySelector(".course-chip__code").textContent),
    ).toEqual(["APPM2021", "COMS1018A"]);
    expect(chips.map((c) => c.classList.contains("is-selected"))).toEqual([
      false,
      true,
    ]);
    expect(
      chips.map((c) => c.querySelector(".course-chip__badge").hidden),
    ).toEqual([true, false]);
    expect(chips[1].querySelector(".course-chip__badge").textContent).toBe("3");

    // The picked module has slots, so upcoming previews render.
    expect(win.document.getElementById("upcomingStep").hidden).toBe(false);
    expect(
      win.document.querySelectorAll("#sessionChips .session-chip").length,
    ).toBeGreaterThan(0);

    // Default filter is "pending": one session group with the three people
    // who logged it (the flagged session and the other module stay hidden),
    // rows alphabetised, the legacy unlinked entry filed under its subject.
    const groups = groupsOf(win);
    expect(groups).toHaveLength(1);
    expect(groups[0].querySelector(".session-group__when").textContent).toBe(
      "Mon 14 Sept · 10:00–12:00",
    );
    expect(groups[0].querySelector(".stamp").textContent).toBe("Tutorial");
    expect(groups[0].querySelector(".session-group__count").textContent).toBe(
      "3 logged",
    );
    expect(
      rowsOf(groups[0]).map((li) => li.querySelector(".name").textContent),
    ).toEqual(["Alice Ndlovu", "Bongani Sithole", "Chandra Pillay"]);
    expect(
      rowsOf(groups[0]).map((li) => li.querySelector(".status-pill").className),
    ).toEqual([
      "status-pill pending",
      "status-pill pending",
      "status-pill pending",
    ]);
    expect(
      rowsOf(groups[0])[0].querySelector(".review-row__hours").textContent,
    ).toBe("2 hrs");

    // The cards count every module; the chips count the picked one.
    expect(win.document.getElementById("verifyPendingMeta").textContent).toBe(
      "3 pending",
    );
    expect(win.document.getElementById("verifyVerifiedMeta").textContent).toBe(
      "1 verified",
    );
    const chipLabels = [...win.document.querySelectorAll(".filter-chip")].map(
      (c) => c.textContent,
    );
    expect(chipLabels).toEqual([
      "Pending (3)",
      "Verified (0)",
      "Flagged (1)",
      "All (4)",
    ]);

    win.close();
  });

  test("switching modules re-renders upcoming previews and the past list", async () => {
    const { win } = renderPage();
    await flush();

    chipsOf(win)[0].click();
    await flush();

    const chips = chipsOf(win);
    expect(chips.map((c) => c.classList.contains("is-selected"))).toEqual([
      true,
      false,
    ]);

    // APPM2021 has no timetable slots — the upcoming step shows its empty
    // state — and nothing pending, so the kept filter empties the past list
    // (the chips show why: Pending (0), Verified (1)).
    expect(
      win.document.querySelector("#sessionChips .empty-state"),
    ).not.toBeNull();
    expect(groupsOf(win)).toHaveLength(0);
    expect(win.document.getElementById("sessionsEmpty").hidden).toBe(false);

    // Opening the filter to All reveals its one verified session.
    win.document.querySelector('.filter-chip[data-status=""]').click();
    await flush();
    const groups = groupsOf(win);
    expect(groups).toHaveLength(1);
    expect(groups[0].querySelector(".session-group__when").textContent).toBe(
      "Wed 16 Sept · 09:00–10:00",
    );
    expect(rowsOf(groups[0])[0].querySelector(".status-pill").textContent).toBe(
      "Verified",
    );

    win.close();
  });

  test("the status chips filter the picked module client-side", async () => {
    const { win, calls } = renderPage();
    await flush();
    const queueGets = () =>
      calls.filter(
        (c) =>
          c.method === "GET" &&
          c.url.startsWith("/api/attendance-verification"),
      ).length;
    const getsBefore = queueGets();

    // "All" reveals both of COMS1018A's sessions, newest first.
    win.document.querySelector('.filter-chip[data-status=""]').click();
    await flush();
    let groups = groupsOf(win);
    expect(groups).toHaveLength(2);
    expect(groups[0].querySelector(".session-group__count").textContent).toBe(
      "1 logged",
    );
    expect(rowsOf(groups[0])[0].querySelector(".status-pill").textContent).toBe(
      "Flagged",
    );

    // A status with nothing in this module falls to the empty copy; the
    // counts came from the already-loaded queue, with no extra fetches.
    win.document.querySelector('.filter-chip[data-status="verified"]').click();
    await flush();
    expect(groupsOf(win)).toHaveLength(0);
    expect(win.document.getElementById("sessionsEmpty").hidden).toBe(false);
    expect(win.document.getElementById("sessionsEmpty").textContent).toBe(
      "No logged sessions to show for this filter.",
    );
    expect(queueGets()).toBe(getsBefore);

    win.close();
  });

  test("a decision refreshes badges, counts and rows from the queue", async () => {
    const { win, data } = renderPage();
    await flush();

    // The row buttons all funnel into the same setStatus, so drive it
    // directly with the fixture row — the same call the now one-click
    // Verify button makes (covered by its own test below).
    const ok = await win.setStatus(
      data.entries[1],
      "verified",
      "Bongani Sithole",
    );
    expect(ok).toBe(true);
    await flush();

    // Bongani's entry left the pending view: two rows in the session group,
    // the module badge dropped, the cards picked up the decision.
    const groups = groupsOf(win);
    expect(groups).toHaveLength(1);
    expect(groups[0].querySelector(".session-group__count").textContent).toBe(
      "2 logged",
    );
    expect(
      rowsOf(groups[0]).map((li) => li.querySelector(".name").textContent),
    ).toEqual(["Alice Ndlovu", "Chandra Pillay"]);
    expect(
      chipsOf(win)[1].querySelector(".course-chip__badge").textContent,
    ).toBe("2");
    expect(win.document.getElementById("verifyVerifiedMeta").textContent).toBe(
      "2 verified",
    );
    expect(win.document.getElementById("toast").textContent).toBe(
      "Bongani Sithole's session verified",
    );

    win.close();
  });

  test("Verify is one click — no modal, no note on the wire", async () => {
    const { win, calls, data } = renderPage();
    await flush();

    win.document
      .querySelector(
        'li[data-entry-id="e1"] .applicant-actions .btn-small.approve',
      )
      .click();
    await flush();

    // The click PATCHes straight away, with no note field at all.
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe("/api/attendance-verification/e1");
    expect(JSON.parse(patches[0].body)).toEqual({
      status: "verified",
      reviewerId: "org1",
    });

    // The refreshed queue leaves Alice verified — still in the All view,
    // gone from the default pending one.
    expect(data.entries[0].verification_status).toBe("verified");
    expect(win.document.querySelector('li[data-entry-id="e1"]')).toBeNull();
    expect(win.document.getElementById("toast").textContent).toBe(
      "Alice Ndlovu's session verified",
    );

    win.close();
  });

  test("a highlightEntry deep-link picks the entry's module, opens All and flashes the row", async () => {
    const { win } = renderPage({ highlightEntry: "e5" });
    await flush();

    // e5 is a flagged COMS1018A session — the deep-link selects that module
    // and opens the filter to All so the decided row isn't hidden.
    expect(chipsOf(win)[1].classList.contains("is-selected")).toBe(true);
    expect(win.document.getElementById("statusFilter").value).toBe("");

    const row = win.document.querySelector('li[data-entry-id="e5"]');
    expect(row).not.toBeNull();
    expect(row.classList.contains("highlight-flash")).toBe(true);

    win.close();
  });
});
