import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { checkMobile, countryOptions } from "../../src/shared/phone";
import { api } from "./api";
import { WhatsAppText, time } from "./format";
import type { CountryCode } from "../../src/shared/phone.interface";
import type { SimulateResponse } from "../../src/dev/dev.interface";

type Outbound = SimulateResponse["replies"][number];
type ListMessage = Extract<Outbound, { kind: "list" }>;

interface Identity {
  waId: string;
  international: string;
  name: string;
}

type Entry =
  | { id: string; from: "user"; text: string; at: string }
  | { id: string; from: "bot"; message: Outbound; at: string }
  | { id: string; from: "system"; text: string; at: string };

const IDENTITY_KEY = "investnow:identity";
const historyKey = (waId: string) => `investnow:chat:${waId}`;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const newId = () => crypto.randomUUID();

export function App() {
  const [identity, setIdentity] = useState<Identity | null>(() =>
    load<Identity | null>(IDENTITY_KEY, null),
  );

  const signIn = (next: Identity) => {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(next));
    setIdentity(next);
  };
  const signOut = () => {
    localStorage.removeItem(IDENTITY_KEY);
    setIdentity(null);
  };

  return (
    <main className="app">
      {identity ? (
        <Chat
          key={identity.waId}
          identity={identity}
          onChangeNumber={signOut}
        />
      ) : (
        <PhoneGate onDone={signIn} />
      )}
    </main>
  );
}

/* ------------------------------------------------------------ phone gate */

function PhoneGate({ onDone }: { onDone: (identity: Identity) => void }) {
  const countries = useMemo(() => countryOptions(), []);
  const [country, setCountry] = useState<CountryCode>("NG");
  const [number, setNumber] = useState("");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);

  const check = checkMobile(number, country);
  const nameError =
    name.trim().length > 100 ? "Keep the name under 100 characters." : null;
  const showError = touched && !check.ok;
  const calling = countries.find((c) => c.code === country)?.callingCode;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!check.ok || nameError) return;
    onDone({
      waId: check.waId,
      international: check.international,
      name: name.trim(),
    });
  };

  return (
    <form className="gate" onSubmit={submit} noValidate>
      <div className="gate__logo" aria-hidden>
        IN
      </div>
      <h1>InvestNow on WhatsApp</h1>
      <p className="gate__lead">
        Enter the WhatsApp number to chat as. The bot treats it exactly like a
        real WhatsApp user.
      </p>

      <label className="field">
        <span>Country</span>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value as CountryCode)}
        >
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} (+{c.callingCode})
            </option>
          ))}
        </select>
      </label>

      <label
        className={`field ${showError ? "field--error" : ""} ${check.ok ? "field--ok" : ""}`}
      >
        <span>Mobile number</span>
        <div className="field__phone">
          <span className="field__prefix">+{calling}</span>
          <input
            inputMode="tel"
            autoComplete="tel-national"
            placeholder="803 123 4567"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={showError}
            aria-describedby="phone-hint"
            autoFocus
          />
        </div>
        <small id="phone-hint" className="field__hint">
          {check.ok
            ? `✓ ${check.international}`
            : showError
              ? check.error
              : "A mobile number; you can also paste it with its + code."}
        </small>
      </label>

      <label className={`field ${nameError ? "field--error" : ""}`}>
        <span>WhatsApp profile name (optional)</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ada Obi"
          maxLength={120}
        />
        {nameError && <small className="field__hint">{nameError}</small>}
      </label>

      <button
        type="submit"
        className="button button--primary"
        disabled={touched && (!check.ok || !!nameError)}
      >
        Start chatting
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ chat */

