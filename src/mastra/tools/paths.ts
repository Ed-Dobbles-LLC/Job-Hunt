import * as path from "path";
import * as fs from "fs";

export const WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT ||
  process.env.REPL_HOME ||
  path.resolve(process.cwd());

export function workspacePath(...segments: string[]): string {
  return path.join(WORKSPACE_ROOT, ...segments);
}

/**
 * Finds a public HTML file by trying multiple candidate paths.
 * Mastra's bundler copies code to .mastra/output/ so __dirname won't
 * contain the public/ folder. This helper walks up from __dirname and
 * also tries cwd-based paths until it finds the file.
 */
export function findPublicFile(filename: string): string | null {
  const candidates: string[] = [
    // 1. Relative to the bundle output (__dirname/public/)
    path.join(__dirname, "public", filename),
    // 2. workspacePath from cwd
    workspacePath("src", "mastra", "public", filename),
    // 3. Walk up from __dirname looking for src/mastra/public/
    ...walkUpCandidates(__dirname, path.join("src", "mastra", "public", filename)),
    // 4. Try cwd directly
    path.join(process.cwd(), "src", "mastra", "public", filename),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function walkUpCandidates(startDir: string, relativePath: string): string[] {
  const results: string[] = [];
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    dir = path.dirname(dir);
    results.push(path.join(dir, relativePath));
  }
  return results;
}
