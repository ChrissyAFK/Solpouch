"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { authFetch, BACKEND_URL } from "@/lib/api";
import styles from "./ChatWidget.module.css";

type Message = { role: "user" | "assistant"; content: string };
type Mode = "checking" | "gemini" | "demo" | "unavailable";
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
        if (data.mode !== "demo" && data.mode !== "gemini") throw new Error();
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

  function close() {
    setOpen(false);
    launcher.current?.focus();
  }
  function clear() {
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
    if (busy.current || (!retry && !text)) return;
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
          typeof data?.error === "string"
            ? data.error
            : "The assistant couldn't reply. Please retry.",
        );
      if (
        typeof data?.reply !== "string" ||
        (data.mode !== "demo" && data.mode !== "gemini")
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
                {mode === "checking"
                  ? "Checking connection…"
                  : mode === "demo"
                    ? "Demo helper"
                    : mode === "gemini"
                      ? "Powered by Gemini"
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
              <button type="submit" disabled={pending || !draft.trim()}>
                {pending ? "Sending…" : "Send"}
              </button>
            </div>
            <p className={styles.boundary}>
              Chat cannot move funds or place orders. Voice is not available yet.
              {mode === "demo" && " Limited preset replies; live AI is not connected."}
            </p>
          </form>
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
