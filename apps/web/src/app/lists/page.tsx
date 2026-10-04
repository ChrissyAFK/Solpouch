"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Pouch } from "@solpouch/shared";
import { api, errMsg, type ShoppingList, type ShoppingListItem } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useAuth } from "@/components/AuthProvider";
import { ErrorBanner, btnPrimary, btnSecondary, card, input, label } from "@/components/ui";
import { StatePanel } from "@/components/StatePanel";

export default function ListsPage() {
  const { sessionKey } = useAuth();
  const router = useRouter();
  const mounted = useRef(true);
  const current = () => mounted.current && !!sessionKey && getToken() === sessionKey;
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [pouches, setPouches] = useState<Pouch[]>([]);
  const [pouchId, setPouchId] = useState("");
  const [editing, setEditing] = useState<ShoppingList | null>(null);
  const [name, setName] = useState("");
  const [items, setItems] = useState<ShoppingListItem[]>([{ name: "", qty: 1 }]);
  const [temporary, setTemporary] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  async function load() {
    setLoading(true); setError(null);
    try { const [saved, available, status] = await Promise.all([api.shoppingLists(), api.pouches(), api.shoppingListStatus().catch(() => null)]); if (current()) { setLists(saved); setPouches(available); setTemporary(status?.temporary ?? null); } }
    catch (e) { if (current()) setError(errMsg(e)); }
    finally { if (current()) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [sessionKey]);
  function reset() { setEditing(null); setName(""); setItems([{ name: "", qty: 1 }]); }
  async function run(action: () => Promise<void>) {
    if (busy || !current()) return;
    setBusy(true); setError(null); setNotice("");
    try { await action(); } catch (e) { if (current()) setError(errMsg(e)); }
    finally { if (current()) setBusy(false); }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const body = { name: name.trim(), items: items.map(i => ({ name: i.name.trim(), qty: i.qty })) };
      const result = editing ? await api.updateShoppingList(editing.id, { ...body, version: editing.version ?? 0 }) : await api.saveShoppingList(body);
      if (!current()) return;
      setLists(previous => [result, ...previous.filter(item => item.id !== result.id)]); reset(); setNotice("List saved.");
    });
  }
  return <div className="mx-auto max-w-5xl">
    <h1 className="text-3xl font-semibold">Shopping lists</h1>
    <p className="mt-3 mb-6 text-[var(--muted)]">Keep your usual groceries in one place. Reusing a list finds current matches and prices for a new cart.</p>
    <p className="mb-4 text-sm text-[var(--muted)]">{temporary === true ? "Lists in this demo reset when the server restarts." : temporary === null && !loading ? "We could not check whether this server keeps lists after a restart." : ""}</p>
    <ErrorBanner message={error} />
    {notice && <p role="status" className="mb-4">{notice}</p>}
    {loading ? <div className={card} aria-busy="true" role="status">Loading shopping lists…</div> : <div className="grid gap-6 md:grid-cols-2">
      <section className={card}>
        <h2 className="text-xl font-semibold mb-4">{editing ? "Edit list" : "Create a list"}</h2>
        <form onSubmit={save} className="space-y-4">
          <label className={label}>List name<input className={input} value={name} maxLength={80} required disabled={busy} onChange={e => setName(e.target.value)} placeholder="Weekly groceries" /></label>
          {items.map((item, index) => <div key={index} className="flex flex-wrap gap-2 items-end">
            <label className={`${label} flex-1 min-w-32`}>Item {index + 1}<input className={input} aria-label={`Item ${index + 1}`} value={item.name} maxLength={120} required disabled={busy} onChange={e => setItems(rows => rows.map((row, i) => i === index ? { ...row, name: e.target.value } : row))} /></label>
            <label className={`${label} w-20`}>Quantity<input className={input} aria-label={`Quantity ${index + 1}`} type="number" min={1} max={10000} step={1} required value={Number.isNaN(item.qty) ? "" : item.qty} disabled={busy} onChange={e => setItems(rows => rows.map((row, i) => i === index ? { ...row, qty: e.target.valueAsNumber } : row))} /></label>
            <button type="button" className={btnSecondary} disabled={busy || items.length === 1} aria-label={`Remove item ${index + 1}`} onClick={() => setItems(rows => rows.filter((_, i) => i !== index))}>Remove</button>
          </div>)}
          <button className={btnSecondary} type="button" disabled={busy || items.length >= 50} onClick={() => setItems(rows => [...rows, { name: "", qty: 1 }])}>Add item</button>
          <div className="flex gap-2"><button className={btnPrimary} disabled={busy || !name.trim() || items.some(i => !i.name.trim() || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 10000)}>{busy ? "Working…" : "Save list"}</button>{editing && <button type="button" className={btnSecondary} disabled={busy} onClick={reset}>Cancel editing</button>}</div>
        </form>
      </section>
      <section className="space-y-4" aria-label="Saved lists">
        <label className={label}>Pouch for new carts<select className={input} value={pouchId} disabled={busy} onChange={e => setPouchId(e.target.value)}><option value="">Select automatically</option>{pouches.map(p => <option key={p.id} value={p.id} disabled={p.frozen}>{p.name}{p.frozen ? " · Frozen" : ""}</option>)}</select></label>
        {!lists.length && <StatePanel title="No saved lists yet">Add the items you buy regularly, then save your list.</StatePanel>}
        {lists.map(list => <article key={list.id} className={card}>
          <h2 className="font-semibold text-lg">{list.name}</h2>
          <ul className="my-3 text-sm space-y-1">{list.items.map((item, i) => <li key={i}>{item.qty} × {item.name}</li>)}</ul>
          <div className="flex flex-wrap gap-2">
            <button className={btnPrimary} disabled={busy || !pouches.some(p => !p.frozen)} onClick={() => void run(async () => { const order = await api.draftShoppingList(list.id, list.version ?? 0, pouchId || undefined); if (current()) router.push(`/order?order=${encodeURIComponent(order.id)}`); })}>Build cart</button>
            <button className={btnSecondary} disabled={busy} onClick={() => { setEditing(list); setName(list.name); setItems(list.items.map(i => ({ ...i }))); setError(null); }}>Edit</button>
            <button className={btnSecondary} disabled={busy} onClick={() => setDeleteId(list.id)}>Delete</button>
          </div>
          {deleteId === list.id && <div className="mt-3" role="group" aria-label={`Delete ${list.name}`}><p>Delete this saved list?</p><div className="flex gap-2 mt-2"><button className={btnSecondary} disabled={busy} onClick={() => void run(async () => { await api.deleteShoppingList(list.id, list.version ?? 0); if (current()) { setLists(rows => rows.filter(row => row.id !== list.id)); setDeleteId(null); if (editing?.id === list.id) reset(); setNotice("List deleted."); } })}>Delete list</button><button className={btnSecondary} disabled={busy} onClick={() => setDeleteId(null)}>Keep list</button></div></div>}
        </article>)}
        {!pouches.some(p => !p.frozen) && <p className="text-sm text-[var(--muted)]">Create or unfreeze a pouch before building a cart.</p>}
        {error && <button className={btnSecondary} disabled={busy} onClick={() => void load()}>Reload saved lists</button>}
      </section>
    </div>}
  </div>;
}
