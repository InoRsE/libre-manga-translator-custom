/**
 * Secure Benchmark API Key Loader (M1.5.1 Section F)
 *
 * Resolves credentials strictly from explicit environment variables:
 * - process.env.GEMINI_API_KEY
 * - process.env.GOOGLE_API_KEY
 *
 * Never inspects raw browser storage or persistent database files.
 * Throws a helpful configuration error if no credential is provided in the environment.
 */
export function getBenchmarkApiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (key && key.trim().length > 0) {
    const trimmed = key.trim();
    if (/[^\x21-\x7e]/.test(trimmed)) {
      throw new Error(
        "GEMINI_API_KEY contains invalid non-ASCII characters. Re-export your API key cleanly.",
      );
    }
    return trimmed;
  }

  throw new Error(
    "Missing Gemini API key for benchmark execution.\n" +
      "Please set the GEMINI_API_KEY environment variable in your local terminal session:\n" +
      "  PowerShell: $env:GEMINI_API_KEY = 'your_api_key_here'\n" +
      "  Bash:       export GEMINI_API_KEY='your_api_key_here'",
  );
}
