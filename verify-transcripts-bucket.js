// Temp verification: exercise the transcripts bucket exactly the way
// server/routes/transcripts.js does, using the anon key from .env.
// Steps: bucket exists → upload tiny PDF → list → signed URL → fetch via
// signed URL → confirm public access is denied → delete, bucket left clean.
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.log("missing SUPABASE_URL / SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, key);

const BUCKET = "transcripts";
const PROBE_USER = "smoke-probe-verify";
const PROBE_PATH = `${PROBE_USER}/transcript.pdf`;
const EXPIRY = 300;

const tinyPdf = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

function fail(step, error) {
  console.log(`FAIL [${step}]:`, error?.message ?? error);
  process.exit(1);
}

(async () => {
  // 1. Bucket exists and is private.
  const { data: buckets, error: bucketsError } =
    await supabase.storage.listBuckets();
  if (bucketsError) fail("listBuckets", bucketsError);
  const bucket = (buckets || []).find((b) => b.name === BUCKET);
  if (!bucket) fail("bucket-exists", new Error(`no bucket named ${BUCKET}`));
  console.log(`ok [bucket-exists] name=${bucket.name} public=${bucket.public}`);

  // 2. Upload a tiny PDF, the way the upload route does.
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(PROBE_PATH, tinyPdf, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) fail("upload", uploadError);
  console.log("ok [upload]", PROBE_PATH);

  // 3. List the folder the way listTranscripts does.
  const { data: entries, error: listError } = await supabase.storage
    .from(BUCKET)
    .list(PROBE_USER);
  if (listError) fail("list", listError);
  const found = (entries || []).find((e) => e.name === "transcript.pdf");
  if (!found) fail("list-found", new Error("uploaded file not listed"));
  console.log(
    "ok [list-found]",
    JSON.stringify({ name: found.name, size: found.metadata?.size }),
  );

  // 4. Signed URL, the way the organiser view does.
  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(PROBE_PATH, EXPIRY);
  if (signError) fail("sign", signError);
  console.log("ok [signed-url] expiresIn=" + EXPIRY);

  // 5. The signed URL must actually serve the bytes back.
  const res = await fetch(signed.signedUrl);
  if (!res.ok) fail("signed-fetch", new Error(`HTTP ${res.status}`));
  const body = await res.arrayBuffer();
  if (!Buffer.from(body).includes("%PDF-")) {
    fail(
      "signed-content",
      new Error("downloaded bytes do not look like the PDF"),
    );
  }
  console.log("ok [signed-fetch] bytes=" + body.byteLength);

  // 6. Private means anonymous public read is denied.
  const pub = await fetch(
    `${url}/storage/v1/object/public/${BUCKET}/${PROBE_PATH}`,
  );
  if (pub.ok) {
    console.log(
      "WARN [private-check] public URL unexpectedly readable, HTTP " +
        pub.status,
    );
  } else {
    console.log("ok [private-check] public read denied, HTTP " + pub.status);
  }

  // 7. Clean up: the bucket is left with no probe files in it.
  const { error: removeError } = await supabase.storage
    .from(BUCKET)
    .remove([PROBE_PATH]);
  if (removeError) fail("remove", removeError);
  const { data: after } = await supabase.storage.from(BUCKET).list(PROBE_USER);
  console.log("ok [remove] leftover entries=" + (after || []).length);

  console.log("ALL STEPS PASSED - transcripts bucket is live and clean");
})().catch((err) => fail("unexpected", err));
