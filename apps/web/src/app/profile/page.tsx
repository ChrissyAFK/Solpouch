"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errMsg, type Profile } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import Link from "next/link";
import { ErrorBanner, Notice } from "@/components/ui";
import { useRequestScope } from "@/lib/useRequestScope";
import { getToken } from "@/lib/session";
import { SessionManager } from "@/components/SessionManager";
import { WalletLink } from "@/components/WalletLink";
import { AlertPreferences } from "@/components/AccountAlerts";
import { PreferencesCard } from "./PreferencesCard";
import styles from "./profile.module.css";

const MAX_RAW = 5 * 1024 * 1024;
const MAX_CHARS = 60000;
const SIZE = 256;

async function toAvatar(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That image couldn't be read."));
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Your browser can't process images.");
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
    for (let q = 0.85; q >= 0.2; q -= 0.1) {
      const out = canvas.toDataURL("image/jpeg", q);
      if (out.length <= MAX_CHARS) return out;
    }
    throw new Error("That image is too detailed to shrink. Try another one.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ProfilePage() {
  const { updateUser, signOut, sessionKey } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function adopt(p: Profile) {
    setProfile(p);
    setName(p.displayName);
    setAvatar(p.avatar);
  }

  const beginRequest = useRequestScope();
  const reload = useCallback(async () => {
    const current = beginRequest();
    setLoadError(null);
    try { const p = await api.getProfile(); if (current()) adopt(p); }
    catch (cause) { if (current()) setLoadError(errMsg(cause)); }
  }, [beginRequest]);
  useEffect(() => { void reload(); }, [reload]);

  if (loadError)
    return (
      <div className={styles.page}>
        <ErrorBanner message={loadError} />
        <button className="sp-button sp-button-secondary" onClick={() => void reload()}>Retry profile</button>
      </div>
    );
  if (!profile)
    return <div className={styles.page} aria-busy="true" />;

  const shownName = name ?? profile.googleName;
  const shownPicture = avatar ?? profile.googlePicture;
  const nameInvalid = name !== null && name.trim().length === 0;
  const changed =
    name !== profile.displayName || avatar !== profile.avatar;
  const initial = (shownName || profile.email).trim().charAt(0).toUpperCase();
  const member = new Date(profile.createdAt);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setSaved(false);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError("Choose a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > MAX_RAW) {
      setError("That image is over 5 MB. Choose a smaller one.");
      return;
    }
    setBusy(true);
    try {
      setAvatar(await toAvatar(file));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!profile || saving || nameInvalid || !sessionKey || getToken() !== sessionKey) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const body: { displayName?: string | null; avatar?: string | null } = {};
      if (name !== profile.displayName)
        body.displayName = name === null ? null : name.trim();
      if (avatar !== profile.avatar) body.avatar = avatar;
      const p = await api.updateProfile(body);
      if (getToken() !== sessionKey) return;
      adopt(p);
      updateUser({ name: p.name, picture: p.picture }, sessionKey);
      setSaved(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Profile</h1>
      <SessionManager />
      <AlertPreferences />
      <section className="sp-card" aria-labelledby="photo-title">
        <h2 id="photo-title" className={styles.heading}>
          Photo
        </h2>
        <div className={styles.photoRow}>
          <div className={styles.avatar} aria-hidden="true">
            {shownPicture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shownPicture} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span>{initial}</span>
            )}
          </div>
          <div className={styles.actions}>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className={styles.file}
              onChange={onFile}
              aria-label="Upload photo"
              tabIndex={-1}
            />
            <button
              type="button"
              className="sp-button sp-button-secondary"
              disabled={busy || saving}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? "Processing…" : "Upload photo"}
            </button>
            {avatar !== null && (
              <button
                type="button"
                className="sp-button sp-button-secondary"
                disabled={saving}
                onClick={() => {
                  setAvatar(null);
                  setSaved(false);
                }}
              >
                Use Google photo
              </button>
            )}
          </div>
        </div>
        <p className={styles.hint}>PNG, JPEG or WebP, up to 5 MB.</p>
      </section>

      <section className="sp-card" aria-labelledby="details-title">
        <h2 id="details-title" className={styles.heading}>
          Details
        </h2>
        <label className="sp-label" htmlFor="display-name">
          Display name
        </label>
        <input
          id="display-name"
          className="sp-input"
          type="text"
          maxLength={60}
          value={shownName}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
        {name !== null && (
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              setName(null);
              setSaved(false);
            }}
          >
            Reset to Google name
          </button>
        )}
        <label className="sp-label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="sp-input"
          type="email"
          value={profile.email}
          readOnly
        />
        <p className={styles.hint}>
          Member since{" "}
          {Number.isNaN(member.getTime())
            ? "—"
            : member.toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
        </p>
      </section>

      <PreferencesCard />

      <section className="sp-card" aria-labelledby="wallet-title">
        <h2 id="wallet-title" className={styles.heading}>
          Wallet
        </h2>
        <p className={styles.hint}>
          Your linked wallet is used to add money to your pouches. Linking it
          only proves it&apos;s yours; it doesn&apos;t move money.
        </p>
        <WalletLink />
        <Link href="/funding" className="underline">Add or withdraw wallet funds</Link>
      </section>

      <ErrorBanner message={error} />
      {saved && <Notice>Profile saved.</Notice>}
      <div className={styles.footer}>
        <button
          type="button"
          className="sp-button sp-button-primary"
          disabled={!changed || saving || busy || nameInvalid}
          onClick={save}
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          className="sp-button sp-button-secondary"
          onClick={signOut}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
