"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getToken } from "@/lib/session";
import { useAuth } from "./AuthProvider";

const eventName = "solpouch:alert-preferences";
const preferenceKey = (email: string) => `solpouch.alerts.${encodeURIComponent(email)}`;
function enabledFor(email: string) { try { return localStorage.getItem(preferenceKey(email)) === "true"; } catch { return false; } }
export function AlertPreferences() {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { if (user) setEnabled(enabledFor(user.email)); }, [user]);
  return <section className="sp-card alert-pref" aria-labelledby="alert-pref-title">
    <div className="alert-pref-text">
      <h2 id="alert-pref-title">Spending alerts</h2>
      <p id="alert-pref-desc">Heads-up banners while Solpouch is open in this browser. No emails, push notifications, or payments.</p>
      <ul className="alert-pref-kinds" aria-label="Alerts you'll get">
        <li>Top-ups ready to finish</li>
        <li>80% of a daily limit used</li>
      </ul>
      {error && <p role="alert" className="alert-pref-error">This browser could not save the preference.</p>}
    </div>
    <label className="sp-switch">
      <span className="sr-only">Show spending alerts in this browser</span>
      <input type="checkbox" role="switch" aria-describedby="alert-pref-desc" checked={enabled} onChange={event => {
        if (!user) return;
        try { localStorage.setItem(preferenceKey(user.email), String(event.target.checked)); setEnabled(event.target.checked); setError(false); window.dispatchEvent(new Event(eventName)); }
        catch { setError(true); }
      }} />
      <span className="sp-switch-track" aria-hidden="true"><span /></span>
      <span className="sp-switch-label" aria-hidden="true">{enabled ? "On" : "Off"}</span>
    </label>
  </section>;
}
type Alert = { id: string; text: string; href: string };
export function AccountAlerts() {
  const { user, sessionKey } = useAuth();
  return user && sessionKey ? <Alerts key={sessionKey} email={user.email} token={sessionKey} /> : null;
}
function Alerts({ email, token }: { email: string; token: string }) {
  const [enabled, setEnabled] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const sync = () => { const on = enabledFor(email); setEnabled(on); if (!on) setAlerts([]); };
    sync(); window.addEventListener(eventName, sync); window.addEventListener("storage", sync);
    return () => { window.removeEventListener(eventName, sync); window.removeEventListener("storage", sync); };
  }, [email]);
  useEffect(() => {
    if (!enabled) return;
    let live = true; let busy = false;
    const seenKey = `${preferenceKey(email)}.seen`;
    let seen = new Set<string>();
    try { const values = JSON.parse(localStorage.getItem(seenKey) ?? "[]"); if (Array.isArray(values)) seen = new Set(values.filter(v => typeof v === "string")); } catch {}
    const current = () => live && getToken() === token;
    const tick = async () => {
      if (!current() || busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const [pouches, topups] = await Promise.all([api.pouches(), api.listPendingTopUps()]);
        if (!current()) return;
        const next: Alert[] = [];
        const day = new Date().toISOString().slice(0, 10);
        for (const pouch of pouches) {
          if (pouch.dailyLimit > 0 && pouch.spentToday >= pouch.dailyLimit * 0.8) next.push({ id: `budget:${pouch.id}:${day}`, text: `${pouch.name} has used at least 80% of today's limit.`, href: `/pouches/${encodeURIComponent(pouch.id)}` });
          for (const topup of topups) if (topup.pouchId === pouch.id && topup.status === "cooling_down" && Date.parse(topup.readyAt) <= Date.now()) next.push({ id: `topup:${topup.id}`, text: `A top-up for ${pouch.name} is ready to review.`, href: `/pouches/${encodeURIComponent(pouch.id)}#add-funds` });
        }
        const fresh = next.filter(alert => !seen.has(alert.id));
        fresh.forEach(alert => seen.add(alert.id));
        const activeIds = new Set(next.map(alert => alert.id));
        setAlerts(old => [...old.filter(alert => activeIds.has(alert.id)), ...fresh].slice(-5));
        if (fresh.length) { try { localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-200))); } catch {} }
        setFailed(false);
      } catch { if (current()) setFailed(true); }
      finally { busy = false; }
    };
    void tick(); const timer = setInterval(() => void tick(), 30000);
    const focus = () => void tick(); window.addEventListener("focus", focus);
    return () => { live = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [enabled, email, token]);
  if (!enabled || (!alerts.length && !failed)) return null;
  return <aside className="sp-card mb-5 space-y-2" aria-label="Spending alerts" aria-live="polite">
    {failed && <p className="text-sm">Alerts could not refresh. They will retry while this page is open.</p>}
    {alerts.map(alert => <div key={alert.id} className="flex items-center justify-between gap-3"><Link href={alert.href} className="text-sm underline">{alert.text}</Link><button type="button" aria-label={`Dismiss: ${alert.text}`} onClick={() => setAlerts(old => old.filter(a => a.id !== alert.id))}>Dismiss</button></div>)}
  </aside>;
}
