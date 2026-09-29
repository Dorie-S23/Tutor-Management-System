const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The helper grabs the Supabase client via require at load time, so the
// mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const { recordAudit } = require("./auditLog");

beforeEach(() => {
  tables = { audit_log: [] };
  mockSupabase = fakeSupabase(tables);
});

describe("recordAudit", () => {
  test("inserts an audit row with the entity, action and actor", async () => {
    await recordAudit({
      entityType: "tutor_applications",
      entityId: 5,
      action: "approve",
      actorId: "organiser-1",
    });

    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log[0]).toMatchObject({
      entity_type: "tutor_applications",
      entity_id: "5",
      action: "approve",
      actor_id: "organiser-1",
    });
  });

  test("coerces a numeric entityId to a string, like the DB column", async () => {
    await recordAudit({
      entityType: "courses",
      entityId: 12,
      action: "update",
    });
    expect(tables.audit_log[0].entity_id).toBe("12");
  });

  test("stores before/after snapshots when given", async () => {
    const before = { status: "pending" };
    const after = { status: "approved" };
    await recordAudit({
      entityType: "tutor_applications",
      entityId: 1,
      action: "approve",
      actorId: "o1",
      before,
      after,
    });

    expect(tables.audit_log[0].before).toEqual(before);
    expect(tables.audit_log[0].after).toEqual(after);
  });

  test("defaults actor_id, before and after to null", async () => {
    await recordAudit({
      entityType: "courses",
      entityId: "3",
      action: "view",
    });

    expect(tables.audit_log[0]).toMatchObject({
      actor_id: null,
      before: null,
      after: null,
    });
  });

  test("never throws when the insert fails — audit is best-effort", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // Make the insert fail via a violated unique constraint.
    tables.audit_log = [{ id: 1, entity_id: "1" }];
    mockSupabase = fakeSupabase(tables, { audit_log: [["entity_id"]] });

    await expect(
      recordAudit({ entityType: "courses", entityId: 1, action: "update" }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("audit_log insert failed for courses 1 (update)"),
      expect.any(String),
    );

    consoleError.mockRestore();
  });
});
