export type SessionUser = {
  email: string; name?: string; picture?: string;
  wallet?: string;
};
const KEY = "solpouch.session";
type Stored = { token: string; user: SessionUser };
const listeners = new Set<() => void>();

export function readSession(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Stored;
    return v && typeof v.token === "string" && v.user ? v : null;
  } catch {
    return null;
  }
}
export function getToken(): string | null {
  return readSession()?.token ?? null;
}
export function writeSession(s: Stored) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
  listeners.forEach((l) => l());
}
export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  listeners.forEach((l) => l());
}
export function onSessionChange(fn: () => void) {
  listeners.add(fn);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}
