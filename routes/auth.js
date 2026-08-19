const express = require("express");

const router = express.Router();

// POST /api/auth/register
router.post("/register", async (req, res) => {
    try {
        const { email, password, name, role } = req.body;

        // Validate required fields
        if (!email || !password || !name || !role) {
            return res.status(400).json({
                error: "Email, password, name and role are required"
            });
        }

        // Validate role
        const validRoles = ["student", "tutor", "organiser"];

        if (!validRoles.includes(role.toLowerCase())) {
            return res.status(400).json({
                error: "Invalid role"
            });
        }

        // Create authentication user
        const { data, error } = await req.supabase.auth.signUp({
            email,
            password
        });

        if (error) {
            return res.status(400).json({
                error: error.message
            });
        }

        // Make sure Supabase returned a user
        if (!data.user) {
            return res.status(400).json({
                error: "User was not created"
            });
        }

        // Add user to public.users
        const { error: userError } = await req.supabase
            .from("users")
            .insert({
                id: data.user.id,
                email: email,
                name: name,
                role: role.toLowerCase()
            });

        if (userError) {
            console.error("Database error:", userError);

            return res.status(500).json({
                error: "User was created in authentication, but could not be added to the database"
            });
        }

        // Successful registration
        res.status(201).json({
            message: "Registration successful",
            user: {
                id: data.user.id,
                email: email,
                name: name,
                role: role.toLowerCase()
            }
        });

    } catch (error) {
        console.error("Registration error:", error);

        res.status(500).json({
            error: "Internal server error"
        });
    }
});


// POST /api/auth/login
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validate required fields
        if (!email || !password) {
            return res.status(400).json({
                error: "Email and password are required"
            });
        }

        // Authenticate user with Supabase
        const { data, error } = await req.supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            return res.status(401).json({
                error: error.message
            });
        }

        // Make sure a user was returned
        if (!data.user) {
            return res.status(401).json({
                error: "Login failed"
            });
        }

        // Return successful login
        res.status(200).json({
            message: "Login successful",
            user: {
                id: data.user.id,
                email: data.user.email
            },
            session: data.session
        });

    } catch (error) {
        console.error("Login error:", error);

        res.status(500).json({
            error: "Internal server error"
        });
    }
});

module.exports = router;
