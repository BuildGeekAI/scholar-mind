/**
 * Loads .env into process.env using Node's built-in loader (no dotenv needed).
 *
 * This lives in its own module and must be imported FIRST: ES module imports are
 * evaluated in source order, so a side-effect import is the only way to populate
 * process.env before other modules read it at their own module scope.
 *
 * A missing .env is fine — Cloud Run injects real environment variables.
 */
try {
  (process as any).loadEnvFile?.();
} catch {
  // No .env present; rely on the ambient environment.
}

if (!process.env.GEMINI_API_KEY) {
  console.warn(
    '\n  ⚠  GEMINI_API_KEY is not set. Search, generation, chat and speech will fail.\n' +
    '     Create a .env file in the project root containing:\n' +
    '       GEMINI_API_KEY=your-key-here\n' +
    '     then restart. See .env.example for the full list.\n'
  );
}

/**
 * Cloud Run sets K_SERVICE. If we are running there, the environment must say
 * so too, because `identity.ts` gates all authentication on NODE_ENV: without
 * it every caller resolves to the same dev identity and every profile collapses
 * into one shared namespace. `gcloud run deploy --set-env-vars` *replaces* the
 * whole variable set, so one deploy that forgets NODE_ENV would silently open
 * the app. Fail closed and loudly — a crashed revision is a far better outcome
 * than a serving one with no auth.
 */
const onCloudRun = !!process.env.K_SERVICE;

if (onCloudRun && process.env.NODE_ENV !== 'production') {
  throw new Error(
    `Refusing to start: running on Cloud Run (K_SERVICE=${process.env.K_SERVICE}) ` +
    `without NODE_ENV=production, which would disable IAP verification and make ` +
    `every request the same anonymous user. Redeploy with NODE_ENV=production set ` +
    `(note that --set-env-vars replaces the entire variable set).`
  );
}

/**
 * Sign-in moved to email and password, so an unset allowlist no longer means
 * "anyone with a Google account" — it means anyone who can receive email. New
 * users land in the demo org, where profiles default to org-visible, so an open
 * allowlist is a data exposure rather than a lax door policy.
 *
 * Fail closed and loudly, for the same reason as the NODE_ENV guard above: a
 * crashed revision is a far better outcome than a serving one that anybody can
 * sign into. Set AUTH_ALLOWED_DOMAINS to a domain list, or to `*` to say
 * deliberately that open registration is what you want.
 */
if (onCloudRun && !process.env.AUTH_ALLOWED_DOMAINS) {
  throw new Error(
    'Refusing to start: AUTH_ALLOWED_DOMAINS is not set, so anyone who can ' +
    'receive email could register and read every org-visible library. Set it to ' +
    'a comma-separated domain list, or to "*" to allow open registration on purpose.'
  );
}

// These two are recoverable, and IAP_AUDIENCE is deliberately set *after* the
// first deploy, so they warn rather than abort.
if (onCloudRun && !process.env.IAP_AUDIENCE) {
  console.warn(
    '\n  ⚠  IAP_AUDIENCE is not set. Every request will be rejected with 401 until\n' +
    '     it is, because an unverified identity header is never trusted.\n'
  );
}

if (onCloudRun && !process.env.GCS_BUCKET) {
  console.warn(
    '\n  ⚠  GCS_BUCKET is not set. Blobs are being written to container-local disk,\n' +
    '     which is discarded on every revision and not shared between instances.\n'
  );
}
