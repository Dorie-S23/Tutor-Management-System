/* ============================================================
   Profile
   Student's own info and the subjects they can help with.
   Persisted to localStorage until this is wired to Supabase.
   ============================================================ */

// Namespaced by user id — a fixed key would leak one signed-in student's
// profile to whoever is signed in next on the same browser (localStorage is
// shared across the whole origin, not per-session like sessionStorage).
function currentUserId() {
  try {
    const raw = sessionStorage.getItem("user");
    return raw ? JSON.parse(raw).id : "anon";
  } catch {
    return "anon";
  }
}

function profileKey() {
  return `studentVolunteer.profile.${currentUserId()}`;
}

const DEFAULT_PROFILE = {
  fullName: "Dorsa",
  yearOfStudy: "",
  subjects: [],
  bio: "",
};

const form = document.getElementById("profileForm");
const fullNameEl = document.getElementById("fullName");
const yearOfStudyEl = document.getElementById("yearOfStudy");
const bioEl = document.getElementById("bio");
const subjectCheckboxes = Array.from(
  document.querySelectorAll('input[name="subject"]'),
);

function loadProfile() {
  const raw = localStorage.getItem(profileKey());
  if (!raw) return DEFAULT_PROFILE;
  try {
    return { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PROFILE;
  }
}

function fillForm(profile) {
  fullNameEl.value = profile.fullName;
  yearOfStudyEl.value = profile.yearOfStudy;
  bioEl.value = profile.bio;
  subjectCheckboxes.forEach((cb) => {
    cb.checked = profile.subjects.includes(cb.value);
  });
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const profile = {
    fullName: fullNameEl.value.trim(),
    yearOfStudy: yearOfStudyEl.value.trim(),
    subjects: subjectCheckboxes
      .filter((cb) => cb.checked)
      .map((cb) => cb.value),
    bio: bioEl.value.trim(),
  };
  localStorage.setItem(profileKey(), JSON.stringify(profile));
  showToast("Profile saved");
});

// ---------- toast ----------

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------- init ----------

fillForm(loadProfile());
