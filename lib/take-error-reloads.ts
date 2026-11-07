// Reload counter for the take page's error screen (take/error.tsx), so a
// page that keeps failing can't trap the student in a reload loop. Cleared
// once the take page (or the Module 2 intro) loads successfully.
export const TAKE_ERROR_MAX_RELOADS = 2;
const RELOAD_WINDOW_MS = 10 * 60 * 1000;

function key(testId: string | undefined) {
  return `sat-exam:take-error-reloads:${testId ?? "unknown"}`;
}

export function readTakeErrorReloads(testId: string | undefined): number {
  try {
    const raw = sessionStorage.getItem(key(testId));
    if (!raw) return 0;
    const { count, at } = JSON.parse(raw) as { count: number; at: number };
    return Date.now() - at < RELOAD_WINDOW_MS ? count : 0;
  } catch {
    return 0;
  }
}

export function bumpTakeErrorReloads(testId: string | undefined) {
  try {
    sessionStorage.setItem(key(testId), JSON.stringify({ count: readTakeErrorReloads(testId) + 1, at: Date.now() }));
  } catch {
    // storage blocked — the reload still works
  }
}

export function clearTakeErrorReloads(testId: string | undefined) {
  try {
    sessionStorage.removeItem(key(testId));
  } catch {
    // ignore
  }
}
