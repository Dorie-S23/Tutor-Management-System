const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The helper grabs the Supabase client via require at load time, so the
// mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const { notify } = require("./notificationHelpers");

beforeEach(() => {
  tables = { notifications: [] };
  mockSupabase = fakeSupabase(tables);
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
});
