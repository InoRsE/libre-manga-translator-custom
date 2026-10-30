import fs from "fs";
import path from "path";

/**
 * Dynamically resolves the Gemini API key from environment variable
 * or local extension storage without hardcoding secrets in repository source files.
 */
export function getBenchmarkApiKey(): string {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0) {
    return process.env.GEMINI_API_KEY.trim();
  }
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_API_KEY.trim().length > 0) {
    return process.env.GOOGLE_API_KEY.trim();
  }

  // Fall back to inspect local unpacked extension LevelDB storage
  const storageDir = path.join(
    process.env.LOCALAPPDATA || "",
    "Google/Chrome/User Data/Default/Local Extension Settings/flcbljdelikjplgoilhmdhjilcfgkpke"
  );

  if (fs.existsSync(storageDir)) {
    const files = ["000005.ldb", "000004.log"];
    for (const f of files) {
      const p = path.join(storageDir, f);
      if (fs.existsSync(p)) {
        const b = fs.readFileSync(p);
        const match = b.toString("utf8").match(/AQ\.[a-zA-Z0-9_\-]{40,60}|AIzaSy[a-zA-Z0-9_\-]{33}/);
        if (match) {
          return match[0];
        }
      }
    }
  }

  throw new Error("No Gemini API key found in environment or local extension storage.");
}
