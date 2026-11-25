const express = require("express");

const router = express.Router();

/* =========================================================
   ROLE ALIASES

   Accounts created before the Volunteer rename stored
   "student" in users.role — accept it as an alias so those
   accounts keep working while new signups use "volunteer".
   ========================================================= */

const ROLE_ALIASES = { student: "volunteer" };

const normaliseRole = (role) =>
  ROLE_ALIASES[String(role).toLowerCase()] || String(role).toLowerCase();

/* =========================================================
   STUDENT NUMBER FORMAT

   Volunteers and tutors must give a student number that is
   five to seven digits with no other characters.
   ========================================================= */

const STUDENT_NUMBER_RE = /^\d{5,7}$/;

/* =========================================================
   GENERATE STAFF ID

   Organisers don't choose their own staff ID - we assign
   one in the format "A" followed by 7 digits (e.g.
   A1234567), retrying on the rare chance of a collision.
   ========================================================= */

async function generateStaffId(supabase) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const digits = Math.floor(Math.random() * 10000000)
      .toString()
      .padStart(7, "0");

    const staffId = `A${digits}`;

    const { data: existing, error } = await supabase
      .from("organisers")
      .select("staff_id")
      .eq("staff_id", staffId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!existing) {
      return staffId;
    }
  }

  throw new Error("Could not generate a unique staff ID");
}

/* =========================================================
   REGISTER
   POST /api/auth/register
   ========================================================= */

