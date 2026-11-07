/**
 * A Convex error, stripped down to the sentence the function threw. Convex
 * wraps it as "[CONVEX M(dispatch:dispatch)] [Request ID: …] Server Error\n
 * Uncaught Error: <msg>\n    at …"; people and terminals see only <msg>.
 */
export function serverErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const uncaught = raw.match(/Uncaught \w*Error: ([^\n]+)/);
  if (uncaught) return uncaught[1];
  return raw.split("\n")[0];
}
