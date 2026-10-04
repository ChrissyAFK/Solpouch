"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { BACKEND_URL, api, authFetch, errMsg } from "@/lib/api";
import { getToken, clearSession } from "@/lib/session";
import { GoogleButton, useAuth } from "./AuthProvider";
import { ChatOrderCards } from "./ChatOrderCards";
import styles from "./ChatWidget.module.css";

type Message = { role: "user" | "assistant"; content: string };
type Mode = "agent" | "checking" | "claude" | "gemini" | "demo" | "unavailable";
function ChatIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9Z" />
      <path d="M8 8h8M8 12h5" />
    </svg>
  );
}
export function ChatWidget({ landing = false }: { landing?: boolean }) {
  const { sessionKey } = useAuth();
  return (
    <ConversationProvider key={sessionKey ?? "signed-out"}>
      <ChatPanel landing={landing} />
    </ConversationProvider>
  );
}

function ChatPanel({ landing }: { landing: boolean }) {
  const { user, sessionKey } = useAuth();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("checking");
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    if (user) void api.voiceStatus().then(data => { if (live) setVoiceEnabled(data.enabled); }).catch(() => {});
    return () => { live = false; };
  }, [user, sessionKey]);
  // "text" or "voice" session with the ElevenLabs agent, null when not connected.
  const [session, setSession] = useState<"text" | "voice" | null>(null);
  const queued = useRef<string | null>(null);
  const lastTyped = useRef<string | null>(null);
  // The conversation including the queued message, so Gemini can answer it if the agent never connects.
  const queuedNext = useRef<Message[] | null>(null);
  const connected = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryMessages, setRetryMessages] = useState<Message[] | null>(null);
  const [tab, setTab] = useState<"chat" | "carts">("chat");
  const [cartCount, setCartCount] = useState(0);
  const [cartAlert, setCartAlert] = useState(false);
  const seenFresh = useRef<string | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const voiceRequest = useRef<AbortController | null>(null);
  const voiceExpiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceSetup = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  const agentSequence = useRef(-1);
  const agentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const isCurrent = () => mounted.current && getToken() === sessionKey;
  const endAgent = useRef<() => Promise<void>>(async () => {});

  function settle() {
    if (agentTimer.current) clearTimeout(agentTimer.current);
    busy.current = false;
    setPending(false);
  }
  function fallBack() {
    // ElevenLabs is unreachable: use the backend's Gemini helper instead.
    queued.current = null;
    queuedNext.current = null;
    setSession(null);
    settle();
    setMode("checking");
  }
  function waitForReply() {
    if (agentTimer.current) clearTimeout(agentTimer.current);
    agentTimer.current = setTimeout(() => {
      if (!isCurrent()) return;
      stopVoice();
      setNotice("The agent reply timed out. Check your orders before repeating a payment request.");
    }, 45000);
  }
  const agent = useConversation({
    onConnect: () => {
      if (!isCurrent() || agentSequence.current !== sequence.current) {
        void endAgent.current().catch(() => {});
        return;
      }
      connected.current = true;
      const text = queued.current;
      queued.current = null;
      queuedNext.current = null;
      if (text) { agent.sendUserMessage(text); waitForReply(); }
    },
    onDisconnect: () => {
      if (!isCurrent() || agentSequence.current !== sequence.current) return;
      connected.current = false;
      setSession(null);
      settle();
    },
    onMessage: ({ message, role }) => {
      if (!isCurrent() || agentSequence.current !== sequence.current) return;
      // Typed messages are already on screen; only voice transcripts come back as user messages.
      if (role === "user" && message === lastTyped.current) { lastTyped.current = null; return; }
      setMessages((m) => [
        ...m,
        { role: role === "user" ? "user" : "assistant", content: message },
      ]);
      if (role === "agent") settle();
    },
    onError: () => {
      if (!isCurrent() || agentSequence.current !== sequence.current) return;
      if (connected.current) {
        // A live session hit a problem (timeout, tool error). End it; the next message reconnects.
        try {
          agent.endSession();
        } catch {}
        setSession(null);
        settle();
        return;
      }
      // The agent never connected: answer with the Gemini helper instead.
      const pendingNext = queuedNext.current;
      fallBack();
      if (pendingNext) void askGemini(pendingNext);
      else setError("The voice agent couldn't connect. Try Talk again in a moment.");
    },
  });

  // The keyed provider owns exactly one login session. Cleanup also covers a
  // connection that finishes after logout; callbacks verify the stored token.
  endAgent.current = async () => { await agent.endSession(); };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queued.current = null;
      queuedNext.current = null;
      void endAgent.current().catch(() => {});
      sequence.current++;
      request.current?.abort();
      voiceRequest.current?.abort();
      if (voiceExpiry.current) clearTimeout(voiceExpiry.current);
      if (agentTimer.current) clearTimeout(agentTimer.current);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (open) textarea.current?.focus();
    if (!open || mode !== "checking") return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      setMode("unavailable");
    }, 10000);
    void authFetch(`${BACKEND_URL}/chat/status`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (data.mode !== "demo" && data.mode !== "gemini" && data.mode !== "claude") throw new Error();
        if (!controller.signal.aborted) setMode(data.mode);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMode("unavailable");
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [open, mode]);
  useEffect(() => {
    if (open && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [messages, pending, error, open]);
  // Pages can open the widget straight into voice with a "solpouch:talk" event.
  const talk = useRef<() => void>(() => {});
  talk.current = () => {
    setOpen(true);
    if (session !== "voice") void toggleVoice();
  };
  useEffect(() => {
    const onTalk = () => talk.current();
    window.addEventListener("solpouch:talk", onTalk);
    return () => window.removeEventListener("solpouch:talk", onTalk);
  }, []);

  function stopVoice() {
    sequence.current++;
    voiceSetup.current = false;
    voiceRequest.current?.abort();
    if (voiceExpiry.current) clearTimeout(voiceExpiry.current);
    voiceRequest.current = null;
    queued.current = null;
    queuedNext.current = null;
    connected.current = false;
    settle();
    setNotice(null);
    setSession(null);
    void endAgent.current().catch(() => {});
  }
  function close() {
    // × ends everything: voice, setup, text agent and any pending request.
    // stopVoice bumps the sequence, so a late reply no longer updates state.
    const unanswered = pending && messages[messages.length - 1]?.role === "user";
    stopVoice();
    if (unanswered) {
      setError("The chat was closed before a reply arrived.");
      setRetryMessages(messages);
    }
    request.current?.abort();
    request.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
    launcher.current?.focus();
  }
  function clear() {
    if (session) void endAgent.current().catch(() => {});
    if (agentTimer.current) clearTimeout(agentTimer.current);
    queued.current = null;
    queuedNext.current = null;
    setSession(null);
    voiceRequest.current?.abort();
    if (voiceExpiry.current) clearTimeout(voiceExpiry.current);
    voiceSetup.current = false;
    sequence.current++;
    request.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    busy.current = false;
    setPending(false);
    setMessages([]);
    setError(null);
    setNotice(null);
    setRetryMessages(null);
    setDraft("");
    setTab("chat");
    textarea.current?.focus();
  }
  async function send(content?: string, retry?: Message[]) {
    const text = (content ?? draft).trim();
    if (!isCurrent() || !user || busy.current || voiceSetup.current || (!retry && !text)) return;
    const next = retry ?? [
      ...messages,
      { role: "user" as const, content: text.slice(0, 2000) },
    ];
    if (!retry) {
      setMessages(next);
      setDraft("");
    }
    setTab("chat");
    setError(null);
    setRetryMessages(null);
    setPending(true);
    busy.current = true;
    if ((mode === "agent" || voiceEnabled) && !retry) {
      lastTyped.current = text;
      if (session) {
        agent.sendUserMessage(text);
        waitForReply();
      } else {
        queued.current = text;
        queuedNext.current = next;
        setSession("text");
        const generation = sequence.current;
        void startAgent(true).catch((cause) => {
          if (!isCurrent() || generation !== sequence.current) return;
          queued.current = null;
          queuedNext.current = null;
          setSession(null);
          settle();
          setError("The agent could not connect. Try again or use the text helper.");
        });
      }
      return;
    }
    await askGemini(next);
  }
  // The voice token lets the agent's tools act for the signed-in user.
  async function startAgent(textOnly: boolean) {
    if (!isCurrent()) return;
    const generation = sequence.current;
    const controller = new AbortController();
    voiceRequest.current?.abort();
    if (voiceExpiry.current) clearTimeout(voiceExpiry.current);
    voiceRequest.current = controller;
    const setupTimeout = setTimeout(() => controller.abort(), 15000);
    let credentials;
    try { credentials = await api.voiceSession(controller.signal); }
    finally { clearTimeout(setupTimeout); }
    const { token, expiresAt, signedUrl } = credentials;
    if (!isCurrent() || generation !== sequence.current) return;
    const expiry = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Voice session expired. Reconnect to continue.");
    voiceExpiry.current = setTimeout(() => {
      if (!isCurrent() || generation !== sequence.current) return;
      stopVoice();
      setNotice("Voice session expired. Press Talk or send a new message to reconnect. No payment will be retried automatically.");
    }, Math.min(expiry - Date.now(), 15 * 60_000));
    agentSequence.current = generation;
    let connectTimeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([agent.startSession({
      signedUrl,
      connectionType: "websocket",
      dynamicVariables: { secret__solpouch_voice_token: `Bearer ${token}` },
      ...(textOnly ? { textOnly: true } : {}),
    }), new Promise<never>((_, reject) => {
      connectTimeout = setTimeout(() => reject(new Error("The agent connection timed out.")), 15000);
    })]);
    } catch {
      if (isCurrent() && generation === sequence.current) { stopVoice(); setError("The agent could not connect. Try again in a moment."); }
      throw new Error("The agent could not connect. Try again in a moment.");
    } finally { if (connectTimeout) clearTimeout(connectTimeout); }
    if (!isCurrent() || generation !== sequence.current) await agent.endSession();
  }
  async function askGemini(next: Message[]) {
    if (!isCurrent()) return;
    const token = sessionKey;
    setPending(true);
    busy.current = true;
    const id = ++sequence.current;
    const controller = new AbortController();
    request.current = controller;
    let timedOut = false;
    timer.current = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 45000);
    try {
      const response = await fetch(`${BACKEND_URL}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          messages: next
            .slice(-19)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })),
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!isCurrent() || sequence.current !== id) return;
      if (response.status === 401) clearSession();
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Sign in to keep chatting."
            : typeof data?.error === "string"
            ? data.error
            : "The assistant couldn't reply. Please retry.",
        );
      if (
        typeof data?.reply !== "string" ||
        (data.mode !== "demo" && data.mode !== "gemini" && data.mode !== "claude")
      )
        throw new Error(
          "The assistant returned an invalid reply. Please retry.",
        );
      if (!isCurrent() || sequence.current !== id) return;
      setMode(data.mode);
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch (cause) {
      if (!isCurrent() || sequence.current !== id) return;
      setError(
        timedOut
          ? "The reply timed out. Please retry."
          : cause instanceof TypeError
            ? "Can't reach the assistant. Check the connection and retry."
            : cause instanceof Error
              ? cause.message
              : "Couldn't send your message. Please retry.",
      );
      setRetryMessages(next);
    } finally {
      if (isCurrent() && sequence.current === id) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        request.current = null;
        busy.current = false;
        setPending(false);
        textarea.current?.focus();
      }
    }
  }
  async function toggleVoice() {
    if (!isCurrent() || !voiceEnabled) return;
    if (session === "voice") {
      stopVoice();
      return;
    }
    if (busy.current || voiceSetup.current || !user) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Voice needs a secure (https) page and a browser with microphone support.");
      return;
    }
    voiceSetup.current = true;
    const generation = sequence.current;
    const isSetupCurrent = () => isCurrent() && generation === sequence.current;
    try {
      const permission = await navigator.permissions
        ?.query({ name: "microphone" as PermissionName })
        .then((p) => p.state)
        .catch(() => "prompt");
      if (!isSetupCurrent()) return;
      if (permission === "denied") {
        setError(
          "Microphone is blocked for this site. Click the icon left of the address bar, set Microphone to Allow, then press Talk again.",
        );
        return;
      }
      if (permission !== "granted") setNotice("Allow microphone access in the browser prompt to start talking.");
      try {
        // Even a permission request resolved after closing must release its stream.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        if (!isSetupCurrent()) return;
        setError(
          "Solpouch needs your microphone to talk. Press Talk and choose Allow, or type your question instead.",
        );
        return;
      }
      if (!isSetupCurrent()) return;
      setNotice(null);
      if (session) await agent.endSession();
      if (!isSetupCurrent()) return;
      setMode("agent");
      setSession("voice");
      await startAgent(false);
    } catch (cause) {
      if (!isSetupCurrent()) return;
      setSession(null);
      setError(errMsg(cause));
    } finally {
      if (isSetupCurrent()) {
        voiceSetup.current = false;
        setNotice(null);
      }
    }
  }
  const lastUser = [...messages]
    .reverse()
    .find((m) => m.role === "user")?.content;
  const shoppingRequest =
    lastUser &&
    /\b(buy|order|purchase|shop|need|get me|add to cart)\b/i.test(lastUser)
      ? lastUser
      : null;
  const modeText =
    mode === "agent"
      ? session === "voice"
        ? agent.isSpeaking
          ? "Speaking…"
          : "Listening…"
        : "Voice and text agent"
      : mode === "checking"
        ? "Connecting…"
        : mode === "demo"
          ? "Assistant"
          : mode === "claude"
            ? "Powered by Claude"
            : mode === "gemini"
              ? "Powered by Gemini"
              : "Offline";
  const statusTone =
    mode === "checking" ? styles.dotWait : mode === "unavailable" ? styles.dotOff : styles.dotOn;
  const canClear = messages.length > 0 || !!draft || !!notice || !!error || session !== null;
  return (
    // The landing page has no chat of its own, but keeps one that is already running.
    <div className={styles.widget} hidden={landing && !open && session === null && messages.length === 0}>
      {open && (
        <section
          id="solpouch-chat-panel"
          className={styles.panel}
          role="dialog"
          aria-label="Ask Solpouch"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Like the launcher, Escape only hides the panel; × ends the chat.
              event.stopPropagation();
              setOpen(false);
              launcher.current?.focus();
            }
          }}
        >
          <header className={styles.header}>
            <span className={styles.mark} aria-hidden="true">
              <ChatIcon />
            </span>
            <div className={styles.title}>
              <h2>Ask Solpouch</h2>
              <span className={styles.mode}>
                <span className={`${styles.dot} ${statusTone}`} aria-hidden="true" />
                {modeText}
              </span>
            </div>
            <div className={styles.headerActions}>
              {user && (
                <button
                  type="button"
                  className={styles.newChat}
                  onClick={clear}
                  disabled={!canClear}
                  aria-label="Clear chat"
                  title="Start a new chat"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  <span>New chat</span>
                </button>
              )}
              <button
                type="button"
                className={styles.iconButton}
                onClick={close}
                aria-label="Close chat"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
          </header>
          {!user ? (
            <div className={styles.history}>
              <div className={styles.empty}>
                <h3>Sign in to chat</h3>
                <p>Sign in with Google so the assistant can see your pouches.</p>
                <GoogleButton />
              </div>
            </div>
          ) : (
          <>
          <div className={styles.tabs} role="tablist" aria-label="Chat views">
            <button
              type="button"
              role="tab"
              id="solpouch-tab-chat"
              aria-selected={tab === "chat"}
              aria-controls="solpouch-chat-log"
              onClick={() => setTab("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              id="solpouch-tab-carts"
              aria-selected={tab === "carts"}
              aria-controls="solpouch-chat-carts"
              onClick={() => { setTab("carts"); setCartAlert(false); }}
            >
              Carts
              {cartCount > 0 && <span className={styles.count}>{cartCount}</span>}
              {cartAlert && tab !== "carts" && <span className={styles.alert}><span className="sr-only">, new cart</span></span>}
            </button>
          </div>
          {session === "voice" && (
            <div className={styles.callBar} role="status">
              <span className={styles.wave} aria-hidden="true"><i /><i /><i /><i /></span>
              <span>{agent.isSpeaking ? "Solpouch is speaking" : "Listening, go ahead"}</span>
            </div>
          )}
          <div
            className={styles.history}
            id="solpouch-chat-log"
            ref={history}
            role="log"
            aria-label="Conversation"
            aria-live="polite"
            aria-relevant="additions text"
            hidden={tab !== "chat"}
          >
            {messages.length === 0 && !notice && !error && (
              <div className={styles.empty}>
                <span className={styles.emptyMark} aria-hidden="true"><ChatIcon /></span>
                <h3>How can I help?</h3>
                <p>
                  Ask about your pouches, spending limits, or placing an order.
                </p>
                <div className={styles.presets}>
                  {[
                    "What is my balance?",
                    "Explain my spending limits",
                    "How do I place an order?",
                  ].map((question) => (
                    <button
                      type="button"
                      key={question}
                      disabled={pending}
                      onClick={() => void send(question)}
                    >
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message, index) => (
              <div
                className={`${styles.message} ${message.role === "user" ? styles.user : styles.assistant}`}
                key={index}
              >
                <span className="sr-only">
                  {message.role === "user" ? "You:" : "Solpouch:"}
                </span>
                <p>{message.content}</p>
              </div>
            ))}
            {notice && (
              <p className={styles.notice} role="status">
                {notice}
              </p>
            )}
            {pending && (
              <div className={`${styles.message} ${styles.assistant} ${styles.typing}`} role="status">
                <span className="sr-only">Waiting for a reply…</span>
                <span aria-hidden="true"><i /><i /><i /></span>
              </div>
            )}
            {error && (
              <div className={styles.error} role="alert">
                <p>{error}</p>
                {retryMessages && (
                  <button
                    type="button"
                    onClick={() => void send(undefined, retryMessages)}
                  >
                    Retry message
                  </button>
                )}
              </div>
            )}
            {shoppingRequest && !pending && !error && (
              <Link
                className={styles.orderAction}
                href={`/order?request=${encodeURIComponent(shoppingRequest)}`}
                onClick={() => {
                  // Full-width on phones, so step aside to show the form; the chat keeps going.
                  if (window.matchMedia("(max-width: 540px)").matches) setOpen(false);
                }}
              >
                <span>
                  <strong>Open order form</strong>
                  <small>Review the cart before paying.</small>
                </span>
                <span aria-hidden="true">↗</span>
              </Link>
            )}
          </div>
          <div className={styles.cartsPane} id="solpouch-chat-carts" role="tabpanel" aria-labelledby="solpouch-tab-carts" hidden={tab !== "carts"}>
            <ChatOrderCards
              refreshKey={messages.length}
              live={session === "voice"}
              onUpdate={(count, fresh) => {
                setCartCount(count);
                if (fresh && fresh !== seenFresh.current) {
                  seenFresh.current = fresh;
                  setCartAlert(true);
                }
              }}
            />
          </div>
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label className="sr-only" htmlFor="solpouch-chat-message">
              Message Solpouch
            </label>
            <div className={styles.inputRow}>
              <textarea
                id="solpouch-chat-message"
                ref={textarea}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={2000}
                placeholder={session === "voice" ? "Or type a message…" : "Message Solpouch…"}
                rows={1}
                aria-describedby="solpouch-chat-help"
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              {voiceEnabled && (
                <button
                  type="button"
                  className={styles.voice}
                  onClick={() => void toggleVoice()}
                  aria-pressed={session === "voice"}
                  aria-label={session === "voice" ? "End call" : "Talk"}
                  title={session === "voice" ? "End call" : "Talk to Solpouch"}
                >
                  {session === "voice" ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="3" width="6" height="11" rx="3" />
                      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                    </svg>
                  )}
                </button>
              )}
              <button
                type="submit"
                className={styles.send}
                disabled={pending || !draft.trim()}
                aria-label="Send"
                title="Send (Enter)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
            <p className={styles.boundary} id="solpouch-chat-help">
              {mode === "agent"
                ? "Orders always wait for your yes."
                : "Payments always need your approval."}
            </p>
          </form>
          </>
          )}
        </section>
      )}
      <button
        type="button"
        ref={launcher}
        className={`${styles.launcher} ${open ? styles.launcherOpen : ""}`}
        onClick={() => {
          // The launcher only hides the panel; × ends the chat and any voice call.
          setOpen(!open);
        }}
        aria-expanded={open}
        aria-controls={open ? "solpouch-chat-panel" : undefined}
        aria-label={open ? "Close Ask Solpouch" : "Ask Solpouch"}
      >
        <ChatIcon />
        <span>Ask Solpouch</span>
      </button>
    </div>
  );
}
