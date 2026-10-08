const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The route module grabs the Supabase client via `require("../supabaseClient")`
// at load time, so the mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const profileRouter = require("./profile");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/profile", profileRouter);
  return app;
}

const TUTOR_ID = "11111111-1111-1111-1111-111111111111";
const STUDENT_ID = "22222222-2222-2222-2222-222222222222";
const ORGANISER_ID = "33333333-3333-3333-3333-333333333333";
const EDUCATOR_ID = "44444444-4444-4444-4444-444444444444";

beforeEach(() => {
  tables = {
    users: [
      {
        id: TUTOR_ID,
        name: "Ada",
        email: "ada@wits.ac.za",
        cell_phone: "082 123 4567",
        role: "tutor",
      },
      {
        id: STUDENT_ID,
        name: "Sam",
        email: "sam@students.wits.ac.za",
        cell_phone: null,
        role: "student",
      },
      {
        id: ORGANISER_ID,
        name: "Org",
        email: "org@wits.ac.za",
        cell_phone: null,
        role: "organiser",
      },
      {
        id: EDUCATOR_ID,
        name: "Ed",
        email: "ed@wits.ac.za",
        role: "educator",
      },
    ],
    tutors: [{ id: TUTOR_ID, name: "Ada", student_number: "1234567" }],
    students: [{ id: STUDENT_ID, name: "Sam", student_no: "7654321" }],
  };
  mockSupabase = fakeSupabase(tables, {
    tutors: [["student_number"]],
    students: [["student_no"]],
  });
});

