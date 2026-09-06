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
