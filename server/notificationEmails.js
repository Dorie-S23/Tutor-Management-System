const supabase = require("./supabaseClient");
const { sendEmail, isEmailConfigured } = require("./emailClient");

// The notification types worth an inbox ping, mapped to their subject line.
//
// The rule for inclusion: someone made a decision about you, or a deadline is
// approaching. That leaves out the high-volume routine traffic —
// `attendance_logged` fires for every session an organiser verifies — and the
// types that would only repeat an email already sent (`cover_found` echoes
// `swap_accepted`, `cover_cancelled` echoes `swap_accepted` from the other
// side). Anything not listed here stays in-app only, which is also the fate of
// any type added later: this map is the allowlist, so a new notification
// silently stays out of people's inboxes until someone decides it belongs.
const EMAIL_SUBJECTS = {
  application_status: "Your tutor application",
  volunteer_status: "Your volunteer application",
  timesheet_status: "Your timesheet",
  timesheet_due: "Timesheet not submitted",
  cover_assigned: "You're covering a session",
  organiser_request: "Organiser access request",
  session_change: "A session time changed",
  swap_request: "Someone asked you to cover a session",
  swap_accepted: "Your swap was accepted",
  swap_declined: "Your swap was declined",
};

const SUBJECT_PREFIX = "TutorX";

// Overridable so a preview deployment links to itself rather than to
// production. Read per-call, not at load, for the same Workers reason as the
// Resend config — env arrives after this module is required.
function appUrl() {
  return process.env.APP_URL || "https://tutorx.devden.workers.dev";
}

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Message text is built from database values a user can influence (a course
// name, another person's name), so it gets escaped before going anywhere near
// markup — otherwise a course code containing HTML would render as HTML in
// somebody's inbox.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

// users.name is a single full-name field; "Hi Jane," reads better in an email
// than "Hi Jane Smith," and a missing name falls back to no greeting at all
// rather than "Hi undefined,".
function firstNameOf(name) {
  const full = String(name ?? "").trim();
  return full ? full.split(/\s+/)[0] : "";
}

function buildBody(firstName, message) {
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const footer = `You're receiving this because something changed on your TutorX account.`;
  const url = appUrl();

  const text = `${greeting}\n\n${message}\n\n${footer}\n${url}`;

  // Inline styles only — most clients strip a <style> block, and this has to
  // survive Outlook as well as Gmail.
  const html = [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px 16px;">`,
    `<p style="margin:0 0 12px;">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 20px;">${escapeHtml(message)}</p>`,
    `<p style="margin:0 0 4px;"><a href="${escapeHtml(url)}" style="color:#1a56db;">Open TutorX</a></p>`,
    `<p style="margin:16px 0 0;font-size:13px;color:#6b7280;">${escapeHtml(footer)}</p>`,
    `</div>`,
  ].join("\n");

  return { text, html };
}

async function recipientOf(userId) {
  const { data, error } = await supabase
    .from("users")
    .select("email, name")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Sends the email twin of an in-app notification, addressed to that user.
//
// Every expected non-delivery resolves quietly instead of throwing: the type
// isn't on the allowlist, the user row is gone, the account has no email
// address, Resend isn't configured. notify() fires this without awaiting and
// without a response of its own to fail, so an undeliverable email has to be
// a non-event. Only a real provider or network failure throws, and the caller
// logs that.
async function emailNotification(userId, { type, message }) {
  const subject = EMAIL_SUBJECTS[type];
  // Configuration is checked before the recipient lookup, so an app with no
  // RESEND_API_KEY — a fresh clone, or the deployed Worker before the secret
  // is set — doesn't pay a users query for every notification it writes.
  if (!subject || !userId || !isEmailConfigured()) return;

  const user = await recipientOf(userId);
  if (!user?.email) return;

  const { text, html } = buildBody(firstNameOf(user.name), message);
  await sendEmail({
    to: user.email,
    subject: `${SUBJECT_PREFIX}: ${subject}`,
    html,
    text,
  });
}

module.exports = { emailNotification, EMAIL_SUBJECTS, buildBody };
