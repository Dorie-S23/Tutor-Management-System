// The client calls the real global fetch, so every test swaps in a jest.fn()
// (same approach as timetable.test.js) — nothing here should reach Resend.
const realFetch = global.fetch;

const { sendEmail, isEmailConfigured } = require("./emailClient");

const okResponse = () => ({ ok: true, status: 200, json: async () => ({}) });

const savedEnv = {};

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue(okResponse());
  for (const key of ["RESEND_API_KEY", "EMAIL_FROM", "APP_URL"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  global.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const payload = {
  to: "tutor@wits.ac.za",
  subject: "TutorX: Your timesheet",
  html: "<p>Hi</p>",
  text: "Hi",
};

describe("sendEmail", () => {
  test("does nothing and says so when no API key is configured", async () => {
    const result = await sendEmail(payload);

    expect(result).toEqual({ sent: false, reason: "not_configured" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("POSTs to Resend with a bearer token and the message", async () => {
    process.env.RESEND_API_KEY = "re_test_key";

    const result = await sendEmail(payload);

    expect(result).toEqual({ sent: true });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(options.body)).toEqual({
      // Resend's own sandbox sender, used until a real domain is verified.
      from: "TutorX <onboarding@resend.dev>",
      to: ["tutor@wits.ac.za"],
      subject: "TutorX: Your timesheet",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  test("sends from EMAIL_FROM when one is set", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "TutorX <no-reply@tutorx.ac.za>";

    await sendEmail(payload);

    expect(JSON.parse(global.fetch.mock.calls[0][1].body).from).toBe(
      "TutorX <no-reply@tutorx.ac.za>",
    );
  });

  test("aborts the request rather than hanging if Resend never answers", async () => {
    process.env.RESEND_API_KEY = "re_test_key";

    await sendEmail(payload);

    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test("throws with the status and Resend's own detail on a failure", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    global.fetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        '{"message":"You can only send testing emails to your own email address."}',
    });

    // 403 is what Resend answers with for every send to a real user while the
    // account has no verified domain, so the detail has to survive into the
    // log — otherwise that failure looks like a mystery.
    await expect(sendEmail(payload)).rejects.toThrow(/403.*own email address/);
  });

  test("throws on a network error instead of reporting a send", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    global.fetch.mockRejectedValue(new Error("fetch failed"));

    await expect(sendEmail(payload)).rejects.toThrow("fetch failed");
  });

  test("still throws if a failure response has no readable body", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("body already consumed");
      },
    });

    await expect(sendEmail(payload)).rejects.toThrow(/Resend answered 500/);
  });
});

describe("isEmailConfigured", () => {
  test("reflects RESEND_API_KEY, read at call time rather than at load", async () => {
    expect(isEmailConfigured()).toBe(false);

    process.env.RESEND_API_KEY = "re_test_key";
    expect(isEmailConfigured()).toBe(true);
  });
});
