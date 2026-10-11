const { fakeSupabase } = require("./testUtils/fakeSupabase");

let tables;
let mockSupabase;
let mockFrom;

jest.mock("./supabaseClient", () => ({
  from: (...args) => mockFrom(...args),
}));

const mockSendEmail = jest.fn();
const mockIsEmailConfigured = jest.fn();
jest.mock("./emailClient", () => ({
  sendEmail: (...args) => mockSendEmail(...args),
  isEmailConfigured: () => mockIsEmailConfigured(),
}));

const {
  emailNotification,
  EMAIL_SUBJECTS,
  buildBody,
} = require("./notificationEmails");

const TUTOR = { id: "tutor-1", email: "tutor@wits.ac.za", name: "Jane Doe" };

const savedAppUrl = process.env.APP_URL;

beforeEach(() => {
  tables = { users: [{ ...TUTOR }] };
  mockSupabase = fakeSupabase(tables);
  mockFrom = jest.fn((table) => mockSupabase.from(table));
  mockSendEmail.mockReset().mockResolvedValue({ sent: true });
  mockIsEmailConfigured.mockReset().mockReturnValue(true);
  delete process.env.APP_URL;
});

afterAll(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

describe("emailNotification", () => {
  test("sends an allowlisted type to the user's address", async () => {
    await emailNotification("tutor-1", {
      type: "application_status",
      message: "You've been approved to tutor COMS2001.",
    });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sent = mockSendEmail.mock.calls[0][0];
    expect(sent.to).toBe("tutor@wits.ac.za");
    expect(sent.subject).toBe("TutorX: Your tutor application");
    expect(sent.text).toContain("You've been approved to tutor COMS2001.");
    expect(sent.html).toContain("You&#39;ve been approved to tutor COMS2001.");
  });

  test("looks the recipient up in the users table", async () => {
    await emailNotification("tutor-1", {
      type: "swap_accepted",
      message: "Sorted",
    });

    expect(mockFrom).toHaveBeenCalledWith("users");
  });

  test("leaves a type that isn't allowlisted in-app only", async () => {
    // attendance_logged fires for every session an organiser verifies — the
    // one type most likely to turn into inbox spam if it were ever added.
    await emailNotification("tutor-1", {
      type: "attendance_logged",
      message: "Your attendance was verified.",
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    // Short-circuits before the database too, since this is the high-volume path.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test("skips the recipient lookup entirely when no API key is configured", async () => {
    // The default state of a fresh clone — it must cost nothing per
    // notification, not a users query that was always going to be discarded.
    mockIsEmailConfigured.mockReturnValue(false);

    await emailNotification("tutor-1", {
      type: "timesheet_status",
      message: "Your timesheet was approved.",
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test("does not send for a user with no email address", async () => {
    tables.users = [{ id: "tutor-1", email: null, name: "Jane Doe" }];

    await emailNotification("tutor-1", {
      type: "timesheet_due",
      message: "You logged hours in September.",
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("does not send for a user id that no longer exists", async () => {
    await emailNotification("deleted-user", {
      type: "timesheet_due",
      message: "You logged hours in September.",
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("does not send without a user id", async () => {
    await emailNotification(null, {
      type: "cover_assigned",
      message: "You're covering Tuesday's tutorial.",
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  test("lets a provider failure propagate to the caller's catch", async () => {
    mockSendEmail.mockRejectedValue(new Error("Resend answered 403"));

    await expect(
      emailNotification("tutor-1", {
        type: "session_change",
        message: "Moved",
      }),
    ).rejects.toThrow("Resend answered 403");
  });
});

describe("EMAIL_SUBJECTS", () => {
  test("covers the decision and deadline types", () => {
    expect(Object.keys(EMAIL_SUBJECTS).sort()).toEqual(
      [
        "application_status",
        "cover_assigned",
        "organiser_request",
        "session_change",
        "swap_accepted",
        "swap_declined",
        "swap_request",
        "timesheet_due",
        "timesheet_status",
        "volunteer_status",
      ].sort(),
    );
  });

  test("keeps the routine and redundant types out", () => {
    for (const type of [
      "attendance_logged",
      "cover_cancelled",
      "cover_found",
      "cover_unavailable",
      "cover_reminder",
      "swap_withdrawn",
    ]) {
      expect(EMAIL_SUBJECTS).not.toHaveProperty(type);
    }
  });
});

describe("buildBody", () => {
  test("greets by first name only", () => {
    const { text } = buildBody("Jane", "Your timesheet was approved.");
    expect(text.startsWith("Hi Jane,")).toBe(true);
  });

  test("falls back to a plain greeting when there's no name", () => {
    const { text } = buildBody("", "Your timesheet was approved.");
    expect(text.startsWith("Hi,")).toBe(true);
    expect(text).not.toContain("undefined");
  });

  test("links back to the app, and to APP_URL when one is set", () => {
    expect(buildBody("Jane", "Moved").html).toContain(
      "https://tutorx.devden.workers.dev",
    );

    process.env.APP_URL = "https://preview.example.test";
    expect(buildBody("Jane", "Moved").html).toContain(
      "https://preview.example.test",
    );
  });

  test("escapes HTML in the message so a course name can't inject markup", () => {
    const { html } = buildBody("Jane", '<img src=x onerror="alert(1)"> moved');

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("escapes HTML in the recipient's name too", () => {
    const { html } = buildBody("<script>", "Moved");
    expect(html).not.toContain("<script>");
  });
});
