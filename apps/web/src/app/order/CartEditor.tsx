"use client";
import { useEffect, useRef, useState } from "react";
import type { Order, Product } from "@solpouch/shared";
import { isCheckoutReference, toUsdc } from "@solpouch/shared";
import { api, errMsg } from "@/lib/api";
import { getToken } from "@/lib/session";
import { ErrorBanner, btnPrimary, btnSecondary, input, label, usd } from "@/components/ui";
export function CartEditor({ order, disabled, onSaved, onDirty }: { order: Order; disabled: boolean; onSaved: (order: Order) => void; onDirty: (dirty: boolean) => void }) {
  const [lines, setLines] = useState(order.lines.map((line, index) => ({ index, qty: line.qty, productId: line.product?.id })));
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const token = useRef(getToken());
  const current = () => mounted.current && getToken() === token.current;
  const original = order.lines.map((line, index) => ({ index, qty: line.qty, productId: line.product?.id }));
  const dirty = JSON.stringify(lines) !== JSON.stringify(original);
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy, onDirty]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    if (!isCheckoutReference(order)) api.products(order.merchantId).then(result => { if (active && current()) setProducts(result); }).catch(() => { if (active && current()) setCatalogError("Replacement options could not load. You can still change quantities or remove items."); });
    return () => { active = false; };
  }, [order.merchantId]);
  const matched = (index: number) => !!order.lines[index]?.product;
  // An unmatched line is kept once the shopper picks a replacement product for it.
  const matchedLines = lines.filter(l => matched(l.index) || !!l.productId);
  const hasUnmatched = order.lines.some(l => !l.product);
  const listItems = (() => {
    const found = order.lines.filter(l => l.product).map(l => ({ name: l.product!.name, qty: Math.min(10000, Math.max(1, l.qty)) }));
    return found.length > 0 ? found : order.lines.map(l => ({ name: l.requested, qty: Math.min(10000, Math.max(1, l.requestedQty || 1)) }));
  })();
  async function save() {
    if (busy || !current()) return;
    setBusy(true); setError(null); setNotice("");
    try { const result = await api.editOrder(order.id, order.version ?? 0, matchedLines); if (current()) { onDirty(false); onSaved(result); } }
    catch (cause) { if (current()) setError(errMsg(cause)); }
    finally { if (current()) setBusy(false); }
  }
  return <div className="my-5 border-y border-[var(--line-strong)] py-4" aria-label="Edit cart">
    <h3 className="font-semibold">Edit items</h3>
    <p className="my-2 text-sm text-[var(--muted)]">Save changes, then review the updated total before approving. Retailer checkout sets the final price and availability.</p>
    <ErrorBanner message={error} />
    {catalogError && <p role="status" className="text-sm">{catalogError}</p>}
    {lines.map(line => <div className="flex flex-wrap items-end gap-2 my-3" key={line.index}>
      <label className={`${label} flex-1 min-w-32`}>{order.lines[line.index].product?.name ?? order.lines[line.index].requested}
        {products.length > 0 && <select className={input} aria-label={`Product ${line.index + 1}`} value={line.productId ?? ""} disabled={busy || disabled} onChange={e => setLines(rows => rows.map(row => row.index === line.index ? { ...row, productId: e.target.value } : row))}>
          {!products.some(p => p.id === line.productId) && <option value={line.productId ?? ""}>Current item</option>}
          {products.map(p => <option key={p.id} value={p.id} disabled={!p.inStock}>{p.name} · {usd(toUsdc(p.unitPrice))} USDC{!p.inStock ? " · Out of stock" : ""}</option>)}
        </select>}
      </label>
      <label className={`${label} w-24`}>Quantity<input className={input} aria-label={`Cart quantity ${line.index + 1}`} type="number" min={1} max={10000} step={1} value={Number.isNaN(line.qty) ? "" : line.qty} disabled={busy || disabled || !matched(line.index)} onChange={e => setLines(rows => rows.map(row => row.index === line.index ? { ...row, qty: e.target.valueAsNumber } : row))} /></label>
      <button type="button" className={btnSecondary} aria-label={`Remove cart item ${line.index + 1}`} disabled={busy || disabled || lines.length === 1} onClick={() => setLines(rows => rows.filter(row => row.index !== line.index))}>Remove</button>
    </div>)}
    {dirty && <div className="flex gap-2 my-3"><button type="button" className={btnPrimary} disabled={busy || disabled || matchedLines.length === 0 || matchedLines.some(l => !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 10000)} onClick={() => void save()}>{busy ? "Saving…" : "Save cart changes"}</button><button className={btnSecondary} disabled={busy || disabled} onClick={() => { setLines(original); setError(null); }}>Discard changes</button></div>}
    <div className="flex flex-wrap gap-2 items-end mt-4">
      <label className={`${label} flex-1`}>Save these items as a list<input className={input} placeholder="Weekly groceries" value={name} maxLength={80} disabled={busy || disabled} onChange={e => setName(e.target.value)} /></label>
      <button className={btnSecondary} disabled={busy || disabled || dirty || !name.trim()} onClick={async () => { if (!current() || busy) return; setBusy(true); setError(null); try { await api.saveShoppingList({ name: name.trim(), items: listItems }); if (current()) { setNotice("Saved to shopping lists."); setName(""); } } catch (cause) { if (current()) setError(errMsg(cause)); } finally { if (current()) setBusy(false); } }}>Save as list</button>
    </div>
    {hasUnmatched && <p role="status" className="mt-2 text-sm">Items we couldn't find aren't saved.</p>}
    {dirty && <p role="status" className="mt-2 text-sm">Unsaved changes. Save the cart before approving or creating a checkout link.</p>}
    {notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
  </div>;
}