describe("GET /api/profile/:userId", () => {
  test("returns a tutor's profile with the student number from their tutor row", async () => {
    const res = await request(buildApp()).get(`/api/profile/${TUTOR_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: TUTOR_ID,
      name: "Ada",
      email: "ada@wits.ac.za",
      studentNumber: "1234567",
      cellPhone: "082 123 4567",
      role: "tutor",
    });
  });

  test("returns a student volunteer's profile from the students table", async () => {
    const res = await request(buildApp()).get(`/api/profile/${STUDENT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.studentNumber).toBe("7654321");
    // A null cell_phone comes back as an empty string, not null, so the
    // form can prefill an empty input directly.
    expect(res.body.cellPhone).toBe("");
  });

  test("404s for an unknown user", async () => {
    const res = await request(buildApp()).get("/api/profile/not-a-user");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
  });

  test("returns an organiser's profile with no student number", async () => {
    const res = await request(buildApp()).get(`/api/profile/${ORGANISER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: ORGANISER_ID,
      name: "Org",
      email: "org@wits.ac.za",
      studentNumber: "",
      cellPhone: "",
      role: "organiser",
    });
  });

  test("403s a role that has no profile page (educator)", async () => {
    const res = await request(buildApp()).get(`/api/profile/${EDUCATOR_ID}`);

    expect(res.status).toBe(403);
  });
});

describe("PUT /api/profile/:userId", () => {
  test("saves the editable fields to the users row and mirrors name + student number onto the tutor row", async () => {
    const res = await request(buildApp()).put(`/api/profile/${TUTOR_ID}`).send({
      name: "Adah",
      studentNumber: "1234568",
      cellPhone: "083 999 0000",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Adah",
      studentNumber: "1234568",
      cellPhone: "083 999 0000",
    });

    const user = tables.users.find((u) => u.id === TUTOR_ID);
    expect(user.name).toBe("Adah");
    expect(user.cell_phone).toBe("083 999 0000");

    const tutor = tables.tutors.find((t) => t.id === TUTOR_ID);
    expect(tutor.name).toBe("Adah");
    expect(tutor.student_number).toBe("1234568");
  });

  test("accepts the usual ways of writing a South African cell number", async () => {
    const validNumbers = [
      "0821234567",
      "082 123 4567",
      "(082) 123-4567",
      "+27 82 123 4567",
      "+27821234567",
      "0027 82 123 4567",
      "27821234567",
    ];

    for (const cellPhone of validNumbers) {
      const res = await request(buildApp())
        .put(`/api/profile/${TUTOR_ID}`)
        .send({
          name: "Ada",
          studentNumber: "1234567",
          cellPhone,
        });

      expect(res.status).toBe(200);
      expect(tables.users.find((u) => u.id === TUTOR_ID).cell_phone).toBe(
        cellPhone,
      );
    }
  });

  test("does not change the login email even if one is sent", async () => {
    const res = await request(buildApp()).put(`/api/profile/${TUTOR_ID}`).send({
      name: "Ada",
      studentNumber: "1234567",
      email: "hacker@wits.ac.za",
    });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe("ada@wits.ac.za");
    expect(tables.users.find((u) => u.id === TUTOR_ID).email).toBe(
      "ada@wits.ac.za",
    );
  });

  test("updates the students table for a student volunteer", async () => {
    const res = await request(buildApp())
      .put(`/api/profile/${STUDENT_ID}`)
      .send({
        name: "Samuel",
        studentNumber: "7654322",
        cellPhone: "+27 82 555 1234",
      });

    expect(res.status).toBe(200);
    const student = tables.students.find((s) => s.id === STUDENT_ID);
    expect(student.name).toBe("Samuel");
    expect(student.student_no).toBe("7654322");
  });

  test("clearing the cell phone stores null", async () => {
    const res = await request(buildApp()).put(`/api/profile/${TUTOR_ID}`).send({
      name: "Ada",
      studentNumber: "1234567",
      cellPhone: "",
    });

    expect(res.status).toBe(200);
    expect(res.body.cellPhone).toBe("");
    expect(tables.users.find((u) => u.id === TUTOR_ID).cell_phone).toBeNull();
  });

  test("400s when the name or student number is blank", async () => {
    const missingName = await request(buildApp())
      .put(`/api/profile/${TUTOR_ID}`)
      .send({ name: "  ", studentNumber: "1234567" });
    expect(missingName.status).toBe(400);

    const missingStudentNumber = await request(buildApp())
      .put(`/api/profile/${TUTOR_ID}`)
      .send({ name: "Ada", studentNumber: "" });
    expect(missingStudentNumber.status).toBe(400);
  });

  test("rejects numbers that aren't valid South African cell numbers", async () => {
    const invalidNumbers = [
      "call me maybe",
      "021 123 4567", // a landline (Cape Town area code), not a cell
      "092 123 4567", // 09x isn't an allocated mobile range
      "082 123 456", // too short
      "07123456789", // too long
      "+27 21 555 1234", // international form of a landline
    ];

    for (const cellPhone of invalidNumbers) {
      const res = await request(buildApp())
        .put(`/api/profile/${TUTOR_ID}`)
        .send({
          name: "Ada",
          studentNumber: "1234567",
          cellPhone,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("South African cell phone number");
    }
  });

  test("409s a student number already used by another account", async () => {
    tables.students.push({
      id: "other-student",
      name: "Other",
      student_no: "9999999",
    });

    const res = await request(buildApp())
      .put(`/api/profile/${STUDENT_ID}`)
      .send({
        name: "Sam",
        studentNumber: "9999999",
      });

    expect(res.status).toBe(409);
    // The save aborted before touching either table.
    expect(tables.students.find((s) => s.id === STUDENT_ID).student_no).toBe(
      "7654321",
    );
    expect(tables.users.find((u) => u.id === STUDENT_ID).name).toBe("Sam");
  });

  test("404s for an unknown user", async () => {
    const res = await request(buildApp())
      .put("/api/profile/not-a-user")
      .send({ name: "A", studentNumber: "1" });

    expect(res.status).toBe(404);
  });

  test("saves an organiser's name and cell phone without needing a student number", async () => {
    const res = await request(buildApp())
      .put(`/api/profile/${ORGANISER_ID}`)
      .send({
        name: "Organ Iser",
        cellPhone: "082 123 4567",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Organ Iser",
      studentNumber: "",
      cellPhone: "082 123 4567",
    });
    const user = tables.users.find((u) => u.id === ORGANISER_ID);
    expect(user.name).toBe("Organ Iser");
    expect(user.cell_phone).toBe("082 123 4567");
  });

  test("400s an organiser save with a blank name, but doesn't require a student number", async () => {
    const res = await request(buildApp())
      .put(`/api/profile/${ORGANISER_ID}`)
      .send({ name: "  " });

    expect(res.status).toBe(400);
  });

  test("403s a role that has no profile page (educator)", async () => {
    const res = await request(buildApp())
      .put(`/api/profile/${EDUCATOR_ID}`)
      .send({
        name: "Ed",
        studentNumber: "1",
      });

    expect(res.status).toBe(403);
  });
});
