// The "My transcript" card on both profile pages reuses transcript-upload.js
// (whose behaviour is covered in transcript-upload.test.js). These tests only
// check the profile markup itself: both pages carry the same card, and its
// element ids line up with what transcript-upload.js looks for.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const rawSource = fs
  .readFileSync(path.join(__dirname, "transcript-upload.js"), "utf8")
  // `export` isn't valid inside dom.window.eval (classic script semantics).
  .replace(/^export /gm, "");
const sourceUrl = pathToFileURL(
  path.join(__dirname, "transcript-upload.js"),
).href;

function cardMarkup(file) {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "html", file),
    "utf8",
  );
  const match =
    /<section\s+class="card profile-transcript-card"[\s\S]*?<\/section>/.exec(
      html,
    );
  if (!match) throw new Error(`No transcript card in ${file}`);
  return match[0];
}

const CARD_MARKUP = cardMarkup("student-profile.html");

function renderCard() {
  const dom = new JSDOM(
    `<!doctype html><html><body>${CARD_MARKUP}</body></html>`,
    { url: "http://localhost/student-profile.html", runScripts: "dangerously" },
  );
  dom.window.eval(
    `${rawSource}\nwindow.initTranscriptUpload = initTranscriptUpload;\n//# sourceURL=${sourceUrl}`,
  );
  return dom.window;
}

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

const byId = (window, id) => window.document.getElementById(id);

describe("profile transcript card", () => {
  test("both profile pages carry the same card", () => {
    expect(cardMarkup("profile.html")).toBe(CARD_MARKUP);
  });

  test("shows the transcript on file and its View button", async () => {
    const window = renderCard();
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ uploaded: true, fileName: "transcript.pdf" }),
      );
    window.fetch = fetchMock;

    await window.initTranscriptUpload("user-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/transcripts/user-1");
    expect(byId(window, "transcript-status").textContent).toBe(
      "Transcript on file — you're ready to apply.",
    );
    expect(byId(window, "transcript-view-btn").hidden).toBe(false);
    expect(byId(window, "transcript-upload-btn").textContent).toBe(
      "Replace transcript",
    );
  });

  test("opens the signed URL when View transcript is clicked", async () => {
    const window = renderCard();
    window.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ uploaded: true, fileName: "transcript.pdf" }),
      )
      .mockResolvedValueOnce(jsonResponse({ url: "https://signed/t.pdf" }));
    window.open = jest.fn();

    await window.initTranscriptUpload("user-1");
    byId(window, "transcript-view-btn").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.fetch).toHaveBeenLastCalledWith(
      "/api/transcripts/user-1/signed-url",
    );
    expect(window.open).toHaveBeenCalledWith(
      "https://signed/t.pdf",
      "_blank",
      "noopener",
    );
  });
});
