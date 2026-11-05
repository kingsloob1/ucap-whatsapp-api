import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { checkMobile, countryOptions } from "../../src/shared/phone";
import { api } from "./api";
import { WhatsAppText, time } from "./format";
import { FlowSheet } from "./FlowSheet";
import type { CountryCode } from "../../src/shared/phone.interface";
import type {
  ConversationEntry,
  SimulateResponse,
} from "../../src/dev/dev.interface";

type Outbound = SimulateResponse["replies"][number];
type ListMessage = Extract<Outbound, { kind: "list" }>;
type FlowMessage = Extract<Outbound, { kind: "flow" }>;

interface Identity {
  waId: string;
  international: string;
  name: string;
}

const IDENTITY_KEY = "investnow:identity";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

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

type ServerEntry = ConversationEntry;

/** A message typed on this device that the server hasn't stored (or shown back) yet. */
interface Pending {
  localId: string;
  text: string;
  choiceId?: string;
  at: string;
  /** Set once the server accepted it onto the queue. */
  messageId?: string;
  failed?: string;
}

/** WhatsApp's states for an outgoing message. */
type Ticks = "sending" | "sent" | "delivered" | "read" | "failed";

type Row =
  | { key: string; kind: "day"; label: string }
  | {
      key: string;
      kind: "user";
      text: string;
      at: string;
      ticks: Ticks;
      readAt?: string;
      /** Answered in a form (a WhatsApp Flow), not typed in the chat. */
      form?: boolean;
    }
  | { key: string; kind: "bot"; message: Outbound; at: string };

const clearedKey = (waId: string) => `investnow:cleared:${waId}`;

