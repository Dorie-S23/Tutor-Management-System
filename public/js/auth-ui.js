/* UI-only helper for the auth pages: reveal / hide password fields.
   Kept deliberately separate from auth.js so the login and register
   logic (validation, API calls, redirects) stays exactly as it was —
   this script only flips the input type of the field each toggle
   button points at via its data-target attribute. */

document.querySelectorAll(".password-toggle").forEach((button) => {
  const input = document.getElementById(button.dataset.target);

  if (!input) {
    return;
  }

  button.addEventListener("click", () => {
    const revealed = input.type === "password";

    input.type = revealed ? "text" : "password";

    button.classList.toggle("is-revealed", revealed);

    button.setAttribute("aria-pressed", String(revealed));

    button.setAttribute(
      "aria-label",
      revealed ? "Hide password" : "Show password",
    );
  });
});
