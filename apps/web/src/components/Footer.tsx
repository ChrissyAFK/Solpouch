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
              Manage budgets, set spending limits, and review purchases across
              your pouches.
            </p>
          </div>
          <nav className={styles.group} aria-label="Footer workspace">
            <h2>Workspace</h2>
            <Link href="/">Overview</Link>
            <Link href="/#pouches">Pouches</Link>
            <Link href="/#activity">Orders</Link>
            <Link href="/order">New order</Link>
          </nav>
          <nav className={styles.group} aria-label="Footer project">
            <h2>Project</h2>
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
        </div>
        <div className={styles.bottom}>
          <span>© 2026 Solpouch</span>
          <p>
            <span className={styles.demo}>Demo workspace</span>
            <span className={styles.separator} aria-hidden="true">
              ·
            </span>
            Payments are simulated. No real funds are transferred.
          </p>
        </div>
      </div>
    </footer>
  );
}
