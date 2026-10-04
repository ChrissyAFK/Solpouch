"use client";
import { btnPrimary } from "./ui";

export function OfflineRetry() {
  return (
    <button type="button" className={btnPrimary} onClick={() => window.location.reload()}>
      Try again
    </button>
  );
}
