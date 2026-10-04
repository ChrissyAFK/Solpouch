"use client";
import Link from "next/link";
import { useState } from "react";
import type { Pouch } from "@solpouch/shared";
import { toUsdc } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { btnPrimary, btnSecondary, usd } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { PouchGlyph } from "@/components/PouchGlyph";

/** Freeze/unfreeze with busy + notice state. `reload` refreshes the data. */
export function usePouchToggle(
  reload: () => Promise<void>,
  onError: (message: string) => void,
) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function toggle(p: Pouch) {
    setBusy(p.id);
    setNotice(null);
    try {
      await (p.frozen ? api.unfreeze(p.id) : api.freeze(p.id));
      await reload();
      setNotice(`${p.name} ${p.frozen ? "unfrozen" : "frozen"}.`);
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }
  return { busy, notice, setNotice, toggle };
}

export function PouchList({
  pouches,
  busy,
  onToggle,
}: {
  pouches: Pouch[];
  busy: string | null;
  onToggle: (p: Pouch) => void;
}) {
  return (
    <div className="pouch-table">
      <div className="pouch-table-head" aria-hidden="true">
        <span />
        <span>Pouch</span>
        <span>Balance</span>
        <span>Left today</span>
        <span>Status</span>
        <span />
      </div>
      {pouches.map((p) => {
        const left = Math.max(0, p.dailyLimit - p.spentToday);
        return (
        <article className="pouch-row" key={p.id}>
          <div className="pouch-glyph">
            <PouchGlyph
              name={p.name}
              remaining={toUsdc(left)}
              limit={toUsdc(p.dailyLimit)}
              size="sm"
              frozen={p.frozen}
            />
          </div>
          <div className="pouch-identity">
            <h3>
              <Link href={`/pouches/${p.id}`}>{p.name}</Link>
            </h3>
            <span>
              {p.allowedMerchantIds.length}{" "}
              {p.allowedMerchantIds.length === 1 ? "store" : "stores"} ·{" "}
              <span className="num">{usd(toUsdc(p.maxPerOrder))}</span> per order
            </span>
          </div>
          <div className="pouch-row-balance">
            <span className="mobile-label">Balance</span>
            <strong>{usd(toUsdc(p.balance))}</strong>
          </div>
          <div className="pouch-row-left">
            <span className="mobile-label">Left today</span>
            <strong>{usd(toUsdc(left))}</strong>
            <span>of {usd(toUsdc(p.dailyLimit))}</span>
          </div>
          <span className={`pouch-status ${p.frozen ? "is-frozen" : ""}`}>
            <span />
            {p.frozen ? "Frozen" : "Active"}
          </span>
          <div className="row-actions">
            <button
              disabled={busy === p.id}
              onClick={() => onToggle(p)}
              aria-label={`${p.frozen ? "Unfreeze" : "Freeze"} ${p.name}`}
            >
              {busy === p.id ? "Updating…" : p.frozen ? "Unfreeze" : "Freeze"}
            </button>
            <Link
              href={`/pouches/${p.id}#add-funds`}
              className={p.balance === 0 ? btnPrimary : btnSecondary}
              aria-label={`Add funds to ${p.name}`}
            >
              <Icon name="plus" size={14} /> Add funds
            </Link>
            <Link href={`/pouches/${p.id}`} aria-label={`Manage ${p.name}`}>
              Manage <Icon name="arrow" size={14} />
            </Link>
          </div>
        </article>
        );
      })}
    </div>
  );
}
