export type ThemePref = "auto" | "light" | "dark";
export type MotionPref = "auto" | "reduced";
export type TextSizePref = "default" | "large";

export type Prefs = {
  theme: ThemePref;
  motion: MotionPref;
  textSize: TextSizePref;
};

export const PREFS_KEY = "solpouch.prefs";
export const DEFAULT_PREFS: Prefs = {
  theme: "auto",
  motion: "auto",
  textSize: "default",
};

// Canvas colours, used for the browser's theme-color meta tag.
export const CANVAS_DARK = "#0d0d10";
export const CANVAS_LIGHT = "#f4f1ea";

export function readPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PREFS };
    const p = parsed as Record<string, unknown>;
    return {
      theme: p.theme === "light" || p.theme === "dark" ? p.theme : "auto",
      motion: p.motion === "reduced" ? "reduced" : "auto",
      textSize: p.textSize === "large" ? "large" : "default",
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be blocked; the choice then lasts until the page closes.
  }
}

function setAttr(el: HTMLElement, name: string, value: string | null) {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

export function applyPrefs(prefs: Prefs): void {
  const root = document.documentElement;
  setAttr(root, "data-theme", prefs.theme === "auto" ? null : prefs.theme);
  setAttr(root, "data-motion", prefs.motion === "reduced" ? "reduced" : null);
  setAttr(root, "data-text", prefs.textSize === "large" ? "large" : null);
  const light =
    prefs.theme === "light" ||
    (prefs.theme === "auto" &&
      window.matchMedia("(prefers-color-scheme: light)").matches);
  const color = light ? CANVAS_LIGHT : CANVAS_DARK;
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute("content", color));
}
