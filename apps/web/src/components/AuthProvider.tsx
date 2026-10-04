"use client";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { BACKEND_URL, api } from "@/lib/api";
import {
  clearSession,
  onSessionChange,
  readSession,
  writeSession,
  type SessionUser,
} from "@/lib/session";
import styles from "./Auth.module.css";

type GoogleId = {
  initialize: (o: {
    client_id: string;
    callback: (r: { credential: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }) => void;
  renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
  disableAutoSelect: () => void;
};
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

type AuthState = {
  user: SessionUser | null;
  sessionKey: string | null;
  /** True until the stored session has been checked. */
  loading: boolean;
  gisReady: boolean;
  error: string | null;
  signOut: () => Promise<void>;
  signOutAll: () => Promise<void>;
  updateUser: (u: Partial<SessionUser>, expectedToken: string) => void;
};
const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const c = useContext(AuthContext);
  if (!c) throw new Error("useAuth must be used inside AuthProvider");
  return c;
}

export function AuthProvider({
  nonce,
  children,
}: {
  nonce?: string;
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const authGeneration = useRef(0);
  const [loading, setLoading] = useState(true);
  const [gisReady, setGisReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);

  // Restore and verify the stored session.
  useEffect(() => {
    const sync = () => {
      authGeneration.current++;
      const current = readSession();
      setUser(current?.user ?? null);
      setSessionKey(current?.token ?? null);
      setLoading(false);
    };
    const off = onSessionChange(sync);
    const stored = readSession();
    if (!stored) {
      setLoading(false);
      return () => {
        authGeneration.current++;
        off();
      };
    }
    setUser(stored.user);
    setSessionKey(stored.token);
    const generation = authGeneration.current;
    const isCurrent = () =>
      generation === authGeneration.current &&
      readSession()?.token === stored.token;
    const controller = new AbortController();
    fetch(`${BACKEND_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${stored.token}` },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!isCurrent()) return;
        if (res.status === 401) {
          clearSession();
          return;
        }
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (isCurrent() && data?.user?.email)
          writeSession({ token: stored.token, user: data.user });
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      authGeneration.current++;
      controller.abort();
      off();
    };
  }, []);

  const handleCredential = useCallback(async (credential: string) => {
    const generation = ++authGeneration.current;
    setError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
        cache: "no-store",
      });
      const data = await res.json().catch(() => null);
      if (generation !== authGeneration.current) return;
      if (!res.ok || !data?.token || !data?.user)
        throw new Error("Google sign-in didn't work. Try again.");
      writeSession({ token: data.token, user: data.user });
    } catch (e) {
      if (generation !== authGeneration.current) return;
      setError(
        e instanceof TypeError
          ? "We couldn't connect to Solpouch. Check your connection and try again."
          : e instanceof Error
            ? e.message
            : "Google sign-in didn't work. Try again.",
      );
    }
  }, []);

  // Load Google Identity Services once.
  useEffect(() => {
    if (!CLIENT_ID) return;
    const init = () => {
      const id = window.google?.accounts.id;
      if (!id || initialized.current) return;
      initialized.current = true;
      id.initialize({
        client_id: CLIENT_ID,
        callback: (r) => void handleCredential(r.credential),
        cancel_on_tap_outside: true,
      });
      setGisReady(true);
    };
    if (window.google?.accounts.id) {
      init();
      return;
    }
    let script = document.getElementById("gsi-client") as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = "gsi-client";
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      if (nonce) script.nonce = nonce;
      document.head.appendChild(script);
    }
    script.addEventListener("load", init);
    return () => script?.removeEventListener("load", init);
  }, [nonce, handleCredential]);

  const loggingOut = useRef(new Set<string>());
  const endSession = useCallback(async (all: boolean) => {
    const token = readSession()?.token;
    if (!token || loggingOut.current.has(token)) return;
    loggingOut.current.add(token);
    authGeneration.current++;
    try { window.google?.accounts.id.disableAutoSelect(); } catch {}
    // Hide private pages and close the microphone immediately, even offline.
    clearSession();
    const signedOutGeneration = authGeneration.current;
    setError(null);
    try {
      await api.logout(token, all);
    } catch {
      if (!readSession() && signedOutGeneration === authGeneration.current) setError("Signed out on this browser, but we could not revoke the server session. Sign in again and retry ending your sessions.");
    } finally {
      loggingOut.current.delete(token);
    }
  }, []);
  const signOut = useCallback(() => endSession(false), [endSession]);
  const signOutAll = useCallback(() => endSession(true), [endSession]);

  const updateUser = useCallback((u: Partial<SessionUser>, expectedToken: string) => {
    const stored = readSession();
    if (!stored || stored.token !== expectedToken) return;
    const next = { ...stored.user, ...u };
    writeSession({ token: stored.token, user: next });
    setUser(next);
  }, []);

  const value = useMemo(
    () => ({ user, sessionKey, loading, gisReady, error, signOut, signOutAll, updateUser }),
    [user, sessionKey, loading, gisReady, error, signOut, signOutAll, updateUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function GoogleButton() {
  const { gisReady } = useAuth();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!gisReady || !host.current) return;
    host.current.replaceChildren();
    window.google?.accounts.id.renderButton(host.current, {
      type: "standard",
      theme: "filled_black",
      size: "large",
      text: "signin_with",
      shape: "pill",
      logo_alignment: "left",
    });
  }, [gisReady]);
  return <div ref={host} className={styles.googleButton} />;
}

export function SignInCard({ message }: { message?: string }) {
  const { error, gisReady } = useAuth();
  return (
    <div className={styles.wrap}>
      <section className={styles.card} aria-labelledby="signin-title">
        <span className={styles.mark} aria-hidden="true" />
        <h1 id="signin-title">Sign in to Solpouch</h1>
        <p>
          {message ??
            "Sign in with Google to see your pouches, orders and spending limits."}
        </p>
        {!CLIENT_ID ? (
          <p className={styles.error} role="alert">
            Sign-in isn&apos;t configured yet. Set NEXT_PUBLIC_GOOGLE_CLIENT_ID.
          </p>
        ) : (
          <>
            <GoogleButton />
            {!gisReady && (
              <p className={styles.hint} role="status">
                Loading Google sign-in…
              </p>
            )}
          </>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

/** Renders children only when signed in, so no data requests fire before sign-in. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, sessionKey } = useAuth();
  if (loading && !user) return <div className={styles.wrap} aria-busy="true" />;
  if (!user) return <SignInCard />;
  return <Fragment key={sessionKey}>{children}</Fragment>;
}

export function UserMenu() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <span className={styles.user}>
      <Link href="/profile" aria-label="Profile" className={styles.profileLink}>
        {user.picture && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className={styles.avatar}
            src={user.picture}
            alt=""
            referrerPolicy="no-referrer"
          />
        )}
        <span className={styles.name}>{user.name || user.email}</span>
      </Link>
      <button type="button" className={styles.signOut} onClick={signOut}>
        Sign out
      </button>
    </span>
  );
}
