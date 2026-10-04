"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icons";
import { Footer } from "./Footer";
import { ChatWidget } from "./ChatWidget";
import { UserMenu } from "./AuthProvider";
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const pouchRoute =
    pathname === "/pouches" || pathname.startsWith("/pouches/");
  const orderRoute = pathname === "/order";
  const ordersRoute =
    pathname === "/orders" || pathname.startsWith("/orders/");
  const pageLabel =
    pathname === "/dashboard"
      ? "Overview"
      : pouchRoute
        ? "Pouches"
        : ordersRoute
          ? "Orders"
          : orderRoute
          ? "New order"
          : pathname === "/profile"
            ? "Profile"
            : "Workspace";

  function closeMenu(restoreFocus = false) {
    setMenuOpen(false);
    if (restoreFocus) menuToggle.current?.focus();
  }
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);
  useEffect(() => {
    const onHashChange = () => setMenuOpen(false);
    const screen = window.matchMedia("(max-width: 640px)");
    const onResize = () => {
      if (!screen.matches) setMenuOpen(false);
    };
    window.addEventListener("hashchange", onHashChange);
    screen.addEventListener("change", onResize);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      screen.removeEventListener("change", onResize);
    };
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        menuToggle.current?.focus();
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [menuOpen]);
  const links: {
    href: string;
    label: string;
    icon: IconName;
    active: boolean;
  }[] = [
    { href: "/dashboard", label: "Overview", icon: "grid", active: pathname === "/dashboard" },
    {
      href: "/pouches",
      label: "Pouches",
      icon: "pouch",
      active: pouchRoute,
    },
    { href: "/orders", label: "Orders", icon: "receipt", active: ordersRoute },
    {
      href: "/order",
      label: "New order",
      icon: "cart",
      active: orderRoute,
    },
  ];
  if (pathname === "/") return <>{children}</>;
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <Link
            href="/"
            className="brand"
            aria-label="Solpouch home"
            onClick={() => closeMenu(menuOpen)}
          >
            <span className="brand-bars" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            solpouch
          </Link>
          <button
            type="button"
            ref={menuToggle}
            className="mobile-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="workspace-navigation"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              aria-hidden="true"
            >
              {menuOpen ? (
                <path d="m6 6 12 12M6 18 18 6" />
              ) : (
                <path d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
            Menu
          </button>
        </div>
        <div className="workspace">
          <span className="workspace-avatar">S</span>
          <strong>Personal</strong>
        </div>
        <nav
          id="workspace-navigation"
          aria-label="Main navigation"
          className={`main-nav ${menuOpen ? "mobile-menu-open" : ""}`}
        >
          {links.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              onClick={() => closeMenu(menuOpen)}
              className={`nav-link ${l.active ? "active" : ""}`}
              aria-current={l.active ? "page" : undefined}
            >
              <Icon name={l.icon} size={17} />
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" /> Personal
        </div>
      </aside>
      <div
        className="app-body"
        style={{ display: "flex", flexDirection: "column" }}
      >
        <header className="topbar">
          <div className="breadcrumb">
            Personal <span>/</span>
            <strong>{pageLabel}</strong>
          </div>
          <span className="demo-label">Payments on Solana</span>
          <UserMenu />
        </header>
        <main
          id="main-content"
          className="main-content"
          style={{
            width: "100%",
            flex: "1 0 auto",
            marginTop: 0,
            marginBottom: 0,
          }}
        >
          {children}
        </main>
        <Footer />
        <ChatWidget />
      </div>
    </div>
  );
}
