import Link from "next/link";
import styles from "./Footer.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.columns}>
          <div className={styles.about}>
            <Link href="/" className={styles.brand} aria-label="Solpouch home">
              <span className="brand-bars" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              solpouch
            </Link>
            <p>
              Budget pouches your assistant can shop from, paid in USDC on
              Solana.
            </p>
          </div>
          <nav className={styles.group} aria-label="Footer product">
            <h2>Product</h2>
            <Link href="/dashboard">Overview</Link>
            <Link href="/pouches">Pouches</Link>
            <Link href="/orders">Orders</Link>
            <Link href="/order">New order</Link>
          </nav>
          <nav className={styles.group} aria-label="Footer company">
            <h2>Company</h2>
            <Link href="/about">About</Link>
            <Link href="/contact">Contact</Link>
            <a
              href="https://github.com/ChrissyAFK/Solpouch"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub <span aria-hidden="true">↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a
              href="https://github.com/ChrissyAFK/Solpouch#readme"
              target="_blank"
              rel="noopener noreferrer"
            >
              Documentation <span aria-hidden="true">↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </nav>
          <nav className={styles.group} aria-label="Footer legal">
            <h2>Legal</h2>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/delete-account">Delete account</Link>
          </nav>
        </div>
        <div className={styles.bottom}>
          <span>2026 Solpouch</span>
          <p>Spend with a budget. You approve orders.</p>
        </div>
      </div>
    </footer>
  );
}
