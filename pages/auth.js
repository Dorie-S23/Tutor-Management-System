const registerForm = document.getElementById("register-form");

if (registerForm) {

    registerForm.addEventListener("submit", function (event) {

        event.preventDefault();

        const password = document.getElementById("password").value;
        const confirmPassword =
            document.getElementById("confirm-password").value;

        const message =
            document.getElementById("register-message");

        if (password !== confirmPassword) {

            message.textContent = "Passwords do not match.";
            message.style.color = "red";

            return;
        }

        message.textContent = "Registration details are valid.";
        message.style.color = "green";

        // API request will go here later
    });
}