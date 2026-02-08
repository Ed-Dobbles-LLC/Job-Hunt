import * as path from "path";

export const WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT ||
  process.env.REPL_HOME ||
  path.resolve(process.cwd());

export function workspacePath(...segments: string[]): string {
  return path.join(WORKSPACE_ROOT, ...segments);
}
