import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

/**
 * Get current file's directory, compatible with both ESM and CJS.
 */
function getCurrentDir(): string {
  try {
    // ESM: use import.meta.url
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS fallback (Mastra bundler may define __dirname)
    if (typeof __dirname !== "undefined") return __dirname;
    return process.cwd();
  }
}

/**
 * Detect the real project root. Mastra's bundler runs code from
 * .mastra/output/ so both __dirname and process.cwd() point there.
 * We find the project root by looking for package.json walking up.
 */
function detectProjectRoot(): string {
  let dir = getCurrentDir();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  // Fallback to env vars or cwd
  return process.env.WORKSPACE_ROOT || process.env.REPL_HOME || path.resolve(process.cwd());
}

export const WORKSPACE_ROOT = detectProjectRoot();

export function workspacePath(...segments: string[]): string {
  return path.join(WORKSPACE_ROOT, ...segments);
}

/**
 * Finds a public HTML file relative to the project root.
 */
export function findPublicFile(filename: string): string | null {
  const candidate = path.join(WORKSPACE_ROOT, "src", "mastra", "public", filename);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return null;
}
