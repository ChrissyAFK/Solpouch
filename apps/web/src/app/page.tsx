import Link from "next/link";
import { LandingNav } from "@/components/LandingNav";
import { HeroSequence } from "@/components/HeroSequence";
import { PouchGlyph } from "@/components/PouchGlyph";
import { pageMetadata, siteDescription } from "@/lib/site";
import styles from "./landing.module.css";

export const metadata = pageMetadata("Spending with limits", siteDescription, false);

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

const POUCHES = [
  {
    name: "Uber Eats",
    remaining: 18.4,
    limit: 40,
    tone: 1,
    purpose: "Dinner when the fridge is empty, and not a dollar more.",
    perOrder: "$20.00",
    daily: "$40.00",
    store: "Uber Eats",
  },
  {
    name: "Groceries",
    remaining: 139.53,
    limit: 150,
    tone: 0,
    purpose: "The weekly shop, asked for out loud and checked before it is paid.",
    perOrder: "$120.00",
    daily: "$150.00",
    store: "Mountain Market",
  },
  {
    name: "Deck rebuild",
    remaining: 385.03,
    limit: 600,
    tone: 2,
    purpose: "Job materials for one project, kept apart from everything else.",
    perOrder: "$250.00",
    daily: "$600.00",
    store: "Burnaby Builders Supply",
  },
];

const FAQ = [
  {
    q: "What do payments use?",
    a: "Pouches hold USDC on Solana. Each pouch is its own on-chain vault, so a payment can never take more than that pouch allows.",
  },
  {
    q: "Can I freeze a pouch?",
    a: "Yes. Freeze any pouch from the dashboard and no order can be paid from it until you unfreeze it.",
  },
  {
    q: "Can the AI spend for me?",
    a: "No. Chat can explain your pouch information and help you start a request. You approve orders yourself, unless you let a pouch pay small exact matches on its own. Voice and chat orders always wait for you.",
  },
  {
    q: "What happens when an order exceeds a limit?",
    a: "The order is blocked if it exceeds the pouch's balance or spending limits, uses a store that is not allowed, or the pouch is frozen. Review the order or update the pouch rules before trying again.",
  },
  {
    q: "Is my history saved?",
    a: "Pouches, orders, and balances are saved and waiting when you come back. Chat history stays in the current page and clears when you refresh.",
  },
];

export default function LandingPage() {
  return (
    <div className={`${styles.page} force-dark`}>
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
            <h1 id="hero-title">
              Give every purchase a <span>limit.</span>
            </h1>
            <p className={styles.intro}>
              Say what you need out loud. Solpouch finds the items and builds the
              order. Each pouch has its own wallet on Solana that enforces your
              limits, and orders wait for your approval unless you let a pouch pay small exact matches.
            </p>
            <div className={styles.actions}>
              <Link href="/dashboard" className={styles.primary}>
                Open dashboard <Arrow />
              </Link>
              <a href="#how" className={styles.textLink}>
                See how it works <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className={styles.demoNote}>
              Payments settle in USDC on Solana. You approve orders, and limits
              always apply.
            </p>
          </div>
          <HeroSequence />
        </section>

        <section
          className={`${styles.wrap} ${styles.pouches}`}
          aria-labelledby="pouches-title"
        >
          <h2 id="pouches-title" className={styles.display}>
            A pouch for every budget.
          </h2>
          <p className={styles.lede}>
            A pouch is a small wallet with rules. It holds what you put in,
            spends only where you allow, and shows what is left today.
          </p>
          <ul className={styles.pouchRow}>
            {POUCHES.map((p) => (
              <li key={p.name} className={styles.pouchItem}>
                <div className={`${styles.cardFace} ${styles[`tone${p.tone}`]}`}>
                  <span className={styles.chip} aria-hidden="true" />
                  <h3>{p.name}</h3>
                  <PouchGlyph
                    name={p.name}
                    remaining={p.remaining}
                    limit={p.limit}
                    tone={p.tone}
                    size="md"
                  />
                </div>
                <p className={styles.purpose}>{p.purpose}</p>
                <dl className={styles.rules}>
                  <div>
                    <dt>Per order</dt>
                    <dd>{p.perOrder}</dd>
                  </div>
                  <div>
                    <dt>Daily</dt>
                    <dd>{p.daily}</dd>
                  </div>
                  <div>
                    <dt>Allowed</dt>
                    <dd>{p.store}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </section>

        <section
          id="how"
          className={`${styles.wrap} ${styles.how}`}
          aria-labelledby="how-title"
        >
          <span id="how-it-works" />
          <h2 id="how-title" className={styles.display}>
            Ask. Check. Approve.
          </h2>
          <ol className={styles.rail}>
            <li>
              <h3>Ask</h3>
              <p>
                Pick a pouch and say or type what you need. Solpouch searches
                the store and builds a cart, and asks if something is unclear.
              </p>
            </li>
            <li>
              <h3>Check</h3>
              <p>
                Every line is shown against the pouch rules. Substitutions are
                flagged, and the order is blocked if it breaks a limit.
              </p>
            </li>
            <li>
              <h3>Approve</h3>
              <p>
                You approve the exact order, then the pouch pays in USDC on
                Solana. Pouches you set to pay small exact matches skip this step.
              </p>
            </li>
          </ol>
        </section>

        <section
          className={`${styles.wrap} ${styles.boundary}`}
          aria-labelledby="boundary-title"
        >
          <h2 id="boundary-title" className={styles.display}>
            It can ask. It cannot pay.
          </h2>
          <div className={styles.boundaryBody}>
            <p>
              The assistant can ask questions and build a cart. It cannot pay,
              and it cannot refill a pouch on its own. Refills are owner-only,
              and they wait out a waiting period first.
            </p>
            <Link href="/order" className={styles.textLink}>
              Create an order <Arrow diagonal />
            </Link>
          </div>
        </section>

        <section
          id="questions"
          className={`${styles.wrap} ${styles.faq}`}
          aria-labelledby="faq-title"
        >
          <h2 id="faq-title" className={styles.display}>
            Before you jump in.
          </h2>
          <div className={styles.questions}>
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>
                  {f.q}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section
          className={`${styles.wrap} ${styles.closing}`}
          aria-labelledby="closing-title"
        >
          <h2 id="closing-title">
            Your next purchase.
            <br />
            <span>Your rules.</span>
          </h2>
          <div className={styles.closingAction}>
            <Link href="/dashboard" className={styles.primary}>
              Open dashboard <Arrow diagonal />
            </Link>
            <p>Set up your first pouch in under a minute.</p>
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
              <a href="#how">How it works</a>
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
              <Link href="/about">About</Link>
              <Link href="/contact">Contact</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
            </nav>
          </div>
          <div className={styles.footerBottom}>
            <span>Solpouch</span>
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
