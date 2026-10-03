"use client";
import { useEffect } from "react";

/** Re-runs `load` every few seconds while the tab is visible, and right away when you come back to it,
 *  so orders placed by the voice agent show up without a reload. */
export function useLiveRefresh(load: () => Promise<void>, everyMs = 5000) {
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(tick, everyMs);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [load, everyMs]);
}
