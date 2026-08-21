const express = require("express");

const router = express.Router();


/* =========================
   REGISTER
   ========================= */

// POST /api/auth/register

// POST /api/auth/register

router.post("/register", async (req, res) => {

    try {

        const {
            email,
            password,
            name,
            role
        } = req.body;


        /* =========================
           Validate required fields
           ========================= */

        if (!email || !password || !name || !role) {

            return res.status(400).json({
                error:
                    "Email, password, name and role are required"
            });
        }


        /* =========================
           Validate Wits email
           ========================= */

        if (!email.toLowerCase().endsWith("@wits.ac.za")) {

            return res.status(400).json({
                error:
                    "You must use a Wits email address"
            });
        }


        /* =========================
           Validate role
           ========================= */

        const validRoles = [
            "student",
            "tutor",
            "educator",
            "organiser"
        ];


        const userRole = role.toLowerCase();


        if (!validRoles.includes(userRole)) {

            return res.status(400).json({
                error: "Invalid role"
            });
        }


        /* =========================
           Create authentication user
           ========================= */

        const { data, error } =
            await req.supabase.auth.signUp({
                email,
                password
            });


        if (error) {

            return res.status(400).json({
                error: error.message
            });
        }


        /* =========================
           Make sure user was created
           ========================= */

        if (!data.user) {

            return res.status(400).json({
                error: "User was not created"
            });
        }


        const userId = data.user.id;


        /* =========================
           Add user to users table
           ========================= */

        const { error: userError } =
            await req.supabase
                .from("users")
                .insert({
                    id: userId,
                    email: email,
                    name: name,
                    role: userRole
                });


        if (userError) {

            console.error(
                "Users table error:",
                userError
            );

            return res.status(500).json({
                error:
                    "User was created in authentication, but could not be added to the users table"
            });
        }


        /* =========================
           Add user to role table
           ========================= */

        let roleError;


        if (userRole === "student") {

            const { error } =
                await req.supabase
                    .from("students")
                    .insert({
                        id: userId
                    });

            roleError = error;

        }


        else if (userRole === "tutor") {

            const { error } =
                await req.supabase
                    .from("tutors")
                    .insert({
                        id: userId
                    });

            roleError = error;

        }


        else if (userRole === "educator") {

            const { error } =
                await req.supabase
                    .from("educators")
                    .insert({
                        id: userId
                    });

            roleError = error;

        }


        else if (userRole === "organiser") {

            const { error } =
                await req.supabase
                    .from("organisers")
                    .insert({
                        id: userId
                    });

            roleError = error;

        }


        /* =========================
           Check role table insertion
           ========================= */

        if (roleError) {

            console.error(
                "Role table error:",
                roleError
            );

            return res.status(500).json({
                error:
                    "User was created, but could not be added to their role table"
            });
        }


        /* =========================
           Successful registration
           ========================= */

        res.status(201).json({

            message:
                "Registration successful",

            user: {

                id: userId,

                email: email,

                name: name,

                role: userRole

            }

        });


    } catch (error) {

        console.error(
            "Registration error:",
            error
        );

        res.status(500).json({
            error: "Internal server error"
        });
    }
});

/* =========================
   LOGIN
   ========================= */

// POST /api/auth/login

router.post("/login", async (req, res) => {

    try {

        const {
            email,
            password
        } = req.body;


        /* -------------------------
           Validate required fields
           ------------------------- */

        if (!email || !password) {

            return res.status(400).json({
                error:
                    "Email and password are required"
            });
        }


        /* -------------------------
           Authenticate with Supabase
           ------------------------- */

        const {
            data,
            error
        } = await req.supabase.auth.signInWithPassword({

            email,

            password

        });


        if (error) {

            return res.status(401).json({
                error: error.message
            });
        }


        /* -------------------------
           Make sure user exists
           ------------------------- */

        if (!data.user) {

            return res.status(401).json({
                error: "Login failed"
            });
        }


        /* -------------------------
           Successful login
           ------------------------- */

        res.status(200).json({

            message:
                "Login successful",

            user: {

                id: data.user.id,

                email: data.user.email

            },

            session: data.session

        });


    } catch (error) {

        console.error(
            "Login error:",
            error
        );

        res.status(500).json({
            error: "Internal server error"
        });
    }
});


module.exports = router;