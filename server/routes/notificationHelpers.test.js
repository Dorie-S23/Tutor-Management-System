const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The helper grabs the Supabase client via require at load time, so the
// mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

// The email leg gets its own unit tests in server/notificationEmails.test.js,
// so it's stubbed out here — these tests are about what notify() writes and
// who it hands off to, not about Resend. Resolved, not just undefined, because
// emailAsync() calls .catch() on the result.
const mockEmailNotification = jest.fn().mockResolvedValue(undefined);
jest.mock("../notificationEmails", () => ({
  emailNotification: (...args) => mockEmailNotification(...args),
}));

const { notify, notifyMany } = require("./notificationHelpers");

// emailAsync() is deliberately not awaited, so assertions about it have to
// wait for the microtask queue to drain first.
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  tables = { notifications: [] };
  mockSupabase = fakeSupabase(tables);
  mockEmailNotification.mockClear();
});

describe("notify", () => {
  test("inserts a notification row with the expected shape", async () => {
    await notify("tutor-1", {
      type: "session_change",
      message: "Your Tuesday tutorial moved",
      relatedEntity: "courses",
      relatedId: 7,
    });

    expect(tables.notifications).toHaveLength(1);
    const row = tables.notifications[0];
    expect(row).toMatchObject({
      user_id: "tutor-1",
      type: "session_change",
      message: "Your Tuesday tutorial moved",
      related_entity: "courses",
      related_id: "7",
      read: false,
    });
  });

  test("stringifies a numeric related_id and keeps null when absent", async () => {
    await notify("u1", { type: "timesheet", message: "Approved" });
    await notify("u1", {
      type: "cover",
      message: "Cover found",
      relatedEntity: "session_excusals",
      relatedId: 42,
    });

    expect(tables.notifications[0].related_id).toBeNull();
    expect(tables.notifications[1].related_id).toBe("42");
  });

  test("rejects when the insert fails, so callers can .catch()", async () => {
    // Seed with a unique constraint the insert violates, mirroring a
    // real database error path.
    tables.notifications = [{ id: 1, user_id: "u1" }];
    mockSupabase = fakeSupabase(tables, { notifications: [["user_id"]] });

    await expect(
      notify("u1", { type: "x", message: "dup" }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  test("hands the type and message to the email leg once the row is in", async () => {
    await notify("tutor-1", {
      type: "application_status",
      message: "You've been approved to tutor COMS2001",
      relatedEntity: "tutor_subject_preference",
      relatedId: 3,
    });
    await flush();

    // Only type and message cross over — the related-entity pair is in-app
    // navigation, which an email has no use for.
    expect(mockEmailNotification).toHaveBeenCalledTimes(1);
    expect(mockEmailNotification).toHaveBeenCalledWith("tutor-1", {
      type: "application_status",
      message: "You've been approved to tutor COMS2001",
    });
  });

  test("does not email when the insert fails", async () => {
    tables.notifications = [{ id: 1, user_id: "u1" }];
    mockSupabase = fakeSupabase(tables, { notifications: [["user_id"]] });

    await expect(
      notify("u1", { type: "application_status", message: "dup" }),
    ).rejects.toMatchObject({ code: "23505" });
    await flush();

    expect(mockEmailNotification).not.toHaveBeenCalled();
  });

  test("swallows an email failure rather than rejecting the caller", async () => {
    // The in-app row is the product; a dead mail provider must not turn a
    // successful notify() into a failed request.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockEmailNotification.mockRejectedValueOnce(
      new Error("Resend answered 500"),
    );

    await expect(
      notify("u1", { type: "swap_accepted", message: "Sorted" }),
    ).resolves.toBeUndefined();
    await flush();

    expect(tables.notifications).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("notifyMany", () => {
  const payload = {
    type: "session_change",
    message: "COMS2001's session time changed",
    relatedEntity: "course",
    relatedId: 12,
  };

  test("writes one row per recipient in a single bulk insert", async () => {
    await notifyMany(["t1", "v1", "v2"], payload);

    expect(tables.notifications).toHaveLength(3);
    expect(tables.notifications.map((row) => row.user_id)).toEqual([
      "t1",
      "v1",
      "v2",
    ]);
    expect(tables.notifications[0]).toMatchObject({
      type: "session_change",
      related_entity: "course",
      related_id: "12",
      read: false,
    });
  });

  test("emails each recipient", async () => {
    await notifyMany(["t1", "v1"], payload);
    await flush();

    expect(mockEmailNotification).toHaveBeenCalledTimes(2);
    expect(mockEmailNotification).toHaveBeenCalledWith("t1", {
      type: "session_change",
      message: "COMS2001's session time changed",
    });
    expect(mockEmailNotification).toHaveBeenCalledWith("v1", {
      type: "session_change",
      message: "COMS2001's session time changed",
    });
  });

  test("de-duplicates a user who is both a tutor and a volunteer", async () => {
    // A person approved on the same course in both roles appears in both
    // recipient lists, and should hear about the change once.
    await notifyMany(["t1", "t1", "v1"], payload);
    await flush();

    expect(tables.notifications).toHaveLength(2);
    expect(mockEmailNotification).toHaveBeenCalledTimes(2);
  });

  test("does nothing for an empty or absent recipient list", async () => {
    await notifyMany([], payload);
    await notifyMany(null, payload);
    await flush();

    expect(tables.notifications).toHaveLength(0);
    expect(mockEmailNotification).not.toHaveBeenCalled();
  });

  test("drops nullish recipient ids rather than writing a row for one", async () => {
    await notifyMany(["t1", null, undefined, "v1"], payload);

    expect(tables.notifications.map((row) => row.user_id)).toEqual([
      "t1",
      "v1",
    ]);
  });

  test("rejects and sends no email when the bulk insert fails", async () => {
    tables.notifications = [{ id: 1, user_id: "t1" }];
    mockSupabase = fakeSupabase(tables, { notifications: [["user_id"]] });

    await expect(notifyMany(["t1", "v1"], payload)).rejects.toMatchObject({
      code: "23505",
    });
    await flush();

    expect(mockEmailNotification).not.toHaveBeenCalled();
  });
});
