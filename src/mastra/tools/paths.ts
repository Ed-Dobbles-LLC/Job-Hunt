import * as path from "path";

export const WORKSPACE_ROOT =
  process.env.REPL_HOME || "/home/runner/workspace";

export function workspacePath(...segments: string[]): string {
  return path.join(WORKSPACE_ROOT, ...segments);
}