/** "Today", "Yesterday", the weekday within the past week, otherwise the date, as WhatsApp labels days. */
function dayLabel(date: Date, now = new Date()): string {
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7)
    return date.toLocaleDateString([], { weekday: "long" });
  return date.toLocaleDateString([], {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function fullTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The rows to draw: the server's entries (oldest first), this device's pending
 * messages after them, with a day divider wherever the day changes. A user
 * message is "delivered" once the server stored it and "read" once a reply to
 * it was delivered, as on WhatsApp.
 */
function buildRows(
  entries: ServerEntry[],
  pending: Pending[],
  clearedUpTo: number,
): Row[] {
  const visible = entries.filter((e) => e.id > clearedUpTo);
  const replyAt = new Map<string, string>();
  for (const e of entries) {
    if (e.direction === "out" && e.messageId && !replyAt.has(e.messageId))
      replyAt.set(e.messageId, e.deliveredAt);
  }
  const stored = new Set(
    entries.filter((e) => e.direction === "in").map((e) => e.messageId),
  );

  const items: Exclude<Row, { kind: "day" }>[] = [];
  visible.forEach((e, i) => {
    if (e.direction === "in") {
      // Entries without an id (the direct /dev/simulate path) count as read
      // once anything follows them; a form's answers as soon as they're stored.
      const readAt = e.form
        ? e.at
        : e.messageId
          ? replyAt.get(e.messageId)
          : visible.slice(i + 1).find((x) => x.direction === "out")?.at;
      items.push({
        key: `in:${e.id}`,
        kind: "user",
        text: e.text,
        at: e.at,
        ticks: readAt ? "read" : "delivered",
        ...(readAt ? { readAt } : {}),
        ...(e.form ? { form: true } : {}),
      });
    } else {
      items.push({
        key: `out:${e.id}`,
        kind: "bot",
        message: e.message,
        at: e.deliveredAt,
      });
    }
  });
  for (const p of pending) {
    if (p.messageId && stored.has(p.messageId)) continue;
    items.push({
      key: `local:${p.localId}`,
      kind: "user",
      text: p.text,
      at: p.at,
      ticks: p.failed ? "failed" : p.messageId ? "sent" : "sending",
    });
  }

  const rows: Row[] = [];
  let lastDay = "";
  for (const item of items) {
    const label = dayLabel(new Date(item.at));
    if (label !== lastDay) {
      rows.push({ key: `day:${item.key}`, kind: "day", label });
      lastDay = label;
    }
    rows.push(item);
  }
  return rows;
}

function Chat({
  identity,
  onChangeNumber,
}: {
  identity: Identity;
  onChangeNumber: () => void;
}) {
  const [entries, setEntries] = useState<ServerEntry[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [step, setStep] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [offline, setOffline] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sheet, setSheet] = useState<ListMessage | null>(null);
  const [form, setForm] = useState<FlowMessage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [clearedUpTo, setClearedUpTo] = useState(() =>
    load<number>(clearedKey(identity.waId), 0),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastId = useRef(0);

  // The conversation lives on the server: load it, then keep a request waiting
  // for whatever comes next (this device's replies, or another device's messages).
  useEffect(() => {
    let stopped = false;
    lastId.current = 0;
    async function follow() {
      // The first read answers at once (the history); later ones wait up to 8 s for news.
      let first = true;
      while (!stopped) {
        try {
          const result = await api.get("/dev/conversations/:waId", {
            params: { waId: identity.waId },
            query: { after: lastId.current, wait: first ? 0 : 8 },
          });
          first = false;
          if (stopped) return;
          if (!result.ok) throw new Error(`HTTP ${result.status}`);
          const fresh = result.data.entries;
          if (fresh.length > 0) {
            lastId.current = fresh.at(-1)!.id;
            setEntries((list) => {
              const known = new Set(list.map((e) => e.id));
              return [...list, ...fresh.filter((e) => !known.has(e.id))];
            });
          }
          setStep(result.data.step);
          setLoaded(true);
          setOffline(null);
        } catch (error) {
          if (stopped) return;
          setOffline(error instanceof Error ? error.message : String(error));
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    }
    void follow();
    return () => {
      stopped = true;
    };
  }, [identity.waId]);

  const rows = useMemo(
    () => buildRows(entries, pending, clearedUpTo),
    [entries, pending, clearedUpTo],
  );
  const awaitingReply = rows.some(
    (r) =>
      r.kind === "user" &&
      (r.ticks === "sent" || r.ticks === "delivered") &&
      Date.now() - Date.parse(r.at) < 20_000,
  );

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [rows.length, awaitingReply]);

  // A pending message is done once the server shows it back.
  useEffect(() => {
    const stored = new Set(
      entries.filter((e) => e.direction === "in").map((e) => e.messageId),
    );
    setPending((list) => {
      const next = list.filter(
        (p) => !(p.messageId && stored.has(p.messageId)),
      );
      return next.length === list.length ? list : next;
    });
  }, [entries]);

  async function send(text: string, choiceId?: string) {
    if (text.trim() === "" && !choiceId) return;
    const localId = crypto.randomUUID();
    setPending((list) => [
      ...list,
      {
        localId,
        text,
        ...(choiceId ? { choiceId } : {}),
        at: new Date().toISOString(),
      },
    ]);
    try {
      const result = await api.post("/dev/messages", {
        body: {
          from: identity.waId,
          text,
          ...(identity.name ? { name: identity.name } : {}),
          ...(choiceId ? { choiceId } : {}),
        },
      });
      const update: Partial<Pending> = result.ok
        ? { messageId: result.data.messageId, at: result.data.at }
        : {
            failed: Array.isArray(result.error.message)
              ? result.error.message.join("; ")
              : result.error.message,
          };
      setPending((list) =>
        list.map((p) => (p.localId === localId ? { ...p, ...update } : p)),
      );
    } catch (error) {
      const failed = error instanceof Error ? error.message : String(error);
      setPending((list) =>
        list.map((p) => (p.localId === localId ? { ...p, failed } : p)),
      );
    } finally {
      input.current?.focus();
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft;
    setDraft("");
    void send(text);
  };

  function clearScreen() {
    setMenuOpen(false);
    const upTo = entries.at(-1)?.id ?? 0;
    localStorage.setItem(clearedKey(identity.waId), JSON.stringify(upTo));
    setClearedUpTo(upTo);
    setPending([]);
    setNotice(
      "Cleared on this device. The conversation is still stored; Reset number deletes it.",
    );
  }

  async function resetNumber() {
    setMenuOpen(false);
    try {
      const result = await api.delete("/dev/users/:waId", {
        params: { waId: identity.waId },
      });
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      localStorage.removeItem(clearedKey(identity.waId));
      setClearedUpTo(0);
      setEntries([]);
      setPending([]);
      setStep(null);
      lastId.current = 0;
      setNotice(
        result.data.deletedUser
          ? "Account, session and conversation deleted. This number can onboard again."
          : "Session and conversation deleted (this number had no account).",
      );
    } catch (error) {
      setNotice(
        `Couldn't reset this number (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  const status = offline
    ? "reconnecting…"
    : awaitingReply
      ? "typing…"
      : `${identity.international}${step ? ` · ${step}` : ""}`;

  return (
    <section className="chat">
      <header className="chat__header">
        <div className="avatar" aria-hidden>
          IN
        </div>
        <div className="chat__title">
          <strong>InvestNow</strong>
          <small>{status}</small>
        </div>
        <div className="chat__actions">
          <button
            type="button"
            className="link"
            onClick={clearScreen}
            title="Hide these messages on this device"
          >
            Clear
          </button>
          <button
            type="button"
            className="link"
            onClick={() => void resetNumber()}
            title="Delete this number's account, session and conversation"
          >
            Reset number
          </button>
          <button type="button" className="link" onClick={onChangeNumber}>
            Change number
          </button>
        </div>
        <div className="menu">
          <button
            type="button"
            className="menu__button"
            aria-label="More options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
              <circle cx="12" cy="5" r="2" fill="currentColor" />
              <circle cx="12" cy="12" r="2" fill="currentColor" />
              <circle cx="12" cy="19" r="2" fill="currentColor" />
            </svg>
          </button>
          {menuOpen && (
            <>
              <div
                className="menu__backdrop"
                onClick={() => setMenuOpen(false)}
              />
              <div className="menu__popover" role="menu">
                <button type="button" role="menuitem" onClick={clearScreen}>
                  Clear chat
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void resetNumber()}
                >
                  Reset number
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onChangeNumber();
                  }}
                >
                  Change number
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <div className="chat__messages" aria-live="polite">
        {notice && (
          <div className="system" onClick={() => setNotice(null)}>
            {notice}
          </div>
        )}
        {offline && (
          <div className="system">
            Can't reach the server ({offline}). Retrying…
          </div>
        )}
        {loaded && rows.length === 0 && (
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
        {!loaded && !offline && (
          <div className="empty muted">Loading the conversation…</div>
        )}
        {rows.map((row) =>
          row.kind === "day" ? (
            <div key={row.key} className="day">
              <span>{row.label}</span>
            </div>
          ) : (
            <Bubble
              key={row.key}
              row={row}
              expanded={expanded === row.key}
              onToggle={() =>
                setExpanded((k) => (k === row.key ? null : row.key))
              }
              onChoose={send}
              onOpenList={setSheet}
              onOpenForm={setForm}
            />
          ),
        )}
        {awaitingReply && (
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
          placeholder="Message"
          maxLength={4096}
          aria-label="Message"
          enterKeyHint="send"
          autoFocus
        />
        <button
          type="submit"
          className="composer__send"
          disabled={draft.trim() === ""}
          aria-label="Send"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              fill="currentColor"
              d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"
            />
          </svg>
        </button>
      </form>

      {form && (
        <FlowSheet
          key={form.token}
          flow={form.flow}
          token={form.token}
          cta={form.cta}
          onClose={() => setForm(null)}
        />
      )}
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

/** WhatsApp's message ticks: a clock while sending, ✓ sent, grey ✓✓ delivered, blue ✓✓ read. */
function TickIcon({ ticks }: { ticks: Ticks }) {
  if (ticks === "failed") {
    return (
      <span className="ticks ticks--failed" aria-label="Not sent">
        !
      </span>
    );
  }
  if (ticks === "sending") {
    return (
      <svg
        className="ticks"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-label="Sending"
      >
        <circle
          cx="8"
          cy="8"
          r="6.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M8 4.6V8l2.3 1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  const label =
    ticks === "sent" ? "Sent" : ticks === "delivered" ? "Delivered" : "Read";
  return (
    <svg
      className={`ticks ticks--${ticks}`}
      viewBox="0 0 18 11"
      width="17"
      height="11"
      aria-label={label}
    >
      {ticks === "sent" ? (
        <path
          d="M1.5 5.8 4.9 9.2 12 1.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <path
            d="M1 5.8 4.4 9.2 11.5 1.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M7.4 8.6 8 9.2 15.1 1.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

function Bubble({
  row,
  expanded,
  onToggle,
  onChoose,
  onOpenList,
  onOpenForm,
}: {
  row: Exclude<Row, { kind: "day" }>;
  expanded: boolean;
  onToggle: () => void;
  onChoose: (text: string, choiceId?: string) => void;
  onOpenList: (message: ListMessage) => void;
  onOpenForm: (message: FlowMessage) => void;
}) {
  const at = time(new Date(row.at));
  if (row.kind === "user") {
    return (
      <div className="user-message">
        <button
          type="button"
          className={`bubble bubble--user ${expanded ? "bubble--expanded" : ""}`}
          onClick={onToggle}
        >
          {row.form && <span className="bubble__form">📝 Form answer</span>}
          <WhatsAppText text={row.text} />
          <span className="bubble__meta">
            {at} <TickIcon ticks={row.ticks} />
          </span>
        </button>
        {expanded && (
          <div className="bubble__details">
            Sent {fullTime(row.at)}
            {row.readAt && <> · Read {fullTime(row.readAt)}</>}
            {row.ticks === "failed" && <> · Not sent</>}
          </div>
        )}
      </div>
    );
  }

  const { message } = row;
  return (
    <div className="bot-message">
      <button
        type="button"
        className={`bubble bubble--bot ${expanded ? "bubble--expanded" : ""}`}
        onClick={onToggle}
      >
        {message.kind !== "text" && message.header && (
          <div className="bubble__header">{message.header}</div>
        )}
        <WhatsAppText text={message.body} />
        {message.kind !== "text" && message.footer && (
          <div className="bubble__footer">{message.footer}</div>
        )}
        <span className="bubble__meta">{at}</span>
      </button>
      {expanded && (
        <div className="bubble__details">Received {fullTime(row.at)}</div>
      )}
      {message.kind === "buttons" && (
        <div className="replies">
          {message.buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              className="replies__button"
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
            onClick={() => onOpenList(message)}
          >
            ☰ {message.button}
          </button>
        </div>
      )}
      {message.kind === "flow" && (
        <div className="replies">
          <button
            type="button"
            className="replies__button"
            onClick={() => onOpenForm(message)}
          >
            📝 {message.cta}
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
