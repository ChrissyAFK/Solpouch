"use client";
import { useEffect } from "react";
import { applyPrefs, PREFS_KEY, readPrefs } from "@/lib/preferences";

/** Re-applies saved display preferences after hydration and keeps the browser
 * theme-color in step when the device switches between light and dark. */
export function PrefsSync() {
  useEffect(() => {
    const apply = () => applyPrefs(readPrefs());
    apply();
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onStorage = (e: StorageEvent) => {
      if (e.key === PREFS_KEY || e.key === null) apply();
    };
    media.addEventListener("change", apply);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", apply);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}
