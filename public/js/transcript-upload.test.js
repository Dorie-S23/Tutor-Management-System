// transcript-upload.js drives the "Your transcript" panel shared by
// modules.html and StudentView.html. Loads the real source into jsdom with
// `export` stripped (the same way volunteer-timesheets.render.test.js does),
// stubbing only the network and window.open.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const rawTranscriptJs = fs
  .readFileSync(path.join(__dirname, "transcript-upload.js"), "utf8")
  // `export` isn't valid inside dom.window.eval (classic script semantics).
  .replace(/^export /gm, "");
const transcriptJsUrl = pathToFileURL(
  path.join(__dirname, "transcript-upload.js"),
).href;

const PANEL_MARKUP = `
  <section class="panel" id="transcript-panel">
    <p class="hint">Upload your transcript&hellip;</p>
    <span id="transcript-status" aria-live="polite">Checking&hellip;</span>
    <button id="transcript-view-btn" type="button" hidden>
      View transcript
    </button>
    <button id="transcript-upload-btn" type="button">
      Upload transcript
    </button>
    <input type="file" id="transcript-input" hidden />
    <p id="transcript-error" hidden></p>
  </section>
`;

function renderPanel(withPanel = true) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${withPanel ? PANEL_MARKUP : ""}</body></html>`,
    { url: "http://localhost/modules.html", runScripts: "dangerously" },
  );
  // Expose the function the way a page script's import would. The sourceURL
  // lets Jest's v8 coverage attribute the eval'd copy to the real file.
  dom.window.eval(
    `${rawTranscriptJs}\nwindow.transcriptUpload = initTranscriptUpload;\n//# sourceURL=${transcriptJsUrl}`,
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
  const input = window.document.getElementById("transcript-input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new window.Event("change"));
}

describe("transcript upload panel", () => {
  test("renders the uploaded state from the status endpoint", async () => {
    const window = renderPanel();
    window.fetch = () =>
      Promise.resolve(
        jsonResponse({
          uploaded: true,
          fileName: "transcript.pdf",
          updatedAt: "2026-10-08T09:00:00.000Z",
        }),
      );

    await window.transcriptUpload("user-1");

    // Same transcript the profile pages upload, so one uploaded there reads
    // as on file here, with its upload date.
    const doc = window.document;
    const status = doc.getElementById("transcript-status").textContent;
    expect(status).toMatch(/^Transcript on file \(uploaded .*2026\)/);
    expect(status).toContain("you're ready to apply");
    expect(doc.getElementById("transcript-view-btn").hidden).toBe(false);
    expect(doc.getElementById("transcript-upload-btn").textContent).toBe(
      "Replace transcript",
    );
  });

  test("renders the empty state when nothing is on file", async () => {
    const window = renderPanel();
    window.fetch = () => Promise.resolve(jsonResponse({ uploaded: false }));

    await window.transcriptUpload("user-1");

    const doc = window.document;
    expect(doc.getElementById("transcript-status").textContent).toMatch(
      /No transcript uploaded yet/,
    );
    expect(doc.getElementById("transcript-view-btn").hidden).toBe(true);
    expect(doc.getElementById("transcript-upload-btn").textContent).toBe(
      "Upload transcript",
    );
  });

  test("does nothing on a page without the panel", async () => {
    const window = renderPanel(false);
    const fetchMock = jest.fn();
    window.fetch = fetchMock;

    await window.transcriptUpload("user-1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("posts the chosen file as a raw body and shows it on file", async () => {
    const window = renderPanel();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploaded: false }))
      .mockResolvedValueOnce(
        jsonResponse({ uploaded: true, fileName: "transcript.pdf" }),
      );
    window.fetch = fetchMock;

    await window.transcriptUpload("user-1");
    const file = new window.File(["%PDF-1.4"], "my-transcript.pdf", {
      type: "application/pdf",
    });
    selectFile(window, file);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/transcripts/user-1");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/pdf");
    expect(options.body).toBe(file);
    expect(
      window.document.getElementById("transcript-status").textContent,
    ).toBe("Transcript on file — you're ready to apply.");
  });

  test("rejects a file that isn't a PDF, PNG, or JPEG without calling the server", async () => {
    const window = renderPanel();
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ uploaded: false }));
    window.fetch = fetchMock;

    await window.transcriptUpload("user-1");
    selectFile(
      window,
      new window.File(["hello"], "notes.txt", { type: "text/plain" }),
    );
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1); // the status check only
    const error = window.document.getElementById("transcript-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Transcripts must be a PDF, PNG, or JPEG.");
  });

  test("rejects a file over 5 MB without calling the server", async () => {
    const window = renderPanel();
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ uploaded: false }));
    window.fetch = fetchMock;

    await window.transcriptUpload("user-1");
    const big = new window.File(
      [new ArrayBuffer(5 * 1024 * 1024 + 1)],
      "huge.pdf",
      { type: "application/pdf" },
    );
    selectFile(window, big);
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      window.document.getElementById("transcript-error").textContent,
    ).toMatch(/at most 5 MB/);
  });

  test("shows the server's message when an upload is refused", async () => {
    const window = renderPanel();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uploaded: false }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error:
              "Transcript storage isn't set up yet — the 'transcripts' bucket is missing in the Supabase project.",
          },
          false,
        ),
      );
    window.fetch = fetchMock;

    await window.transcriptUpload("user-1");
    selectFile(
      window,
      new window.File(["%PDF-1.4"], "t.pdf", { type: "application/pdf" }),
    );
    await flush();

    const error = window.document.getElementById("transcript-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toMatch(/isn't set up yet/);
    // The status line falls back to the state it had before the attempt.
    expect(
      window.document.getElementById("transcript-status").textContent,
    ).toMatch(/No transcript uploaded yet/);
  });

  test("opens the signed URL when View transcript is clicked", async () => {
    const window = renderPanel();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ uploaded: true, fileName: "transcript.pdf" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          url: "https://signed.example/transcript.pdf",
          expiresIn: 300,
        }),
      );
    window.fetch = fetchMock;
    const openMock = jest.fn();
    window.open = openMock;

    await window.transcriptUpload("user-1");
    window.document.getElementById("transcript-view-btn").click();
    await flush();

    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/transcripts/user-1/signed-url",
    );
    expect(openMock).toHaveBeenCalledWith(
      "https://signed.example/transcript.pdf",
      "_blank",
      "noopener",
    );
  });
});
