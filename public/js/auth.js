const API_URL = "http://localhost:3000";


/* =========================
   STUDENT NUMBER FIELD
   ========================= */

const roleSelect =
    document.getElementById("role");

const studentNumberGroup =
    document.getElementById("student-number-group");

const studentNumberInput =
    document.getElementById("student-number");

const staffIdGroup =
    document.getElementById("staff-id-group");

const staffIdInput =
    document.getElementById("staff-id");

if (roleSelect) {

    roleSelect.addEventListener("change", () => {

        if (roleSelect.value === "student" || roleSelect.value === "tutor") {

            // Show student number field
            studentNumberGroup.style.display = "block";

            // Make student number required
            studentNumberInput.required = true;

        }
        else if(roleSelect.value === "organiser"){
            staffIdGroup.style.display = "block";

            staffIdInput.required = true;
        } 
        
        
        else {

            // Hide student number field
            studentNumberGroup.style.display = "none";

            // Clear student number
            studentNumberInput.value = "";

            // No longer required
            studentNumberInput.required = false;
        }

    });
}



/* =========================
   REGISTER
   ========================= */

const registerForm =
    document.getElementById("register-form");


if (registerForm) {

    registerForm.addEventListener("submit", async (event) => {

        event.preventDefault();


        const name =
            document.getElementById("name").value.trim();

        const email =
            document.getElementById("email").value.trim();

        const password =
            document.getElementById("password").value;

        const confirmPassword =
            document.getElementById("confirm-password").value;

        const role =
            document.getElementById("role").value;

        const studentNumber =
            document.getElementById("student-number").value.trim();

        const message =
            document.getElementById("register-message");


        /* -------------------------
           Validate Wits email
           ------------------------- */

        if (!email.toLowerCase().endsWith("@wits.ac.za")) {

            message.textContent =
                "Please use a Wits email address.";

            message.style.color = "red";

            return;
        }


        /* -------------------------
           Check passwords
           ------------------------- */

        if (password !== confirmPassword) {

            message.textContent =
                "Passwords do not match.";

            message.style.color = "red";

            return;
        }


        /* -------------------------
           Check student number
           ------------------------- */

        if (role === "student" && !studentNumber) {

            message.textContent =
                "Student number is required for students.";

            message.style.color = "red";

            return;
        }


        message.textContent =
            "Creating your account...";

        message.style.color = "";


        try {

            const response = await fetch(
                `${API_URL}/api/auth/register`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type": "application/json"
                    },

                    body: JSON.stringify({
                        name,
                        email,
                        password,
                        role,
                        studentNumber
                    })
                }
            );


            const data =
                await response.json();


            /* -------------------------
               Handle registration error
               ------------------------- */

            if (!response.ok) {

                message.textContent =
                    data.error || "Registration failed.";

                message.style.color = "red";

                return;
            }


            /* -------------------------
               Registration successful
               ------------------------- */

            message.textContent =
                "Registration successful! Redirecting to login...";

            message.style.color = "green";


            setTimeout(() => {

                window.location.href =
                    "login.html";

            }, 1500);


        } catch (error) {

            console.error(
                "Registration error:",
                error
            );

            message.textContent =
                "Unable to connect to the server.";

            message.style.color = "red";
        }

    });
}



/* =========================
   LOGIN
   ========================= */

const loginForm =
    document.getElementById("login-form");


if (loginForm) {

    loginForm.addEventListener("submit", async (event) => {

        event.preventDefault();


        const email =
            document.getElementById("email").value.trim();

        const password =
            document.getElementById("password").value;

        const message =
            document.getElementById("login-message");


        message.textContent =
            "Logging in...";

        message.style.color = "";


        try {

            const response = await fetch(
                `${API_URL}/api/auth/login`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type": "application/json"
                    },

                    body: JSON.stringify({
                        email,
                        password
                    })
                }
            );


            const data =
                await response.json();


            /* -------------------------
               Handle login error
               ------------------------- */

            if (!response.ok) {

                message.textContent =
                    data.error || "Login failed.";

                message.style.color = "red";

                return;
            }


            /* -------------------------
               Login successful
               ------------------------- */

            message.textContent =
                "Login successful!";

            message.style.color = "green";


            /*
             * Store the Supabase access token
             * temporarily.
             */

            sessionStorage.setItem(
                "access_token",
                data.session.access_token
            );


            /*
             * Store the logged-in user's
             * information.
             */

            sessionStorage.setItem(
                "user",
                JSON.stringify(data.user)
            );


            /* -------------------------
               Redirect based on role
               ------------------------- */

            setTimeout(() => {

                switch (data.user.role) {

                    case "student":
                        window.location.href =
                            "student.html";
                        break;


                    case "tutor":
                        window.location.href =
                            "tutor.html";
                        break;


                    case "educator":
                        window.location.href =
                            "educator.html";
                        break;


                    case "organiser":
                        window.location.href =
                            "board.html";
                        break;


                    default:
                        window.location.href =
                            "index.html";
                        break;
                }

            }, 1000);


        } catch (error) {

            console.error(
                "Login error:",
                error
            );

            message.textContent =
                "Unable to connect to the server.";

            message.style.color = "red";
        }

    });
}