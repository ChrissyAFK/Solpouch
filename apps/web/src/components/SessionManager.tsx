"use client";
import { useCallback, useEffect, useState } from "react";
import { api, errMsg, type AuthSession } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useRequestScope } from "@/lib/useRequestScope";
import { useAuth } from "./AuthProvider";
import { ErrorBanner, btnSecondary } from "./ui";

export function SessionManager() {
  const { signOut, signOutAll, sessionKey } = useAuth();
  const [sessions, setSessions] = useState<AuthSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const begin = useRequestScope();
  const load = useCallback(async () => {
    const current = begin();
    setError(null);
    try { const result = await api.sessions(); if (current()) setSessions(result.sessions); }
    catch (cause) { if (current()) setError(errMsg(cause)); }
  }, [begin]);
  useEffect(() => { void load(); }, [load]);
  async function revoke(id: string) {
    setBusy(true); setError(null);
    try { await api.revokeSession(id); if (getToken() === sessionKey) await load(); }
    catch (cause) { setError(errMsg(cause)); }
    finally { setBusy(false); }
  }
  return <section className="sp-card space-y-4" aria-labelledby="sessions-title">
    <h2 id="sessions-title" className="text-lg font-semibold">Signed-in sessions</h2>
    <p className="text-sm text-[var(--muted)]">Ending a session also removes its assistant access. Dates identify sessions; device details are not collected.</p>
    <ErrorBanner message={error} />
    {error && <button className={btnSecondary} onClick={() => void load()}>Retry sessions</button>}
    {!sessions && !error && <p role="status">Loading sessions…</p>}
    <ul className="space-y-3">{sessions?.map(session => <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
      <div><strong>{session.current ? "This session" : "Other session"}</strong><p className="text-sm text-[var(--muted)]">Started {new Date(session.createdAt).toLocaleString()} · Expires {new Date(session.expiresAt).toLocaleString()}</p></div>
      <button className={btnSecondary} disabled={busy} onClick={() => void (session.current ? signOut() : revoke(session.id))}>{session.current ? "Sign out this session" : "End session"}</button>
    </li>)}</ul>
    <button className={btnSecondary} disabled={busy} onClick={() => void signOutAll()}>Sign out everywhere</button>
  </section>;
}