router.post("/register", async (req, res) => {
  try {
    const { email, password, name, role, studentNumber } = req.body;

    /* =====================================================
           Validate required fields
           ===================================================== */

    if (!email || !password || !name || !role) {
      return res.status(400).json({
        error: "Email, password, name and role are required",
      });
    }

    /* =====================================================
           Validate role
           ===================================================== */

    const validRoles = ["volunteer", "tutor", "organiser"];

    const userRole = normaliseRole(role);

    if (!validRoles.includes(userRole)) {
      return res.status(400).json({
        error: "Invalid role",
      });
    }

    /* =====================================================
           Validate student number
           
           Students and tutors require a student number
           ===================================================== */

    if ((userRole === "volunteer" || userRole === "tutor") && !studentNumber) {
      return res.status(400).json({
        error: "Student number is required for volunteers and tutors",
      });
    }

    const trimmedStudentNumber =
      studentNumber == null ? "" : String(studentNumber).trim();

    if (
      (userRole === "volunteer" || userRole === "tutor") &&
      !STUDENT_NUMBER_RE.test(trimmedStudentNumber)
    ) {
      return res.status(400).json({
        error: "Student number must be 5–7 digits",
      });
    }

    /* =====================================================
           Validate organiser course

           Organiser access is granted one course at a time,
           so a new organiser has to say which course their
           request is for — the super-organiser approves or
           denies it before the account can sign in.
           ===================================================== */

    let courseId = null;

    if (userRole === "organiser") {
      courseId = Number(req.body.courseId);

      if (!courseId) {
        return res.status(400).json({
          error: "Choose the course you want to be an organiser for",
        });
      }

      const { data: course, error: courseError } = await req.supabase
        .from("courses")
        .select("id")
        .eq("id", courseId)
        .maybeSingle();

      if (courseError) {
        console.error("Course lookup error:", courseError);

        return res.status(500).json({
          error: "Could not check the course",
        });
      }

      if (!course) {
        return res.status(400).json({
          error: "That course does not exist",
        });
      }
    }

    /* =====================================================
           Create Supabase authentication user
           ===================================================== */

    const { data, error } = await req.supabase.auth.signUp({
      email,
      password,
    });

    if (error) {
      console.error("Supabase authentication error:", error);

      return res.status(400).json({
        error: error.message,
      });
    }

    /* =====================================================
           Make sure authentication user was created
           ===================================================== */

    if (!data.user) {
      return res.status(400).json({
        error: "User was not created",
      });
    }

    const userId = data.user.id;

    /* =====================================================
           Add user to users table
           
           Matches:
           
           users
           ----------------
           id
           email
           name
           role
           ===================================================== */

    const { error: userError } = await req.supabase.from("users").insert({
      id: userId,
      email: email,
      name: name,
      role: userRole,
      auth_provider: "password",
    });

    if (userError) {
      console.error("Users table error:", userError);

      return res.status(500).json({
        error:
          "User was created in authentication, but could not be added to the users table",

        details: userError.message,
        hint: userError.hint,
      });
    }

    /* =====================================================
           STUDENT
           
           students
           ----------------
           id
           name
           email
           student_no
           degree
           ===================================================== */

    if (userRole === "volunteer") {
      const { error: studentError } = await req.supabase
        .from("students")
        .insert({
          id: userId,
          name: name,
          email: email,
          student_no: trimmedStudentNumber,
        });

      if (studentError) {
        console.error("Students table error:", studentError);

        return res.status(500).json({
          error:
            "User was created, but could not be added to the students table",

          details: studentError.message,
          hint: studentError.hint,
        });
      }
    }

    /* =====================================================
           TUTOR
           
           tutors
           ----------------
           id
           student_number
           email
           name
           academic_level
           ===================================================== */
    else if (userRole === "tutor") {
      const { error: tutorError } = await req.supabase.from("tutors").insert({
        id: userId,
        student_number: trimmedStudentNumber,
        email: email,
        name: name,
      });

      if (tutorError) {
        console.error("Tutors table error:", tutorError);

        return res.status(500).json({
          error: "User was created, but could not be added to the tutors table",

          details: tutorError.message,
          hint: tutorError.hint,
        });
      }
    }

    /* =====================================================
           EDUCATOR
           
           educators
           ----------------
           id
           ===================================================== */
    else if (userRole === "educator") {
      const { error: educatorError } = await req.supabase
        .from("educators")
        .insert({
          id: userId,
        });

      if (educatorError) {
        console.error("Educators table error:", educatorError);

        return res.status(500).json({
          error:
            "User was created, but could not be added to the educators table",

          details: educatorError.message,
          hint: educatorError.hint,
        });
      }
    }

    /* =====================================================
           ORGANISER
           
           organisers
           ----------------
           id
           staff_id
           full_name
           email
           ===================================================== */
    else if (userRole === "organiser") {
      const staffId = await generateStaffId(req.supabase);

      const { error: organiserError } = await req.supabase
        .from("organisers")
        .insert({
          id: userId,
          staff_id: staffId,
          full_name: name,
          email: email,
        });

      if (organiserError) {
        console.error("Organisers table error:", organiserError);

        return res.status(500).json({
          error:
            "User was created, but could not be added to the organisers table",

          details: organiserError.message,
          hint: organiserError.hint,
        });
      }

      /* ===================================================
             File the access request the super-organiser
             reviews — until it's approved this organiser
             can't sign in (see POST /login).
             =================================================== */

      const { error: requestError } = await req.supabase
        .from("organiser_requests")
        .insert({
          user_id: userId,
          course_id: courseId,
          status: "pending",
        });

      if (requestError) {
        console.error("Organiser request error:", requestError);

        return res.status(500).json({
          error:
            "User was created, but the organiser request could not be saved",

          details: requestError.message,
        });
      }
    }

    /* =====================================================
           Successful registration
           ===================================================== */

    return res.status(201).json({
      message: "Registration successful",

      user: {
        id: userId,

        email: email,

        name: name,

        role: userRole,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

/* =========================================================
   GOOGLE LOGIN
   GET /api/auth/google
   ========================================================= */

router.get("/google", async (req, res) => {
  try {
    const { data, error } = await req.supabase.auth.signInWithOAuth({
      provider: "google",

      options: {
        redirectTo: `${req.protocol}://${req.get("host")}/html/google-callback.html`,

        // Force Google's account chooser every time instead of
        // silently reusing an already-signed-in browser session.
        queryParams: {
          prompt: "select_account",
        },
      },
    });

    if (error) {
      console.error("Google authentication error:", error);

      return res.status(400).json({
        error: error.message,
      });
    }

    return res.redirect(data.url);
  } catch (error) {
    console.error("Google login error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

/* =========================================================
   GOOGLE REGISTER
   POST /api/auth/google/register
   ========================================================= */

router.post("/google/register", async (req, res) => {
  try {
    const { name, role, studentNumber, accessToken } = req.body;

    /* =====================================================
           Validate required fields
           ===================================================== */

    if (!name || !role || !accessToken) {
      return res.status(400).json({
        error: "Name, role and authentication token are required",
      });
    }

    /* =====================================================
           Validate role
           ===================================================== */

    const validRoles = ["volunteer", "tutor", "organiser"];

    const userRole = normaliseRole(role);

    if (!validRoles.includes(userRole)) {
      return res.status(400).json({
        error: "Invalid role",
      });
    }

    /* =====================================================
           Validate student number
           
           Students and tutors require one.
           ===================================================== */

    if ((userRole === "volunteer" || userRole === "tutor") && !studentNumber) {
      return res.status(400).json({
        error: "Student number is required for volunteers and tutors",
      });
    }

    const trimmedStudentNumber =
      studentNumber == null ? "" : String(studentNumber).trim();

    if (
      (userRole === "volunteer" || userRole === "tutor") &&
      !STUDENT_NUMBER_RE.test(trimmedStudentNumber)
    ) {
      return res.status(400).json({
        error: "Student number must be 5–7 digits",
      });
    }

    /* =====================================================
           Verify the Google/Supabase user
           
           We create a Supabase client using the user's
           access token rather than trusting an ID supplied
           by the browser.
           ===================================================== */

    const { createClient } = require("@supabase/supabase-js");

    const authenticatedSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        global: {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      },
    );

    const { data: userData, error: userError } =
      await authenticatedSupabase.auth.getUser(accessToken);

    if (userError || !userData || !userData.user) {
      console.error("Google user verification error:", userError);

      return res.status(401).json({
        error: "Could not verify Google account",
      });
    }

    /* =====================================================
           Get verified user information
           ===================================================== */

    const authenticatedUser = userData.user;

    const userId = authenticatedUser.id;

    const email = authenticatedUser.email;

    /* =====================================================
           Validate organiser course

           Same rule as /register: organiser access is
           granted one course at a time, so the request has
           to name the course it's for.
           ===================================================== */

    let courseId = null;

    if (userRole === "organiser") {
      courseId = Number(req.body.courseId);

      if (!courseId) {
        return res.status(400).json({
          error: "Choose the course you want to be an organiser for",
        });
      }

      const { data: course, error: courseError } = await authenticatedSupabase
        .from("courses")
        .select("id")
        .eq("id", courseId)
        .maybeSingle();

      if (courseError) {
        console.error("Google course lookup error:", courseError);

        return res.status(500).json({
          error: "Could not check the course",
        });
      }

      if (!course) {
        return res.status(400).json({
          error: "That course does not exist",
        });
      }
    }

    /* =====================================================
           Make sure user isn't already registered
           ===================================================== */

    const { data: existingUser, error: existingUserError } = await req.supabase
      .from("users")
      .select("id")
      .eq("id", userId)
      .maybeSingle();

    if (existingUserError) {
      console.error("Existing user check error:", existingUserError);

      return res.status(500).json({
        error: "Could not check existing user",
      });
    }

    if (existingUser) {
      return res.status(409).json({
        error: "This Google account is already registered",
      });
    }

    /* =====================================================
           Add user to users table
           ===================================================== */

    const { error: userInsertError } = await authenticatedSupabase
      .from("users")
      .insert({
        id: userId,
        email: email,
        name: name,
        role: userRole,
        auth_provider: "google",
      });

    if (userInsertError) {
      console.error("Google users table error:", userInsertError);

      return res.status(500).json({
        error:
          "Google account was authenticated, but could not be added to the users table",

        details: userInsertError.message,

        hint: userInsertError.hint,
      });
    }

    /* =====================================================
           STUDENT
           ===================================================== */

    if (userRole === "volunteer") {
      const { error: studentError } = await authenticatedSupabase
        .from("students")
        .insert({
          id: userId,
          name: name,
          email: email,
          student_no: trimmedStudentNumber,
        });

      if (studentError) {
        console.error("Google student table error:", studentError);

        return res.status(500).json({
          error:
            "User was created, but could not be added to the students table",

          details: studentError.message,
        });
      }
    }

    /* =====================================================
           TUTOR
           ===================================================== */
    else if (userRole === "tutor") {
      const { error: tutorError } = await authenticatedSupabase
        .from("tutors")
        .insert({
          id: userId,
          student_number: trimmedStudentNumber,
          email: email,
          name: name,
        });

      if (tutorError) {
        console.error("Google tutor table error:", tutorError);

        return res.status(500).json({
          error: "User was created, but could not be added to the tutors table",

          details: tutorError.message,
        });
      }
    }

    /* =====================================================
           EDUCATOR
           ===================================================== */
    else if (userRole === "educator") {
      const { error: educatorError } = await authenticatedSupabase
        .from("educators")
        .insert({
          id: userId,
        });

      if (educatorError) {
        console.error("Google educator table error:", educatorError);

        return res.status(500).json({
          error:
            "User was created, but could not be added to the educators table",

          details: educatorError.message,
        });
      }
    }

    /* =====================================================
           ORGANISER
           ===================================================== */
    else if (userRole === "organiser") {
      const staffId = await generateStaffId(authenticatedSupabase);

      const { error: organiserError } = await authenticatedSupabase
        .from("organisers")
        .insert({
          id: userId,
          staff_id: staffId,
          full_name: name,
          email: email,
        });

      if (organiserError) {
        console.error("Google organiser table error:", organiserError);

        return res.status(500).json({
          error:
            "User was created, but could not be added to the organisers table",

          details: organiserError.message,
        });
      }

      /* ===================================================
             File the pending access request (same as
             /register) — it's reviewed by the
             super-organiser before sign-in is allowed.
             =================================================== */

      const { error: requestError } = await authenticatedSupabase
        .from("organiser_requests")
        .insert({
          user_id: userId,
          course_id: courseId,
          status: "pending",
        });

      if (requestError) {
        console.error("Google organiser request error:", requestError);

        return res.status(500).json({
          error:
            "User was created, but the organiser request could not be saved",

          details: requestError.message,
        });
      }
    }

    /* =====================================================
           SUCCESS
           ===================================================== */

    return res.status(201).json({
      message: "Google registration successful",

      user: {
        id: userId,

        email: email,

        name: name,

        role: userRole,
      },
    });
  } catch (error) {
    console.error("Google registration error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

/* =========================================================
   LOGIN
   POST /api/auth/login
   ========================================================= */

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    /* =====================================================
           Validate required fields
           ===================================================== */

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    /* =====================================================
           Authenticate with Supabase
           ===================================================== */

    const { data, error } = await req.supabase.auth.signInWithPassword({
      email,

      password,
    });

    if (error) {
      console.error("Supabase login error:", error);

      // Supabase intentionally returns the same generic error for "wrong
      // password" and "this account has no password" (it never confirms
      // whether an email is registered, to prevent account enumeration).
      // We can still give a more useful message for the one case we do
      // know about — an account that signed up through Google — since
      // that's recorded in our own users table, not Supabase's.
      const { data: existingUser } = await req.supabase
        .from("users")
        .select("auth_provider")
        .eq("email", email)
        .maybeSingle();

      if (existingUser?.auth_provider === "google") {
        return res.status(401).json({
          error: "You signed up with Google — please sign in with Google.",
        });
      }

      return res.status(401).json({
        error: error.message,
      });
    }

    /* =====================================================
           Make sure user exists
           ===================================================== */

    if (!data.user) {
      return res.status(401).json({
        error: "Login failed",
      });
    }

    /* =====================================================
           Get user's role from users table

           users
           ----------------
           id
           email
           name
           role
           ===================================================== */

    const { data: profile, error: profileError } = await req.supabase
      .from("users")
      .select("name, role")
      .eq("id", data.user.id)
      .single();

    if (profileError) {
      console.error("Error retrieving user profile:", profileError);

      return res.status(500).json({
        error: "Could not retrieve user role",

        details: profileError.message,

        hint: profileError.hint,
      });
    }

    /* =====================================================
           Make sure role exists
           ===================================================== */

    if (!profile || !profile.role) {
      return res.status(500).json({
        error: "User does not have a role",
      });
    }

    const userRole = normaliseRole(profile.role);

    /* =====================================================
           Organiser approval gate

           A pending or denied request blocks sign-in. An
           approved request carries the course access the
           board filters on; legacy organisers — registered
           before requests existed — have no rows at all and
           keep full access.
           ===================================================== */

    let courseIds;

    if (userRole === "organiser") {
      const { data: requests, error: requestsError } = await req.supabase
        .from("organiser_requests")
        .select("course_id, status")
        .eq("user_id", data.user.id);

      if (requestsError) {
        console.error("Organiser request lookup error:", requestsError);

        return res.status(500).json({
          error: "Could not check your organiser request",

          // Surfaces setup gaps plainly — e.g. a project that hasn't had the
          // organiser_requests table created yet (see Getting Started).
          details: requestsError.message,
        });
      }

      const rows = requests || [];

      if (rows.length > 0) {
        const approved = rows.filter((row) => row.status === "approved");

        if (approved.length > 0) {
          courseIds = approved.map((row) => row.course_id);
        } else if (rows.some((row) => row.status === "pending")) {
          return res.status(403).json({
            error:
              "Your organiser request is still awaiting approval — you can sign in once the super-organiser approves it.",
          });
        } else {
          return res.status(403).json({
            error: "Your organiser request was denied.",
          });
        }
      }
    }

    /* =====================================================
           Successful login
           ===================================================== */

    return res.status(200).json({
      message: "Login successful",

      user: {
        id: data.user.id,

        email: data.user.email,

        name: profile.name,

        // Legacy "student" rows are reported as "volunteer".
        role: userRole,

        // Approved courses an organiser is limited to. Absent for every
        // other role — and for legacy organisers, who keep full access.
        ...(courseIds ? { courseIds } : {}),
      },

      session: data.session,
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

/* =========================================================
   EXPORT ROUTER
   ========================================================= */

module.exports = router;
