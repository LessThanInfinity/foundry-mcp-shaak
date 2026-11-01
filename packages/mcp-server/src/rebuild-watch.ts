/**
 * Rebuild detection for the backend singleton.
 *
 * Every Claude session's wrapper shares one long-lived backend process, so after
 * `npm run build` that process would keep serving the old code (and old tool list)
 * until something killed it. The backend watches its own built file and exits
 * with REBUILD_EXIT_CODE once it changes; the next wrapper request then spawns
 * the new build.
 *
 * Kept in its own module so it can be unit-tested without importing backend.ts.
 */
import * as fs from 'fs';

/** Exit code the backend uses when it stops because its build changed. */
export const REBUILD_EXIT_CODE = 75;

export interface WatchForRebuildOptions {
  /** How often to stat the file (ms). */
  intervalMs?: number;
  /** Quiet period after the last change before firing, so a build can finish (ms). */
  settleMs?: number;
}

/**
 * Calls `onRebuild` once, after `file`'s modification time differs from its value
 * at the time of the call and has then been stable for `settleMs`.
 * Returns a function that stops watching.
 */
export function watchForRebuild(
  file: string,
  onRebuild: () => void,
  { intervalMs = 2000, settleMs = 3000 }: WatchForRebuildOptions = {}
): () => void {
  let initialMtime: number;
  try {
    initialMtime = fs.statSync(file).mtimeMs;
  } catch {
    return () => {};
  }

  let settleTimer: NodeJS.Timeout | null = null;
  let fired = false;

  const listener = (curr: fs.Stats): void => {
    // mtimeMs is 0 while the file is missing (e.g. mid-rewrite); wait for it to return.
    if (fired || curr.mtimeMs === 0 || curr.mtimeMs === initialMtime) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      fired = true;
      fs.unwatchFile(file, listener);
      onRebuild();
    }, settleMs);
  };

  fs.watchFile(file, { interval: intervalMs, persistent: false }, listener);

  return () => {
    if (settleTimer) clearTimeout(settleTimer);
    fs.unwatchFile(file, listener);
  };
}
