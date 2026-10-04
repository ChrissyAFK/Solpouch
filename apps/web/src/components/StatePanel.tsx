"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { btnPrimary, btnSecondary, card } from "./ui";

export function StatePanel({
  title,
  children,
  retry,
  home = false,
  newOrder = false,
  action,
}: {
  title: string;
  children: ReactNode;
  retry?: () => void;
  home?: boolean;
  newOrder?: boolean;
  // Optional primary link for a panel whose way forward is somewhere specific.
  action?: { href: string; label: string };
}) {
  return (
    <section className={`${card} space-y-5`} aria-label={title}>
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="text-sm leading-6 text-[var(--muted)]">{children}</div>
      <div className="flex flex-wrap gap-3">
        {retry && (
          <button type="button" className={btnPrimary} onClick={retry}>
            Try again
          </button>
        )}
        {action && (
          <Link href={action.href} className={btnPrimary}>
            {action.label}
          </Link>
        )}
        {home && (
          <Link href="/dashboard" className={btnSecondary}>
            Back to overview
          </Link>
        )}
        {newOrder && (
          <Link href="/order" className={btnSecondary}>
            New order
          </Link>
        )}
      </div>
    </section>
  );
}
