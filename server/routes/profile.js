const express = require("express");
const supabase = require("../supabaseClient");

const router = express.Router();

// Each role's profile table also holds that account's student number — as
// student_number on tutors, student_no on students — so this route reads
// and writes it there instead of duplicating it onto `users`. Organisers
// have no student number at all (table: null) — their profile is just the
// `users` row (name, cell phone). Educators have no profile page, hence no
// entry, and get a 403 from both handlers below.
const ROLE_PROFILES = {
  tutor: {
    table: "tutors",
    label: "tutor",
    studentNumberColumn: "student_number",
  },
  student: {
    table: "students",
    label: "student",
    studentNumberColumn: "student_no",
  },
  organiser: { table: null, label: "organiser", studentNumberColumn: null },
  super_organiser: {
    table: null,
    label: "organiser",
    studentNumberColumn: null,
  },
};

function shapeProfile(user, studentNumber) {
  return {
    id: user.id,
    name: user.name || "",
    email: user.email || "",
    studentNumber: studentNumber || "",
    cellPhone: user.cell_phone || "",
    role: user.role,
  };
}

// GET /api/profile/:userId — the signed-in tutor/volunteer's own details,
// combining the `users` row (name, email, cell phone) with the student
// number stored on their role table.
router.get("/:userId", async (req, res) => {
  const { data: user, error } = await supabase
    .from("users")
    .select("id, name, email, cell_phone, role")
    .eq("id", req.params.userId)
    .single();

  if (error || !user) return res.status(404).json({ error: "User not found" });

  const roleProfile = ROLE_PROFILES[user.role];
  if (!roleProfile) {
    return res.status(403).json({
      error: "Profiles are only available for tutors, student volunteers, and organisers",
    });
  }

  if (!roleProfile.table) {
    return res.json(shapeProfile(user, ""));
  }

  const { data: roleRow } = await supabase
    .from(roleProfile.table)
    .select(roleProfile.studentNumberColumn)
    .eq("id", user.id)
    .single();

  res.json(shapeProfile(user, roleRow?.[roleProfile.studentNumberColumn]));
});

// South African cell numbers, in the shapes people actually write them:
//   0821234567 / 082 123 4567         local (mobile ranges are 06x-08x)
//   +27 82 123 4567 / +27821234567    international
//   0027 82 123 4567                  international dialling prefix
// Grouping punctuation (spaces, parens, dots, dashes) is ignored. Landlines
// (021 ..., 011 ...) are rejected — this field is specifically a cell number.
function isValidSaCellPhone(value) {
  let cleaned = value.replace(/[\s().-]/g, "");
  if (cleaned.startsWith("0027")) cleaned = `+27${cleaned.slice(4)}`;
  else if (/^27[6-8][0-9]{8}$/.test(cleaned)) cleaned = `+${cleaned}`;
  return /^(?:\+27|0)[6-8][0-9]{8}$/.test(cleaned);
}

// PUT /api/profile/:userId — saves the editable details. Email is
// deliberately not editable: it's the Supabase Auth login identity, so
// changing it here would only make sign-in confusing (a hint on the page
// tells the user to ask an organiser instead).
router.put("/:userId", async (req, res) => {
  const { name, studentNumber, cellPhone } = req.body ?? {};

  const fields = {
    name: typeof name === "string" ? name.trim() : "",
    studentNumber:
      typeof studentNumber === "string" ? studentNumber.trim() : "",
    cellPhone: typeof cellPhone === "string" ? cellPhone.trim() : "",
  };

  if (fields.cellPhone && !isValidSaCellPhone(fields.cellPhone)) {
    return res.status(400).json({
      error:
        "Enter a valid South African cell phone number, e.g. 082 123 4567 or +27 82 123 4567",
    });
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, email, role")
    .eq("id", req.params.userId)
    .single();
  if (userError || !user) {
    return res.status(404).json({ error: "User not found" });
  }

  const roleProfile = ROLE_PROFILES[user.role];
  if (!roleProfile) {
    return res.status(403).json({
      error: "Profiles are only available for tutors, student volunteers, and organisers",
    });
  }

  // Organisers have no student number, so only roles with a role table
  // (tutor, student) require one.
  if (!fields.name || (roleProfile.table && !fields.studentNumber)) {
    return res.status(400).json({
      error: roleProfile.table
        ? "Your name and student number are required"
        : "Your name is required",
    });
  }

  // Role table first (when there is one): the student number's unique
  // constraint lives there, so a duplicate should abort the save before
  // anything else is written.
  if (roleProfile.table) {
    const { error: roleError } = await supabase
      .from(roleProfile.table)
      .update({
        name: fields.name,
        [roleProfile.studentNumberColumn]: fields.studentNumber,
      })
      .eq("id", user.id)
      .select(roleProfile.studentNumberColumn)
      .single();

    if (roleError) {
      if (roleError.code === "23505") {
        return res.status(409).json({
          error: "That student number is already used by another account",
        });
      }
      if (roleError.code === "PGRST116") {
        return res.status(500).json({
          error: `No ${roleProfile.label} record found for this account`,
        });
      }
      return res.status(500).json({ error: roleError.message });
    }
  }

  const { error: profileError } = await supabase
    .from("users")
    .update({
      name: fields.name,
      cell_phone: fields.cellPhone || null,
    })
    .eq("id", user.id);
  if (profileError) {
    return res.status(500).json({ error: profileError.message });
  }

  res.json({
    id: user.id,
    name: fields.name,
    email: user.email || "",
    studentNumber: fields.studentNumber,
    cellPhone: fields.cellPhone,
    role: user.role,
  });
});

module.exports = router;
