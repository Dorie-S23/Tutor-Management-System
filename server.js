require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const authRoutes = require("./routes/auth");
// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req,res,next) =>{
    req.supabase = supabase;
    next();
})

// Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    }
);



// Test route
app.get("/", (req, res) => {
    res.json({
        message: "Tutor Management System API is running"
    });
});

// Test Supabase connection
app.get("/api/test", async (req, res) => {
    const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .limit(1);

    if (error) {
        return res.status(500).json({
            error: error.message
        });
    }

    res.json({
        message: "Supabase connection successful",
        data: data
    });
});


app.use("/api/auth", authRoutes);

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

