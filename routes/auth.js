const express = require("express");

const router = express.Router();

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
           Validate Wits email
           ===================================================== */

    if (
      !email.toLowerCase().endsWith("@wits.ac.za") &&
      !email.toLowerCase().endsWith("@students.wits.ac.za")
    ) {
      return res.status(400).json({
        error: "You must use a Wits email address",
      });
    }

    /* =====================================================
           Validate role
           ===================================================== */

    const validRoles = ["student", "tutor", "educator", "organiser"];

    const userRole = role.toLowerCase();

    if (!validRoles.includes(userRole)) {
      return res.status(400).json({
        error: "Invalid role",
      });
    }

    /* =====================================================
           Validate student number
           
           Students and tutors require a student number
           ===================================================== */

    if ((userRole === "student" || userRole === "tutor") && !studentNumber) {
      return res.status(400).json({
        error: "Student number is required for students and tutors",
      });
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

    if (userRole === "student") {
      const { error: studentError } = await req.supabase
        .from("students")
        .insert({
          id: userId,
          name: name,
          email: email,
          student_no: studentNumber,
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
           hourly_rate
           academic_level
           ===================================================== */
    else if (userRole === "tutor") {
      const { error: tutorError } = await req.supabase.from("tutors").insert({
        id: userId,
        student_number: studentNumber,
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

        const { data, error } =
            await req.supabase.auth.signInWithOAuth({

                provider: "google",

                options: {
                    redirectTo: `${req.protocol}://${req.get("host")}/html/google-callback.html`,

                    // Force Google's account chooser every time instead of
                    // silently reusing an already-signed-in browser session.
                    queryParams: {
                        prompt: "select_account"
                    }
                }

            });


        if (error) {

            console.error(
                "Google authentication error:",
                error
            );

            return res.status(400).json({
                error: error.message
            });
        }


        return res.redirect(data.url);

    }

    catch (error) {

        console.error(
            "Google login error:",
            error
        );

        return res.status(500).json({
            error: "Internal server error"
        });
    }

});




/* =========================================================
   GOOGLE REGISTER
   POST /api/auth/google/register
   ========================================================= */

router.post("/google/register", async (req, res) => {

    try {

        const {
            name,
            role,
            studentNumber,
            accessToken
        } = req.body;


        /* =====================================================
           Validate required fields
           ===================================================== */

        if (!name || !role || !accessToken) {

            return res.status(400).json({
                error:
                    "Name, role and authentication token are required"
            });
        }


        /* =====================================================
           Validate role
           ===================================================== */

        const validRoles = [
            "student",
            "tutor",
            "educator",
            "organiser"
        ];

        const userRole =
            role.toLowerCase();


        if (!validRoles.includes(userRole)) {

            return res.status(400).json({
                error: "Invalid role"
            });
        }


        /* =====================================================
           Validate student number
           
           Students and tutors require one.
           ===================================================== */

        if (
            (userRole === "student" ||
             userRole === "tutor") &&
            !studentNumber
        ) {

            return res.status(400).json({
                error:
                    "Student number is required for students and tutors"
            });
        }


        /* =====================================================
           Verify the Google/Supabase user
           
           We create a Supabase client using the user's
           access token rather than trusting an ID supplied
           by the browser.
           ===================================================== */

        const {
            createClient
        } = require("@supabase/supabase-js");


        const authenticatedSupabase =
            createClient(
                process.env.SUPABASE_URL,
                process.env.SUPABASE_ANON_KEY,
                {
                    global: {
                        headers: {
                            Authorization:
                                `Bearer ${accessToken}`
                        }
                    }
                }
            );


        const {
            data: userData,
            error: userError
        } =
            await authenticatedSupabase.auth.getUser(
                accessToken
            );


        if (
            userError ||
            !userData ||
            !userData.user
        ) {

            console.error(
                "Google user verification error:",
                userError
            );

            return res.status(401).json({
                error:
                    "Could not verify Google account"
            });
        }


        /* =====================================================
           Get verified user information
           ===================================================== */

        const authenticatedUser =
            userData.user;

        const userId =
            authenticatedUser.id;

        const email =
            authenticatedUser.email;


        /* =====================================================
           Validate Wits email
           ===================================================== */

        if (
            !email ||(!email.toLowerCase().endsWith("@wits.ac.za") && !email.toLowerCase().endsWith("@students.wits.ac.za"))
        ) {

            return res.status(400).json({
                error:
                    "You must use a Wits email address"
            });
        }


        /* =====================================================
           Make sure user isn't already registered
           ===================================================== */

        const {
            data: existingUser,
            error: existingUserError
        } =
            await req.supabase
                .from("users")
                .select("id")
                .eq("id", userId)
                .maybeSingle();


        if (existingUserError) {

            console.error(
                "Existing user check error:",
                existingUserError
            );

            return res.status(500).json({
                error:
                    "Could not check existing user"
            });
        }


        if (existingUser) {

            return res.status(409).json({
                error:
                    "This Google account is already registered"
            });
        }


        /* =====================================================
           Add user to users table
           ===================================================== */

        const {
            error: userInsertError
        } =
            await authenticatedSupabase
                .from("users")
                .insert({
                    id: userId,
                    email: email,
                    name: name,
                    role: userRole
                });


        if (userInsertError) {

            console.error(
                "Google users table error:",
                userInsertError
            );

            return res.status(500).json({
                error:
                    "Google account was authenticated, but could not be added to the users table",

                details:
                    userInsertError.message,

                hint:
                    userInsertError.hint
            });
        }


        /* =====================================================
           STUDENT
           ===================================================== */

        if (userRole === "student") {

            const {
                error: studentError
            } =
                await authenticatedSupabase
                    .from("students")
                    .insert({
                        id: userId,
                        name: name,
                        email: email,
                        student_no: studentNumber
                    });


            if (studentError) {

                console.error(
                    "Google student table error:",
                    studentError
                );

                return res.status(500).json({
                    error:
                        "User was created, but could not be added to the students table",

                    details:
                        studentError.message
                });
            }
        }


        /* =====================================================
           TUTOR
           ===================================================== */

        else if (userRole === "tutor") {

            const {
                error: tutorError
            } =
                await authenticatedSupabase
                    .from("tutors")
                    .insert({
                        id: userId,
                        student_number: studentNumber,
                        email: email,
                        name: name
                    });


            if (tutorError) {

                console.error(
                    "Google tutor table error:",
                    tutorError
                );

                return res.status(500).json({
                    error:
                        "User was created, but could not be added to the tutors table",

                    details:
                        tutorError.message
                });
            }
        }


        /* =====================================================
           EDUCATOR
           ===================================================== */

        else if (userRole === "educator") {

            const {
                error: educatorError
            } =
                await authenticatedSupabase
                    .from("educators")
                    .insert({
                        id: userId
                    });


            if (educatorError) {

                console.error(
                    "Google educator table error:",
                    educatorError
                );

                return res.status(500).json({
                    error:
                        "User was created, but could not be added to the educators table",

                    details:
                        educatorError.message
                });
            }
        }


        /* =====================================================
           ORGANISER
           ===================================================== */

        else if (userRole === "organiser") {

            const staffId =
                await generateStaffId(authenticatedSupabase);

            const {
                error: organiserError
            } =
                await authenticatedSupabase
                    .from("organisers")
                    .insert({
                        id: userId,
                        staff_id: staffId,
                        full_name: name,
                        email: email
                    });


            if (organiserError) {

                console.error(
                    "Google organiser table error:",
                    organiserError
                );

                return res.status(500).json({
                    error:
                        "User was created, but could not be added to the organisers table",

                    details:
                        organiserError.message
                });
            }
        }


        /* =====================================================
           SUCCESS
           ===================================================== */

        return res.status(201).json({

            message:
                "Google registration successful",

            user: {

                id: userId,

                email: email,

                name: name,

                role: userRole

            }

        });

    }


    catch (error) {

        console.error(
            "Google registration error:",
            error
        );

        return res.status(500).json({
            error:
                "Internal server error"
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

    /* =====================================================
           Successful login
           ===================================================== */

    return res.status(200).json({
      message: "Login successful",

      user: {
        id: data.user.id,

        email: data.user.email,

        name: profile.name,

        role: profile.role,
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
