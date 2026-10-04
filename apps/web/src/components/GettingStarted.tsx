"use client";
import { useRef,useState } from "react";
import Link from "next/link";
import type { Merchant,Pouch } from "@solpouch/shared";
import { api,errMsg } from "@/lib/api";
import { useRequestScope } from "@/lib/useRequestScope";
import { PouchForm } from "./PouchForm";
import { ErrorBanner,btnPrimary,btnSecondary } from "./ui";

export function GettingStarted({pouches,merchants,onCreated}:{pouches:Pouch[];merchants:Merchant[];onCreated:()=>Promise<void>}) {
  const [creating,setCreating]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const beginRequest=useRequestScope();
  const submitting=useRef(false);
  return <section className="my-6 rounded border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-6" aria-label="Getting started">
    <h2 className="text-xl font-semibold">{pouches.length?"Build your first cart":"Set up your first pouch"}</h2>
    <p className="mt-2 text-sm text-[var(--muted)]">A pouch holds a balance and sets limits for each order and day. Creating one does not add money.</p>
    <ol className="my-5 grid gap-5 text-sm md:grid-cols-3">
      <li><strong>1. Set your limits{pouches.length?" · Done":""}</strong><p className="mt-1 text-[var(--muted)]">Choose a name, per-order limit and daily limit. You can restrict which stores it uses.</p></li>
      <li><strong>2. Make a shopping list</strong><p className="mt-1 text-[var(--muted)]">Save items you buy regularly, then build a fresh cart when you need them.</p></li>
      <li><strong>3. Review before approving</strong><p className="mt-1 text-[var(--muted)]">Check items, quantities and prices. Instacart purchases finish on Instacart; creating a link does not pay.</p></li>
    </ol>
    <ErrorBanner message={error}/>
    {!pouches.length ? creating ? <div className="border-t border-[var(--line)] pt-5"><PouchForm merchants={merchants} withName submitLabel="Create my first pouch" onSubmit={async values=>{
      if(submitting.current)return;
      const current=beginRequest(); submitting.current=true; setError(null);
      try {await api.createPouch(values);if(!current())return;setCreating(false);await onCreated();}
      catch(e){if(current())setError(errMsg(e));throw e;}
      finally{submitting.current=false;}
    }}/></div> : <button className={btnPrimary} onClick={()=>setCreating(true)}>Set up a pouch</button> : <div className="flex flex-wrap gap-3"><Link className={btnPrimary} href="/lists">Make a shopping list</Link><Link className={btnSecondary} href="/order">Build a cart</Link></div>}
  </section>;
}
