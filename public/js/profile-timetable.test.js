// profile-timetable.js drives the "My timetable" card on both profile pages.
// Loads the real source into jsdom with `export` stripped (the same way
// transcript-upload.test.js does), against the card markup lifted straight
// from student-profile.html, stubbing only the network, window.open and
// window.confirm.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const rawSource = fs
  .readFileSync(path.join(__dirname, "profile-timetable.js"), "utf8")
  // `export` isn't valid inside dom.window.eval (classic script semantics).
  .replace(/^export /gm, "");
const sourceUrl = pathToFileURL(
  path.join(__dirname, "profile-timetable.js"),
).href;

function cardMarkup(file) {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "html", file),
    "utf8",
  );
  const match =
    /<section\s+class="card profile-timetable-card"[\s\S]*?<\/section>/.exec(
      html,
    );
  if (!match) throw new Error(`No timetable card in ${file}`);
  return match[0];
}

const CARD_MARKUP = cardMarkup("student-profile.html");

function renderCard(withCard = true) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${withCard ? CARD_MARKUP : ""}</body></html>`,
    { url: "http://localhost/student-profile.html", runScripts: "dangerously" },
  );
  // Expose the function the way profile.js's import would. The sourceURL
  // lets Jest's v8 coverage attribute the eval'd copy to the real file.
  dom.window.eval(
    `${rawSource}\nwindow.initProfileTimetable = initProfileTimetable;\n//# sourceURL=${sourceUrl}`,
  );
  return dom.window;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

