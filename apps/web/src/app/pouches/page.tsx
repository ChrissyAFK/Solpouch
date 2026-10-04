"use client";
import { StatePanel } from "@/components/StatePanel";
import { RowsSkeleton } from "@/components/Skeletons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Merchant, Pouch } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { useLiveRefresh } from "@/lib/useLiveRefresh";
import { PouchForm } from "@/components/PouchForm";
import { ErrorBanner, Notice, btnSecondary } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { PouchList, usePouchToggle } from "@/components/PouchList";

export default function PouchesPage() {
  const [pouches, setPouches] = useState<Pouch[] | null>(null);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const formRef = useRef<HTMLElement>(null);
  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setLoadError(false);
      setError(null);
    }
    try {
      const [p, m] = await Promise.all([api.pouches(), api.merchants()]);
      setPouches(p);
      setMerchants(m);
      setLoadError(false);
      setError(null);
    } catch (e) {
      if (!quiet) {
        setLoadError(true);
        setError(errMsg(e));
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(useCallback(() => load(true), [load]));
  useEffect(() => {
    if (showForm) {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      formRef.current?.querySelector("input")?.focus({ preventScroll: true });
    }
  }, [showForm]);
  const { busy, notice, setNotice, toggle } = usePouchToggle(
    useCallback(() => load(), [load]),
    setError,
  );
  return (
    <div className="overview">
      <div className="page-heading">
        <h1>Pouches</h1>
      </div>
      <ErrorBanner message={error} />
      {notice && <Notice>{notice}</Notice>}
      <section id="pouches" className="wallet-section">
        <div className="section-heading">
          <h2>
            Pouches{" "}
            <span className="section-count">{pouches?.length ?? "—"}</span>
          </h2>
          <button
            disabled={loading || loadError}
            onClick={() => setShowForm(true)}
            className={btnSecondary}
          >
            <Icon name="plus" size={15} /> Create pouch
          </button>
        </div>
        {loading && <RowsSkeleton />}
        {!loading && loadError && (
          <StatePanel
            title="Pouches couldn’t be loaded"
            retry={() => void load()}
          >
            Balances and spending controls are unavailable. Try again.
          </StatePanel>
        )}
        {!loading && !loadError && pouches?.length === 0 && (
          <p className="table-empty">
            No pouches yet. Create a pouch first, then add funds to it.
          </p>
        )}
        {!loading && !loadError && pouches && pouches.length > 0 && (
          <PouchList
            pouches={pouches}
            busy={busy}
            onToggle={(p) => void toggle(p)}
          />
        )}
        {showForm && !loading && !loadError && (
          <section
            className="sp-card create-form-panel"
            ref={formRef}
            aria-label="Create a pouch"
          >
            <div className="section-heading">
              <h2>Create pouch</h2>
              <button
                className={btnSecondary}
                onClick={() => setShowForm(false)}
              >
                Close
              </button>
            </div>
            <PouchForm
              merchants={merchants}
              withName
              submitLabel="Create pouch"
              onSubmit={async (v) => {
                // A failed create is shown by the form itself, so no page-level error here.
                await api.createPouch(v);
                setShowForm(false);
                await load();
                setNotice("Pouch created. Open it to add funds.");
              }}
            />
          </section>
        )}
      </section>
    </div>
  );
}
