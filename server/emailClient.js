// Resend is the app's mail transport. Cloudflare Workers blocks outbound SMTP,
// so nodemailer and every other SMTP client simply cannot run here — email has
// to go over an HTTP API, and Resend's is a single POST with a bearer token.
const RESEND_EMAILS_URL = "https://api.resend.com/emails";

// Long enough to ride out a slow provider, short enough that a hung send can't
// pin a Worker isolate open. Email is a side channel next to the in-app
// notification: losing one is acceptable, stalling the request is not.
const RESEND_TIMEOUT_MS = 8000;

// Without a verified sending domain Resend only accepts this address as the
// sender, and only delivers to the email on the Resend account itself. That
// makes it the right default for local development, and the thing to change
// (via EMAIL_FROM) once a domain is verified.
const DEFAULT_FROM = "TutorX <onboarding@resend.dev>";

// Both values are read inside the call rather than at module load: on Workers
// the environment is injected per-request, while this file is required once at
// isolate boot — well before either variable is guaranteed to exist.
function sendConfig() {
  return {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM || DEFAULT_FROM,
  };
}

// Lets a caller bail before doing any of its own work — notificationEmails
// uses it to skip the recipient lookup entirely when email is switched off,
// rather than querying the users table on every notification for nothing.
function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

// Sends one email and resolves to { sent, reason }.
//
// The unconfigured case resolves rather than throws, and says so explicitly,
// because it's the normal state of a fresh clone — every notification in the
// app would otherwise log a warning on a machine that never set a key. A
// genuine provider or network failure does throw, leaving the caller to decide
// whether that's worth logging.
async function sendEmail({ to, subject, html, text }) {
  const { apiKey, from } = sendConfig();
  if (!apiKey) return { sent: false, reason: "not_configured" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });

    if (!response.ok) {
      // Resend answers failures with a JSON body naming the problem (bad key,
      // unverified sender, daily quota hit). Truncated because it gets logged,
      // and an HTML error page in a log line is unreadable.
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(`Resend answered ${response.status}: ${detail}`);
    }

    return { sent: true };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendEmail, isEmailConfigured };
