"use client";
import Link from "next/link";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import { BACKEND_URL, api, authFetch } from "@/lib/api";
import { GoogleButton, useAuth } from "./AuthProvider";
import styles from "./ChatWidget.module.css";

type Message = { role: "user" | "assistant"; content: string };
type Mode = "checking" | "claude" | "gemini" | "demo" | "unavailable";
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
export function ChatWidget() {
  return <ConversationProvider><ChatPanel /></ConversationProvider>;
}
function ChatPanel() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<Mode>("checking");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryMessages, setRetryMessages] = useState<Message[] | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  const busy = useRef(false);

  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceMode, setVoiceMode] = useState<"text" | "voice" | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const voiceEpoch = useRef(0);
  const mounted = useRef(true);
  const active = useRef(false);
  const voiceBusy = useRef(false);
  const lastTyped = useRef<string | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connection = useRef<{ resolve(): void; reject(error: Error): void } | null>(null);
  const agent = useConversation({
    onConnect: () => {
      if (!mounted.current || !active.current) { endAgent(); return; }
      connection.current?.resolve();
      connection.current = null;
    },
    onMessage: ({ message, role }) => {
      if (!mounted.current || !active.current) return;
      if (role === "user" && message === lastTyped.current) { lastTyped.current = null; return; }
      setMessages(m => [...m, { role: role === "user" ? "user" : "assistant", content: message }]);
      if (role === "agent") { if (agentTimer.current) clearTimeout(agentTimer.current); busy.current = false; setPending(false); }
    },
    onDisconnect: () => {
      if (!active.current && !connection.current) return;
      connection.current?.reject(new Error("The agent disconnected"));
      connection.current = null;
      if (expiry.current) clearTimeout(expiry.current);
      expiry.current = null;
      if (agentTimer.current) clearTimeout(agentTimer.current);
      active.current = false;
      if (mounted.current) { setVoiceMode(null); busy.current = false; setPending(false); }
    },
    onError: () => {
      if (!active.current && !connection.current) return;
      connection.current?.reject(new Error("The agent could not connect"));
      connection.current = null;
      if (expiry.current) clearTimeout(expiry.current);
      expiry.current = null;
      if (agentTimer.current) clearTimeout(agentTimer.current);
      active.current = false;
      endAgent();
      if (mounted.current) {
        setVoiceMode(null); busy.current = false; setPending(false);
        setNotice("The agent disconnected. You can retry or use the text helper.");
      }
    },
  });
  const agentRef = useRef(agent);
  agentRef.current = agent;
  function endAgent() { try { agentRef.current.endSession(); } catch { /* Already ended. */ } }
  function stopAgent() {
    connection.current?.reject(new Error("Connection cancelled"));
    connection.current = null;
    voiceEpoch.current++;
    active.current = false;
    if (expiry.current) clearTimeout(expiry.current);
    if (agentTimer.current) clearTimeout(agentTimer.current);
    endAgent();
    if (mounted.current) { setVoiceMode(null); setConnecting(false); busy.current = false; setPending(false); }
  }
  async function startAgent(kind: "text" | "voice") {
    if (voiceBusy.current) throw new Error("The agent is already connecting. Try again shortly.");
    voiceBusy.current = true;
    const revision = ++voiceEpoch.current;
    setConnecting(true);
    try {
      if (kind === "voice") {
        try {
          // Opens the browser's permission prompt; the agent opens its own stream once allowed.
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
        } catch {
          throw new Error("Solpouch needs your microphone to talk. Press Talk and choose Allow, or type your question instead.");
        }
      }
      if (!mounted.current || revision !== voiceEpoch.current) throw new Error("Connection cancelled");
      const data = await api.voiceSession();
      if (!mounted.current || revision !== voiceEpoch.current) throw new Error("Connection cancelled");
      const remaining = new Date(data.expiresAt).getTime() - Date.now();
      // The backend token lives 30 minutes; allow a little slack.
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 35 * 60000 || typeof data.token !== "string" || typeof data.signedUrl !== "string") throw new Error("Invalid voice session");
      active.current = true;
      // The SDK fixes dynamic variables at session start, so the voice token cannot be refreshed
      // mid-session. Its 30 minute backend lifetime is the session limit; we end cleanly at expiry.
      expiry.current = setTimeout(() => {
        stopAgent();
        if (mounted.current) setNotice("Your agent session ended. Start again to continue.");
      }, remaining);
      agentTimer.current = setTimeout(() => {
        stopAgent();
        if (mounted.current) setNotice("The agent connection timed out. Try again or use the text helper.");
      }, 15000);
      await new Promise<void>((resolve, reject) => {
        connection.current = { resolve, reject };
        agentRef.current.startSession({
        signedUrl: data.signedUrl,
        connectionType: "websocket",
        textOnly: kind === "text",
        dynamicVariables: { secret__solpouch_voice_token: `Bearer ${data.token}` },
        });
      });
      if (!mounted.current || revision !== voiceEpoch.current || !active.current) {
        endAgent();
        throw new Error("Connection cancelled");
      }
      if (agentTimer.current) clearTimeout(agentTimer.current);
      setVoiceMode(kind);
    } catch (cause) {
      active.current = false;
      if (expiry.current) clearTimeout(expiry.current);
      expiry.current = null;
      if (agentTimer.current) clearTimeout(agentTimer.current);
      connection.current = null;
      endAgent();
      throw cause;
    } finally {
      voiceBusy.current = false;
      if (mounted.current) setConnecting(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopAgent(); };
  }, []);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.voiceStatus()
      .then((data) => { if (live) setVoiceEnabled(data.enabled === true); })
      .catch(() => { if (live) setVoiceEnabled(false); });
    return () => { live = false; };
  }, [open]);

  useEffect(
    () => () => {
      sequence.current++;
      request.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
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
  const talkEvent = useRef<() => void>(() => {});
  talkEvent.current = () => {
    setOpen(true);
    if (!active.current && !connecting) void toggleVoice();
  };
  useEffect(() => {
    const onTalk = () => talkEvent.current();
    window.addEventListener("solpouch:talk", onTalk);
    return () => window.removeEventListener("solpouch:talk", onTalk);
  }, []);

  function close() {
    sequence.current++;
    request.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    stopAgent();
    setOpen(false);
    launcher.current?.focus();
  }
  function clear() {
    stopAgent();
    sequence.current++;
    request.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    busy.current = false;
    setPending(false);
    setMessages([]);
    setError(null);
    setRetryMessages(null);
    setDraft("");
    textarea.current?.focus();
  }
  async function send(content?: string, retry?: Message[]) {
    const text = (content ?? draft).trim();
    if (!user || busy.current || connecting || (!retry && !text)) return;
    const next = retry ?? [
      ...messages,
      { role: "user" as const, content: text.slice(0, 2000) },
    ];
    if (!retry) {
      setMessages(next);
      setDraft("");
    }
    setError(null);
    setRetryMessages(null);
    setPending(true);
    busy.current = true;
    const sendRevision = sequence.current;
    if (voiceEnabled && !retry) {
      try {
        if (!active.current) await startAgent("text");
        if (!mounted.current || !active.current) return;
        lastTyped.current = text;
        agentRef.current.sendUserMessage(text);
        agentTimer.current = setTimeout(() => {
          stopAgent();
          if (mounted.current) setNotice("The agent reply timed out. Check your orders before repeating a payment request.");
        }, 45000);
        return;
      } catch {
        if (!mounted.current || sendRevision !== sequence.current) return;
        setNotice("The agent could not connect. Using the read-only text helper.");
      }
    }
    await askGemini(next);
  }
  async function askGemini(next: Message[]) {
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
      const response = await authFetch(`${BACKEND_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next
            .slice(-19)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) })),
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
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
      if (sequence.current !== id) return;
      setMode(data.mode);
      setMessages([...next, { role: "assistant", content: data.reply }]);
    } catch (cause) {
      if (sequence.current !== id) return;
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
      if (sequence.current === id) {
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
    if (active.current || connecting) {
      sequence.current++;
      stopAgent();
      return;
    }
    setError(null);
    setNotice(null);
    if (!user) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice("Voice needs a secure (https) page and a browser with microphone support.");
      return;
    }
    const permission = await navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((p) => p.state)
      .catch(() => "prompt");
    if (permission === "denied") {
      setNotice(
        "Microphone is blocked for this site. Click the icon left of the address bar, set Microphone to Allow, then press Talk again.",
      );
      return;
    }
    if (permission !== "granted") setNotice("Allow microphone access in the browser prompt to start talking.");
    try {
      await startAgent("voice");
      if (mounted.current) setNotice(null);
    } catch (cause) {
      if (mounted.current) setNotice(cause instanceof Error ? cause.message : "Voice could not connect. Use the text helper.");
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
  return (
    <div className={styles.widget}>
      {open && (
        <section
          id="solpouch-chat-panel"
          className={styles.panel}
          role="dialog"
          aria-label="Ask Solpouch"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <header className={styles.header}>
            <div>
              <h2>Ask Solpouch</h2>
              <span className={styles.mode}>
                {voiceMode ? (voiceMode === "voice" ? (agent.isSpeaking ? "Speaking…" : "Listening…") : "Voice and text agent") : mode === "checking"
                  ? "Checking connection…"
                  : mode === "demo"
                    ? "Assistant"
                    : mode === "gemini" || mode === "claude"
                      ? mode === "claude" ? "Powered by Claude" : "Powered by Gemini"
                      : "Connection unavailable"}
              </span>
            </div>
            <div className={styles.headerActions}>
              <button
                type="button"
                onClick={clear}
                disabled={messages.length === 0 && !draft}
                aria-label="Clear chat"
              >
                Clear
              </button>
              <button
                type="button"
                className={styles.close}
                onClick={close}
                aria-label="Close chat"
              >
                ×
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
          <div
            className={styles.history}
            ref={history}
            role="log"
            aria-label="Conversation"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {messages.length === 0 && (
              <div className={styles.empty}>
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
                <span className={styles.speaker}>
                  {message.role === "user" ? "You" : "Solpouch"}
                </span>
                <p>{message.content}</p>
              </div>
            ))}
            {notice && (
              <p className={styles.pending} role="status">
                {notice}
              </p>
            )}
            {pending && (
              <p className={styles.pending} role="status">
                Waiting for a reply…
              </p>
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
          </div>
          {shoppingRequest && !pending && !error && (
            <div className={styles.orderAction}>
              <Link
                href={`/order?request=${encodeURIComponent(shoppingRequest)}`}
                onClick={close}
              >
                Open order form <span aria-hidden="true">↗</span>
              </Link>
              <span>Review the cart before paying.</span>
            </div>
          )}
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
            <textarea
              id="solpouch-chat-message"
              ref={textarea}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={2000}
              placeholder="Ask about your pouches…"
              rows={2}
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
            <div className={styles.composerBottom}>
              <span id="solpouch-chat-help">Shift + Enter for a new line</span>
              <button
                type="button"
                className={styles.voice}
                onClick={() => void toggleVoice()}
                disabled={!voiceEnabled || (!connecting && !active.current && pending)}
                title={voiceEnabled ? undefined : "Voice is off right now"}
                aria-pressed={!!voiceMode}
              >
                {connecting ? "Cancel" : voiceMode ? "End call" : "Talk"}
              </button>
              <button type="submit" disabled={pending || connecting || !draft.trim()}>
                {pending ? "Sending…" : "Send"}
              </button>
            </div>
            <p className={styles.boundary}>
              {voiceMode
                ? "Orders always wait for your yes. The assistant can't top up pouches."
                : "Chat cannot move funds or place orders."}
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
          if (open) close();
          else setOpen(true);
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