// jsdom's file inputs expose a read-only `files`; the change handler only
// reads `files[0]`, so a defined property stands in for a real selection.
function selectFile(window, file) {
  const input = window.document.getElementById("profile-timetable-input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new window.Event("change"));
}

const byId = (window, id) => window.document.getElementById(id);

describe("profile timetable card", () => {
  test("both profile pages carry the same card", () => {
    expect(cardMarkup("profile.html")).toBe(CARD_MARKUP);
  });

  test("renders the saved state from the status endpoint", async () => {
    const window = renderCard();
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        uploaded: true,
        fileName: "timetable.pdf",
        updatedAt: "2026-10-08T09:00:00.000Z",
      }),
    );
    window.fetch = fetchMock;

    await window.initProfileTimetable("user-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/profile/user-1/timetable");
    expect(byId(window, "profile-timetable-status").textContent).toMatch(
      /^Timetable on file — uploaded /,
    );
    expect(byId(window, "profile-timetable-view-btn").hidden).toBe(false);
    expect(byId(window, "profile-timetable-remove-btn").hidden).toBe(false);
    expect(byId(window, "profile-timetable-upload-btn").textContent).toBe(
      "Replace timetable",
    );
  });

  test("renders the empty state when nothing is on file", async () => {
    const window = renderCard();
    window.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ uploaded: false }));

    await window.initProfileTimetable("user-1");

    expect(byId(window, "profile-timetable-status").textContent).toBe(
      "You haven't uploaded a timetable yet — upload your class timetable PDF to keep it on your profile.",
    );
    expect(byId(window, "profile-timetable-view-btn").hidden).toBe(true);
    expect(byId(window, "profile-timetable-remove-btn").hidden).toBe(true);
    expect(byId(window, "profile-timetable-upload-btn").textContent).toBe(
      "Upload timetable",
    );
  });

  test("shows the server's message when the status check fails", async () => {
    const window = renderCard();
    window.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "Timetable storage is unavailable" }, false),
      );

    await window.initProfileTimetable("user-1");

    expect(byId(window, "profile-timetable-status").textContent).toBe(
      "Timetable storage is unavailable",
    );
  });

  test("does nothing on a page without the card", async () => {
    const window = renderCard(false);
    const fetchMock = jest.fn();
    window.fetch = fetchMock;

    await window.initProfileTimetable("user-1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("posts the chosen PDF as a raw body and shows it on file", async () => {
    const window = renderCard();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploaded: false }))
      .mockResolvedValueOnce(
        jsonResponse({
          uploaded: true,
          fileName: "timetable.pdf",
          updatedAt: "2026-10-08T09:00:00.000Z",
        }),
      );
    window.fetch = fetchMock;

    await window.initProfileTimetable("user-1");
    const file = new window.File(["%PDF-1.4"], "Timetable [2556983].pdf", {
      type: "application/pdf",
    });
    selectFile(window, file);
    await flush();

    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/profile/user-1/timetable");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/pdf");
    expect(options.body).toBe(file);
    expect(byId(window, "profile-timetable-status").textContent).toMatch(
      /^Timetable on file/,
    );
    expect(byId(window, "profile-timetable-upload-btn").disabled).toBe(false);
  });

  test("rejects a non-PDF without calling the server", async () => {
    const window = renderCard();
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ uploaded: false }));
    window.fetch = fetchMock;

    await window.initProfileTimetable("user-1");
    selectFile(
      window,
      new window.File(["png"], "timetable.png", { type: "image/png" }),
    );
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const error = byId(window, "profile-timetable-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Your timetable must be a PDF.");
  });

  test("rejects a PDF over 5 MB without calling the server", async () => {
    const window = renderCard();
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ uploaded: false }));
    window.fetch = fetchMock;

    await window.initProfileTimetable("user-1");
    const file = new window.File(["%PDF-1.4"], "big.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 + 1 });
    selectFile(window, file);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(byId(window, "profile-timetable-error").textContent).toMatch(
      /at most 5 MB/,
    );
  });

  test("keeps the previous state and shows the error when an upload is refused", async () => {
    const window = renderCard();
    window.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploaded: false }))
      .mockResolvedValueOnce(
        jsonResponse({ error: "That file doesn't look like a PDF." }, false),
      );

    await window.initProfileTimetable("user-1");
    selectFile(
      window,
      new window.File(["nope"], "fake.pdf", { type: "application/pdf" }),
    );
    await flush();

    expect(byId(window, "profile-timetable-error").textContent).toBe(
      "That file doesn't look like a PDF.",
    );
    expect(byId(window, "profile-timetable-status").textContent).toBe(
      "You haven't uploaded a timetable yet — upload your class timetable PDF to keep it on your profile.",
    );
  });

  test("opens the signed URL when View timetable is clicked", async () => {
    const window = renderCard();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploaded: true }))
      .mockResolvedValueOnce(
        jsonResponse({ url: "https://signed.example/timetable.pdf" }),
      );
    window.fetch = fetchMock;
    window.open = jest.fn();

    await window.initProfileTimetable("user-1");
    byId(window, "profile-timetable-view-btn").click();
    await flush();

    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/profile/user-1/timetable/signed-url",
    );
    expect(window.open).toHaveBeenCalledWith(
      "https://signed.example/timetable.pdf",
      "_blank",
      "noopener",
    );
  });

  test("removes the timetable after confirmation", async () => {
    const window = renderCard();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploaded: true }))
      .mockResolvedValueOnce(jsonResponse({ uploaded: false }));
    window.fetch = fetchMock;
    window.confirm = jest.fn(() => true);

    await window.initProfileTimetable("user-1");
    byId(window, "profile-timetable-remove-btn").click();
    await flush();

    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/profile/user-1/timetable");
    expect(options.method).toBe("DELETE");
    expect(byId(window, "profile-timetable-status").textContent).toBe(
      "You haven't uploaded a timetable yet — upload your class timetable PDF to keep it on your profile.",
    );
    expect(byId(window, "profile-timetable-remove-btn").hidden).toBe(true);
  });

  test("leaves the timetable alone when removal isn't confirmed", async () => {
    const window = renderCard();
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ uploaded: true }));
    window.fetch = fetchMock;
    window.confirm = jest.fn(() => false);

    await window.initProfileTimetable("user-1");
    byId(window, "profile-timetable-remove-btn").click();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(byId(window, "profile-timetable-remove-btn").hidden).toBe(false);
  });
});
