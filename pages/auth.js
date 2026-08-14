const API_URL = "http://localhost:3000";

/* =========================
   REGISTER
   ========================= */

const registerForm = document.getElementById("register-form");

if (registerForm) {

    registerForm.addEventListener("submit", async (event) => {

        event.preventDefault();

        const name = document.getElementById("name").value.trim();
        const email = document.getElementById("email").value.trim();
        const password = document.getElementById("password").value;
        const confirmPassword =
            document.getElementById("confirm-password").value;
        const role = document.getElementById("role").value;

        const message =
            document.getElementById("register-message");


        // Check passwords
        if (password !== confirmPassword) {

            message.textContent = "Passwords do not match.";
            message.style.color = "red";

            return;
        }


        message.textContent = "Creating your account...";
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
                        role
                    })
                }
            );


            const data = await response.json();


            if (!response.ok) {

                message.textContent =
                    data.error || "Registration failed.";

                message.style.color = "red";

                return;
            }


            message.textContent =
                "Registration successful! Redirecting to login...";

            message.style.color = "green";


            // Give the user a moment to see the message
            setTimeout(() => {
                window.location.href = "login.html";
            }, 1500);


        } catch (error) {

            console.error("Registration error:", error);

            message.textContent =
                "Unable to connect to the server.";

            message.style.color = "red";
        }

    });
}


/* =========================
   LOGIN
   ========================= */

const loginForm = document.getElementById("login-form");

if (loginForm) {

    loginForm.addEventListener("submit", async (event) => {

        event.preventDefault();

        const email =
            document.getElementById("email").value.trim();

        const password =
            document.getElementById("password").value;

        const message =
            document.getElementById("login-message");


        message.textContent = "Logging in...";
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


            const data = await response.json();


            if (!response.ok) {

                message.textContent =
                    data.error || "Login failed.";

                message.style.color = "red";

                return;
            }


            message.textContent =
                "Login successful!";

            message.style.color = "green";


            /*
             * Store the session temporarily.
             *
             * We will improve this when we implement
             * proper authentication/session handling.
             */
            sessionStorage.setItem(
                "access_token",
                data.session.access_token
            );

            sessionStorage.setItem(
                "user",
                JSON.stringify(data.user)
            );


            // Redirect after successful login
            setTimeout(() => {
                window.location.href = "index.html";
            }, 1000);


        } catch (error) {

            console.error("Login error:", error);

            message.textContent =
                "Unable to connect to the server.";

            message.style.color = "red";
        }

    });
}