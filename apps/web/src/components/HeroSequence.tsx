"use client";

import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import styles from "./HeroSequence.module.css";

type Row = { name: string; qty: string; amount: string };
type Scenario = {
  id: string;
  tab: string;
  merchant: string;
  transcript: string;
  rows: Row[];
  total: string;
  flagRow: number;
  flag: string;
  perOrder: string;
  leftToday: string;
  approve: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: "student",
    tab: "Student · Groceries",
    merchant: "Mountain Market",
    transcript: "Two cartons of eggs and a loaf of bread for this week.",
    rows: [
      { name: "Large white eggs, 12 ct", qty: "×2", amount: "$7.98" },
      { name: "Whole wheat bread", qty: "×1", amount: "$2.49" },
    ],
    total: "$10.47",
    flagRow: 0,
    flag: "Large brown eggs out of stock, swapped for large white. Check this.",
    perOrder: "$25.00",
    leftToday: "$39.53",
    approve: "Approve $10.47",
  },
  {
    id: "contractor",
    tab: "Contractor · Job materials",
    merchant: "Burnaby Builders Supply",
    transcript:
      "Forty eight-foot two-by-fours and three boxes of three-inch deck screws.",
    rows: [
      { name: "2x4 Stud 8ft SPF", qty: "×40", amount: "$170.00" },
      { name: "GRK Deck Screws 3in, 100 ct", qty: "×3", amount: "$44.97" },
    ],
    total: "$214.97",
    flagRow: 1,
    flag: "No brand named, picked GRK. Check this.",
    perOrder: "$250.00",
    leftToday: "$385.03",
    approve: "Approve $214.97",
  },
];

// Timeline in ms. The whole sequence is derived from one clock.
const T = {
  typeStart: 200,
  typeEnd: 1500,
  header: 1400,
  row0: 1650,
  row1: 2100,
  total: 2550,
  flag: 2950,
  check0: 3450,
  check1: 3850,
  stamp: 4250,
  approve: 4750,
  end: 5300,
};
const DONE = 1e9;

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x));
}
function easeOut(x: number) {
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
}
function at(t: number, start: number, dur: number) {
  return easeOut(clamp01((t - start) / dur));
}

const BARS = 28;
function idleBar(i: number) {
  return 0.22 + 0.2 * Math.abs(Math.sin(i * 1.3));
}

function Check({ p }: { p: number }) {
  return (
    <svg
      className={styles.check}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M2.5 8.5 6.5 12.5 13.5 3.5"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - p}
      />
    </svg>
  );
}