function Chat({
  identity,
  onChangeNumber,
}: {
  identity: Identity;
  onChangeNumber: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>(() =>
    load<Entry[]>(historyKey(identity.waId), []),
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<ListMessage | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(
      historyKey(identity.waId),
      JSON.stringify(entries.slice(-300)),
    );
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries, identity.waId]);

  const push = (...more: Entry[]) => setEntries((list) => [...list, ...more]);

  async function send(text: string, choiceId?: string) {
    if (busy || (text.trim() === "" && !choiceId)) return;
    setBusy(true);
    push({ id: newId(), from: "user", text, at: new Date().toISOString() });
    try {
      const result = await api.post("/dev/simulate", {
        body: {
          from: identity.waId,
          text,
          ...(identity.name ? { name: identity.name } : {}),
          ...(choiceId ? { choiceId } : {}),
        },
      });
      if (result.ok) {
        const at = new Date().toISOString();
        setStep(result.data.step);
        push(
          ...result.data.replies.map((message): Entry => ({
            id: newId(),
            from: "bot",
            message,
            at,
          })),
        );
      } else {
        const message = Array.isArray(result.error.message)
          ? result.error.message.join("; ")
          : result.error.message;
        push({
          id: newId(),
          from: "system",
          text: `The server refused the message: ${message}`,
          at: new Date().toISOString(),
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      push({
        id: newId(),
        from: "system",
        text: `Couldn't reach the server (${reason}).`,
        at: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft;
    setDraft("");
    void send(text);
  };

  async function resetNumber() {
    setBusy(true);
    try {
      const result = await api.delete("/dev/users/:waId", {
        params: { waId: identity.waId },
      });
      const note = result.ok
        ? result.data.deletedUser
          ? "Account and session deleted. This number can onboard again."
          : "Session cleared (this number had no account)."
        : "Couldn't reset this number.";
      setEntries([
        {
          id: newId(),
          from: "system",
          text: note,
          at: new Date().toISOString(),
        },
      ]);
      setStep(null);
    } catch (error) {
      push({
        id: newId(),
        from: "system",
        text: `Couldn't reach the server (${String(error)}).`,
        at: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="chat">
      <header className="chat__header">
        <div className="avatar" aria-hidden>
          IN
        </div>
        <div className="chat__title">
          <strong>InvestNow</strong>
          <small>
            {busy
              ? "typing…"
              : `chatting as ${identity.international}${step ? ` · ${step}` : ""}`}
          </small>
        </div>
        <div className="chat__actions">
          <button
            type="button"
            className="link"
            onClick={() => setEntries([])}
            disabled={busy}
            title="Clear this screen only"
          >
            Clear
          </button>
          <button
            type="button"
            className="link"
            onClick={resetNumber}
            disabled={busy}
            title="Delete this number's account and session"
          >
            Reset number
          </button>
          <button
            type="button"
            className="link"
            onClick={onChangeNumber}
            disabled={busy}
          >
            Change number
          </button>
        </div>
      </header>

      <div className="chat__messages" aria-live="polite">
        {entries.length === 0 && (
          <div className="empty">
            <p>Say hi to start the conversation.</p>
            <button
              type="button"
              className="chip"
              onClick={() => void send("Hi")}
            >
              👋 Hi
            </button>
          </div>
        )}
        {entries.map((entry) => (
          <Bubble
            key={entry.id}
            entry={entry}
            disabled={busy}
            onChoose={send}
            onOpenList={setSheet}
          />
        ))}
        {busy && (
          <div
            className="bubble bubble--bot bubble--typing"
            aria-label="InvestNow is typing"
          >
            <span />
            <span />
            <span />
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message"
          maxLength={4096}
          aria-label="Message"
          autoFocus
        />
        <button
          type="submit"
          className="composer__send"
          disabled={busy || draft.trim() === ""}
          aria-label="Send"
        >
          ➤
        </button>
      </form>

      {sheet && (
        <ListSheet
          message={sheet}
          onClose={() => setSheet(null)}
          onPick={(id, title) => {
            setSheet(null);
            void send(title, id);
          }}
        />
      )}
    </section>
  );
}

function Bubble({
  entry,
  disabled,
  onChoose,
  onOpenList,
}: {
  entry: Entry;
  disabled: boolean;
  onChoose: (text: string, choiceId?: string) => void;
  onOpenList: (message: ListMessage) => void;
}) {
  const at = time(new Date(entry.at));
  if (entry.from === "system")
    return <div className="system">{entry.text}</div>;
  if (entry.from === "user") {
    return (
      <div className="bubble bubble--user">
        <WhatsAppText text={entry.text} />
        <span className="bubble__meta">{at} ✓✓</span>
      </div>
    );
  }

  const { message } = entry;
  return (
    <div className="bot-message">
      <div className="bubble bubble--bot">
        {message.kind !== "text" && message.header && (
          <div className="bubble__header">{message.header}</div>
        )}
        <WhatsAppText text={message.body} />
        {message.kind !== "text" && message.footer && (
          <div className="bubble__footer">{message.footer}</div>
        )}
        <span className="bubble__meta">{at}</span>
      </div>
      {message.kind === "buttons" && (
        <div className="replies">
          {message.buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              className="replies__button"
              disabled={disabled}
              onClick={() => onChoose(b.title, b.id)}
            >
              {b.title}
            </button>
          ))}
        </div>
      )}
      {message.kind === "list" && (
        <div className="replies">
          <button
            type="button"
            className="replies__button"
            disabled={disabled}
            onClick={() => onOpenList(message)}
          >
            ☰ {message.button}
          </button>
        </div>
      )}
    </div>
  );
}

function ListSheet({
  message,
  onClose,
  onPick,
}: {
  message: ListMessage;
  onClose: () => void;
  onPick: (id: string, title: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={message.button}
      onClick={onClose}
    >
      <div className="sheet__panel" onClick={(e) => e.stopPropagation()}>
        <header className="sheet__header">
          <button
            type="button"
            className="link"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
          <strong>{message.button}</strong>
        </header>
        {message.sections.map((section) => (
          <div key={section.title} className="sheet__section">
            <h2>{section.title}</h2>
            {section.rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className="sheet__row"
                onClick={() => onPick(row.id, row.title)}
              >
                <span className="sheet__row-title">{row.title}</span>
                {row.description && (
                  <span className="sheet__row-description">
                    {row.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
