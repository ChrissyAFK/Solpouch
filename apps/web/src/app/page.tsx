import Link from "next/link";
import { LandingNav } from "@/components/LandingNav";
import styles from "./landing.module.css";

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {diagonal ? (
        <path d="M6 18 18 6M6 6h12v12" />
      ) : (
        <path d="M4 12h15m-6-6 6 6-6 6" />
      )}
    </svg>
  );
}

export default function LandingPage() {
  return (
    <div className={styles.page}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <LandingNav />
      <main id="main-content">
        <section
          className={`${styles.wrap} ${styles.hero}`}
          aria-labelledby="hero-title"
        >
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              <span aria-hidden="true" /> A spending wallet for Solana
            </p>
            <h1 id="hero-title">
              Give every
              <br />
              purchase
              <br />a <span>limit.</span>
            </h1>
            <p className={styles.intro}>
              Separate your budgets. Set the rules. Get help with your shopping,
              and review every order before you approve it.
            </p>
            <div className={styles.actions}>
              <Link href="/dashboard" className={styles.primary}>
                Open dashboard <Arrow />
              </Link>
              <a href="#how-it-works" className={styles.textLink}>
                See how it works <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className={styles.demoNote}>
              Payments settle in USDC on Solana. Every order waits for your
              approval.
            </p>
          </div>
          <div className={styles.heroVisual}>
            <div className={styles.previewCaption}>
              <span>YOUR BUDGET, YOUR RULES</span>
              <span>Example</span>
            </div>
            <div className={styles.pouchPreview}>
              <div className={styles.pouchHeading}>
                <span className={styles.pouchMark} aria-hidden="true">
                  <svg
                    width="23"
                    height="26"
                    viewBox="0 0 24 28"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  >
                    <path d="M6 2h12l-2 6c5 4 6 7 6 11 0 5-4 7-10 7S2 24 2 19c0-4 1-7 6-11L6 2Z" />
                    <path d="M7 8h10M8 17h8M12 13v8" />
                  </svg>
                </span>
                <span>
                  Groceries<small>Budget pouch</small>
                </span>
                <span className={styles.active}>Active</span>
              </div>
              <p className={styles.balanceLabel}>Available balance</p>
              <p className={styles.balance}>
                300<span>.00</span> <small>USDC</small>
              </p>
              <dl className={styles.limits}>
                <div>
                  <dt>Per order</dt>
                  <dd>
                    120 <span>USDC</span>
                  </dd>
                </div>
                <div>
                  <dt>Daily limit</dt>
                  <dd>
                    150 <span>USDC</span>
                  </dd>
                </div>
              </dl>
              <div className={styles.storeRow}>
                <span>Allowed store</span>
                <strong>Mountain Market</strong>
              </div>
            </div>
            <div className={styles.receipt}>
              <div className={styles.receiptHeading}>
                <span>ORDER REVIEW</span>
                <span>01 / GROCERIES</span>
              </div>
              <p>“Eggs and bread for the week.”</p>
              <div className={styles.receiptLine}>
                <span>
                  Eggs <small>× 2</small>
                </span>
                <span>7.98</span>
              </div>
              <div className={styles.receiptLine}>
                <span>
                  Bread <small>× 1</small>
                </span>
                <span>2.49</span>
              </div>
              <div className={styles.receiptTotal}>
                <span>Example total</span>
                <strong>
                  10.47 <small>USDC</small>
                </strong>
              </div>
              <div className={styles.reviewNotice}>
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="m4 10 4 4 8-8" />
                </svg>{" "}
                Within limits. Waiting for your approval.
              </div>
            </div>
          </div>
        </section>

        <div
          className={`${styles.wrap} ${styles.principles}`}
          aria-label="Product principles"
        >
          <span>
            <b>01</b> Separate budgets
          </span>
          <span>
            <b>02</b> Clear spending limits
          </span>
          <span>
            <b>03</b> You approve the order
          </span>
        </div>

        <section
          id="how-it-works"
          className={`${styles.wrap} ${styles.how}`}
          aria-labelledby="how-title"
        >
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrow}>HOW IT WORKS</p>
            <h2 id="how-title">
              A little structure.
              <br />A lot more control.
            </h2>
            <p>
              A pouch is a budget with its own rules. Keep the grocery run
              separate from takeout or your next project.
            </p>
            <Link href="/pouches" className={styles.textLink}>
              Explore the pouches <Arrow />
            </Link>
          </div>
          <ol className={styles.steps}>
            <li>
              <span className={styles.stepNumber}>01</span>
              <div>
                <h3>Give it a purpose.</h3>
                <p>
                  Name your pouch and choose a budget. See what is available
                  without mixing every expense together.
                </p>
              </div>
            </li>
            <li>
              <span className={styles.stepNumber}>02</span>
              <div>
                <h3>Set the boundaries.</h3>
                <p>
                  Choose allowed stores and set per-order and daily limits.
                  Freeze a pouch whenever you need to pause spending.
                </p>
              </div>
            </li>
            <li>
              <span className={styles.stepNumber}>03</span>
              <div>
                <h3>Review. Then approve.</h3>
                <p>
                  Describe what you need. Check the matched items and total,
                  then approve the order yourself.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section
          className={styles.shoppingSection}
          aria-labelledby="shopping-title"
        >
          <div className={`${styles.wrap} ${styles.shopping}`}>
            <div className={styles.requestExample}>
              <p className={styles.eyebrow}>FROM REQUEST TO REVIEW</p>
              <div className={styles.requestQuote}>
                <span aria-hidden="true">“</span>
                <p>
                  I need two cartons
                  <br />
                  of eggs and a loaf
                  <br />
                  of bread.
                </p>
              </div>
              <div className={styles.requestFlow}>
                <span>Your request</span>
                <span aria-hidden="true">→</span>
                <span>Matched items</span>
                <span aria-hidden="true">→</span>
                <strong>Your approval</strong>
              </div>
            </div>
            <div className={styles.shoppingCopy}>
              <p className={styles.eyebrow}>HELP WITH THE SHOPPING</p>
              <h2 id="shopping-title">
                Less searching.
                <br />
                Still your decision.
              </h2>
              <p>
                Start with a shopping list in your own words. Solpouch prepares
                a cart to review against your pouch&apos;s rules.
              </p>
              <p>
                Ask the assistant about balances and limits by text or voice, or
                have it build a cart for you. It can't move funds or approve
                purchases on its own.
              </p>
              <Link href="/order" className={styles.textLink}>
                Try a shopping request <Arrow />
              </Link>
              <p className={styles.smallNote}>
                Prices come from each store's catalog and are checked against
                your pouch before you pay.
              </p>
            </div>
          </div>
        </section>

        <section
          id="questions"
          className={`${styles.wrap} ${styles.faq}`}
          aria-labelledby="faq-title"
        >
          <div>
            <p className={styles.eyebrow}>A FEW THINGS TO KNOW</p>
            <h2 id="faq-title">
              Before you
              <br />
              jump in.
            </h2>
          </div>
          <div className={styles.questions}>
            <details>
              <summary>
                What do payments use?<span aria-hidden="true">+</span>
              </summary>
              <p>
                Pouches hold USDC on Solana. Each pouch is its own on-chain
                vault, so a payment can never take more than that pouch allows.
              </p>
            </details>
            <details>
              <summary>
                Can I freeze a pouch?<span aria-hidden="true">+</span>
              </summary>
              <p>
                Yes. Freeze any pouch from the dashboard and no order can be
                paid from it until you unfreeze it.
              </p>
            </details>
            <details>
              <summary>
                Can the AI spend for me?<span aria-hidden="true">+</span>
              </summary>
              <p>
                No. Chat can explain your pouch information and help you start a
                request. You review the cart and approve every order yourself.
              </p>
            </details>
            <details>
              <summary>
                What happens when an order exceeds a limit?
                <span aria-hidden="true">+</span>
              </summary>
              <p>
                The order is blocked if it exceeds the pouch&apos;s balance or
                spending limits, uses a store that is not allowed, or the pouch
                is frozen. Review the order or update the pouch rules before
                trying again.
              </p>
            </details>
            <details>
              <summary>
                Is my history saved?<span aria-hidden="true">+</span>
              </summary>
              <p>
                Pouches, orders, and balances are saved and waiting when you
                come back. Chat history stays in the current page and clears
                when you refresh.
              </p>
            </details>
          </div>
        </section>

        <section
          className={`${styles.wrap} ${styles.closing}`}
          aria-labelledby="closing-title"
        >
          <div>
            <p className={styles.eyebrow}>TAKE A LOOK AROUND</p>
            <h2 id="closing-title">
              Your next purchase.
              <br />
              <span>Your rules.</span>
            </h2>
          </div>
          <div className={styles.closingAction}>
            <Link href="/dashboard" className={styles.primary}>
              Open dashboard <Arrow diagonal />
            </Link>
            <p>
              Set up your first pouch
              <br />
              in under a minute.
            </p>
          </div>
        </section>
      </main>
      <footer className={styles.footer}>
        <div className={styles.wrap}>
          <div className={styles.footerTop}>
            <div className={styles.footerAbout}>
              <Link
                href="/"
                className={styles.brand}
                aria-label="Solpouch home"
              >
                <span className="brand-bars" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                solpouch
              </Link>
              <p>
                A place for every budget.
                <br />A limit for every purchase.
              </p>
            </div>
            <nav aria-label="Footer product">
              <h2>Explore</h2>
              <a href="#how-it-works">How it works</a>
              <Link href="/dashboard">Dashboard</Link>
              <Link href="/order">Create an order</Link>
            </nav>
            <nav aria-label="Footer resources">
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
              <a href="#questions">Questions</a>
            </nav>
          </div>
          <div className={styles.footerBottom}>
            <span>© 2026 Solpouch</span>
            <p>Budget pouches for USDC on Solana.</p>
            <a href="#main-content">
              Back to top <span aria-hidden="true">↑</span>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