export function HeroSequence() {
  const [index, setIndex] = useState(0);
  const [run, setRun] = useState(0);
  // Starts at the animation's first frame, hidden until mounted, so there is no flash of the finished receipt.
  const [t, setT] = useState(0);
  const [mounted, setMounted] = useState(false);
  const s = SCENARIOS[index];

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setMounted(true);
    if (reduce) {
      setT(DONE);
      return;
    }
    const start = performance.now();
    let raf = 0;
    setT(0);
    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed >= T.end) {
        setT(DONE);
        return;
      }
      setT(elapsed);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, run]);

  const done = t === DONE;
  const typed = Math.round(
    clamp01((t - T.typeStart) / (T.typeEnd - T.typeStart)) * s.transcript.length,
  );
  const listening = !done && t < T.typeEnd + 150;
  const rowP = [at(t, T.row0, 450), at(t, T.row1, 450)];
  const headerP = at(t, T.header, 350);
  const totalP = at(t, T.total, 400);
  const flagP = at(t, T.flag, 500);
  const checkP = [at(t, T.check0, 350), at(t, T.check1, 350)];
  const stampP = at(t, T.stamp, 450);
  const approveP = at(t, T.approve, 450);

  const reveal = (p: number) => ({
    clipPath: `inset(0 0 ${(1 - p) * 100}% 0)`,
  });

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (index + (e.key === "ArrowRight" ? 1 : -1) + 2) % 2;
    setIndex(next);
    document.getElementById(`hero-tab-${SCENARIOS[next].id}`)?.focus();
  }

  return (
    <div className={mounted ? styles.stage : `${styles.stage} ${styles.pending}`}>
      <div className={styles.tabs} role="tablist" aria-label="Example scenario">
        {SCENARIOS.map((sc, i) => (
          <button
            key={sc.id}
            id={`hero-tab-${sc.id}`}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-controls="hero-panel"
            tabIndex={i === index ? 0 : -1}
            className={styles.tab}
            onClick={() => setIndex(i)}
            onKeyDown={onTabKey}
          >
            {sc.tab}
          </button>
        ))}
      </div>

      <div
        id="hero-panel"
        role="tabpanel"
        aria-labelledby={`hero-tab-${s.id}`}
        className={styles.field}
      >
        <div className={styles.voice}>
          <div className={styles.wave} aria-hidden="true">
            {Array.from({ length: BARS }, (_, i) => {
              const live = listening
                ? 0.2 +
                  0.8 * Math.abs(Math.sin(t / 95 + i * 0.75)) *
                    (0.55 + 0.45 * Math.sin(t / 210 + i))
                : idleBar(i);
              return (
                <i
                  key={i}
                  style={{ transform: `scaleY(${Math.max(0.12, live)})` }}
                />
              );
            })}
          </div>
          <p className={styles.transcript} aria-label={`You say: ${s.transcript}`}>
            <span aria-hidden="true">
              &ldquo;{s.transcript.slice(0, typed)}
              <span className={styles.rest}>{s.transcript.slice(typed)}</span>
              &rdquo;
            </span>
          </p>
        </div>

        <div className={styles.receipt}>
          <div className={styles.receiptHead} style={{ opacity: headerP }}>
            <span className={styles.merchant}>{s.merchant}</span>
            <span className={styles.example}>Example</span>
          </div>

          {s.rows.map((r, i) => (
            <div key={r.name}>
              <div className={styles.row} style={reveal(rowP[i])}>
                <span className={styles.item}>{r.name}</span>
                <span className={styles.qty}>{r.qty}</span>
                <span className={styles.amount}>{r.amount}</span>
              </div>
              {i === s.flagRow ? (
                <div
                  className={styles.flag}
                  style={{
                    opacity: flagP,
                    transform: `translateY(${(1 - flagP) * -6}px)`,
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8 2 15 14H1Z M8 6.5v3.5 M8 11.5v.5" />
                  </svg>
                  <span>{s.flag}</span>
                </div>
              ) : null}
            </div>
          ))}

          <div className={styles.total} style={{ opacity: totalP }}>
            <span>Total</span>
            <span className={styles.amount}>{s.total} USDC</span>
          </div>

          <ul className={styles.limits}>
            <li style={{ opacity: Math.max(0.0001, checkP[0]) }}>
              <span>Per order limit</span>
              <span className={styles.amount}>{s.perOrder}</span>
              <Check p={checkP[0]} />
            </li>
            <li style={{ opacity: Math.max(0.0001, checkP[1]) }}>
              <span>Left today</span>
              <span className={styles.amount}>{s.leftToday}</span>
              <Check p={checkP[1]} />
            </li>
          </ul>

          <div className={styles.verdict}>
            <div
              className={styles.stamp}
              style={{
                opacity: stampP,
                transform: `rotate(-6deg) scale(${1 + (1 - stampP) * 0.7})`,
              }}
            >
              Within limits
            </div>
            <div className={styles.approval} style={{ opacity: approveP }}>
              <span>Waiting for your approval</span>
              <span className={styles.approveBtn} aria-hidden="true">
                {s.approve}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.foot}>
        <p>An example, not a live order. Nothing is paid until you approve.</p>
        <button
          type="button"
          className={styles.replay}
          onClick={() => setRun((n) => n + 1)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8a5 5 0 1 0 1.8-3.8 M3 2.5v3h3" />
          </svg>
          Replay
        </button>
      </div>
    </div>
  );
}
