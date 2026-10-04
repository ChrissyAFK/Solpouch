"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import styles from "./LandingNav.module.css";
import { useAuth } from "./AuthProvider";

export function LandingNav() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const onChange = () => {
      if (!media.matches) setOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function closeMenu() {
    setOpen(false);
    if (open) toggle.current?.focus();
  }

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link
          href="/"
          className={styles.brand}
          aria-label="Solpouch home"
          onClick={closeMenu}
        >
          <span className="brand-bars" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          solpouch
        </Link>
        <button
          ref={toggle}
          type="button"
          className={styles.toggle}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="landing-navigation"
          onClick={() => setOpen(!open)}
        >
          <span>Menu</span>
          <svg
            viewBox="0 0 20 20"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            {open ? (
              <path d="m5 5 10 10M5 15 15 5" />
            ) : (
              <path d="M3 6h14M3 13h14" />
            )}
          </svg>
        </button>
        <nav
          id="landing-navigation"
          className={`${styles.nav} ${open ? styles.open : ""}`}
          aria-label="Main navigation"
        >
          <a href="#how-it-works" onClick={closeMenu}>
            How it works
          </a>
          <a href="#questions" onClick={closeMenu}>
            Questions
          </a>
          <Link href="/dashboard" className={styles.launch} onClick={closeMenu}>
            {user ? "Open dashboard" : "Sign in"} <span aria-hidden="true">↗</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}
