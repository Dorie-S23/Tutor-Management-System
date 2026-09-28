// Shared by two pages: profile.html (tutor) and student-profile.html
// (student volunteer). Each declares which role it's for via data-page-role,
// the same convention calendar.js uses, so a user of the *other* role gets
// sent back to their own dashboard instead of landing on a page built for
// someone else. The form itself is identical on both pages — only the
// surrounding chrome differs.
import { requireRole } from "./storage.js";
import { highlightActiveTab, renderWelcomeHeading } from "./nav.js";

const pageRole = document.body.dataset.pageRole || "tutor";
const currentUser = requireRole(pageRole);
if (!currentUser) {
  throw new Error("Not authorized");
}

highlightActiveTab();
renderWelcomeHeading(currentUser.name);

const form = document.getElementById("profile-form");
const nameField = document.getElementById("profile-name");
const emailField = document.getElementById("profile-email");
const studentNumberField = document.getElementById("profile-student-number");
const cellPhoneField = document.getElementById("profile-cell-phone");
const saveBtn = document.getElementById("profile-save-btn");
const errorEl = document.getElementById("profile-error");

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

// South African cell numbers, in the shapes people actually write them
// (082 123 4567, +27 82 123 4567, 0027 82 123 4567, ...). Mirrors
// isValidSaCellPhone in server/routes/profile.js so the user gets feedback
// without a round-trip — the server still validates everything on save.
function isValidSaCellPhone(value) {
  let cleaned = value.replace(/[\s().-]/g, "");
  if (cleaned.startsWith("0027")) cleaned = `+27${cleaned.slice(4)}`;
  else if (/^27[6-8][0-9]{8}$/.test(cleaned)) cleaned = `+${cleaned}`;
  return /^(?:\+27|0)[6-8][0-9]{8}$/.test(cleaned);
}

// The save button starts disabled (see the markup) so a submit can't
// overwrite the stored details with an empty form before the fetch below
// has landed; `loaded` guards the same race on the submit handler itself.
let loaded = false;

async function loadProfile() {
  try {
    const res = await fetch(
      `/api/profile/${encodeURIComponent(currentUser.id)}`,
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Couldn't load your details.");

    nameField.value = body.name || "";
    emailField.value = body.email || "";
    studentNumberField.value = body.studentNumber || "";
    cellPhoneField.value = body.cellPhone || "";

    loaded = true;
    saveBtn.disabled = false;
  } catch (err) {
    showError(
      `${err.message || "Couldn't load your details right now."} — reload the page to try again.`,
    );
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!loaded) return;

  errorEl.hidden = true;

  // Fail fast on an invalid cell number instead of round-tripping to the
  // server just to be told the same thing.
  if (
    cellPhoneField.value.trim() &&
    !isValidSaCellPhone(cellPhoneField.value)
  ) {
    showError(
      "Enter a valid South African cell phone number, e.g. 082 123 4567 or +27 82 123 4567",
    );
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  try {
    const res = await fetch(
      `/api/profile/${encodeURIComponent(currentUser.id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameField.value,
          studentNumber: studentNumberField.value,
          cellPhone: cellPhoneField.value,
        }),
      },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Couldn't save your details.");

    // Refresh the session's copy so the welcome heading (and anything else
    // reading sessionStorage) shows the new name straight away.
    currentUser.name = body.name;
    sessionStorage.setItem("user", JSON.stringify(currentUser));
    renderWelcomeHeading(body.name);

    showToast("Your details have been saved.");
  } catch (err) {
    showError(err.message || "Couldn't save your details right now.");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save profile";
  }
});

loadProfile();
