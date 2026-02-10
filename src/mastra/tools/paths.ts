import * as path from "path";
import * as fs from "fs";

/**
 * Detect the real project root. Mastra's bundler runs code from
 * .mastra/output/ so __dirname, import.meta.url, and process.cwd()
 * all point there. The bundler also creates its own package.json
 * inside .mastra/output, so we can't just walk up looking for one.
 *
 * Strategy:
 * 1. If WORKSPACE_ROOT env var is set, use it directly.
 * 2. Get a starting directory from process.cwd().
 * 3. If the path contains ".mastra", strip from ".mastra" onward — that's the project root.
 * 4. Otherwise walk up looking for a package.json that has a src/mastra directory
 *    (distinguishes the real project from .mastra/output's package.json).
 * 5. Final fallback: process.cwd().
 */
function detectProjectRoot(): string {
  // 1. Explicit env var takes priority
  if (process.env.WORKSPACE_ROOT) {
    return process.env.WORKSPACE_ROOT;
  }

  const cwd = process.cwd();

  // 2. If .mastra appears in the path, everything before it is the project root
  const mastraMarker = `${path.sep}.mastra${path.sep}`;
  const markerIdx = cwd.indexOf(mastraMarker);
  if (markerIdx !== -1) {
    const candidate = cwd.substring(0, markerIdx);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  // Also check if cwd ends with /.mastra
  if (cwd.endsWith(`${path.sep}.mastra`)) {
    const candidate = path.dirname(cwd);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  // 3. Walk up looking for package.json WITH a src/mastra directory
  //    (the real project root has this; .mastra/output does not)
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "src", "mastra"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }

  // 4. Fallback
  return process.env.REPL_HOME || path.resolve(cwd);
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
