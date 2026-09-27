const API_URL = "";

/*
 * Writes a status message into one of the #*-message elements and
 * toggles the state class that colours it (see auth-global.css).
 * kind: "error" | "success" | undefined for a neutral note.
 */
function setMessage(element, text, kind) {
  element.textContent = text;

  element.classList.toggle("is-error", kind === "error");

  element.classList.toggle("is-success", kind === "success");
}

/* =========================
   STUDENT NUMBER FIELD
   ========================= */

const roleSelect = document.getElementById("role");

const studentNumberGroup = document.getElementById("student-number-group");

const studentNumberInput = document.getElementById("student-number");

const googleRegisterButton = document.getElementById("google-register-button");

if (googleRegisterButton) {
  googleRegisterButton.addEventListener("click", async () => {
    try {
      window.location.href = "/api/auth/google";
    } catch (error) {
      console.error("Google registration error:", error);
    }
  });
}

if (roleSelect) {
  roleSelect.addEventListener("change", () => {
    if (roleSelect.value === "volunteer" || roleSelect.value === "tutor") {
      // Show student number field
      studentNumberGroup.style.display = "block";

      // Make student number required
      studentNumberInput.required = true;
    } else {
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
   FORGOT PASSWORD
   ========================= */

// The prototype shows a "Forgot password?" link but the app has no
// self-service reset — point users at their course administrator
// instead (shown in the login card's message area).
const forgotPasswordLink = document.getElementById("forgot-password-link");

if (forgotPasswordLink) {
  forgotPasswordLink.addEventListener("click", (event) => {
    event.preventDefault();

    const message = document.getElementById("login-message");

    if (message) {
      setMessage(
        message,
        "Please contact your course administrator to reset your password.",
        "error",
      );
    }
  });
}

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

    const confirmPassword = document.getElementById("confirm-password").value;

    const role = document.getElementById("role").value;

    const studentNumber = document
      .getElementById("student-number")
      .value.trim();

    const message = document.getElementById("register-message");

    /* -------------------------
           Validate Wits email
           ------------------------- */

    if (
      !email.toLowerCase().endsWith("@wits.ac.za") &&
      !email.toLowerCase().endsWith("@students.wits.ac.za")
    ) {
      setMessage(message, "Please use a Wits email address.", "error");

      return;
    }

    /* -------------------------
           Check passwords
           ------------------------- */

    if (password !== confirmPassword) {
      setMessage(message, "Passwords do not match.", "error");

      return;
    }

    /* -------------------------
           Check student number
           ------------------------- */

    if ((role === "volunteer" || role === "tutor") && !studentNumber) {
      setMessage(
        message,
        "Student number is required for volunteers and tutors.",
        "error",
      );

      return;
    }

    setMessage(message, "Creating your account...");

    try {
      const response = await fetch(`${API_URL}/api/auth/register`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          name,
          email,
          password,
          role,
          studentNumber,
        }),
      });

      const data = await response.json();

      /* -------------------------
               Handle registration error
               ------------------------- */

      if (!response.ok) {
        setMessage(message, data.error || "Registration failed.", "error");

        return;
      }

      /* -------------------------
               Registration successful
               ------------------------- */

      setMessage(
        message,
        "Registration successful! Redirecting to login...",
        "success",
      );

      setTimeout(() => {
        window.location.href = "login.html";
      }, 1500);
    } catch (error) {
      console.error("Registration error:", error);

      setMessage(message, "Unable to connect to the server.", "error");
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

    const email = document.getElementById("email").value.trim();

    const password = document.getElementById("password").value;

    const message = document.getElementById("login-message");

    setMessage(message, "Logging in...");

    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          email,
          password,
        }),
      });

      const data = await response.json();

      /* -------------------------
               Handle login error
               ------------------------- */

      if (!response.ok) {
        setMessage(message, data.error || "Login failed.", "error");

        return;
      }

      /* -------------------------
               Login successful
               ------------------------- */

      setMessage(message, "Login successful!", "success");

      /*
       * Store the Supabase access token
       * temporarily.
       */

      sessionStorage.setItem("access_token", data.session.access_token);

      /*
       * Store the logged-in user's
       * information.
       */

      sessionStorage.setItem("user", JSON.stringify(data.user));

      /* -------------------------
               Redirect based on role
               ------------------------- */

      setTimeout(() => {
        switch (data.user.role) {
          // Legacy accounts created before the Volunteer rename.
          case "student":
          case "volunteer":
            window.location.href = "StudentView.html";
            break;

          case "tutor":
            window.location.href = "dashboard.html";
            break;

          case "educator":
            window.location.href = "educator.html";
            break;

          case "organiser":
            window.location.href = "board.html";
            break;

          default:
            window.location.href = "index.html";
            break;
        }
      }, 1000);
    } catch (error) {
      console.error("Login error:", error);

      setMessage(message, "Unable to connect to the server.", "error");
    }
  });
}
