/**
 * A WhatsApp Flow in the simulator: renders the Flow JSON the server uploads
 * to Meta (the components InvestNow's Flows use) and sends each screen's
 * answers to `POST /dev/flows/exchange`, the Flow endpoint's logic without the
 * encryption. Like WhatsApp, the back arrow returns to the previous screen
 * with its answers kept, and what is typed here never becomes a chat message:
 * the server logs each answer, masked, in the conversation.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import type { FlowDefinitionResponse } from "../../src/dev/dev.interface";

type FlowName = "onboarding" | "pin" | "transaction";
type Component = Record<string, unknown> & { type: string };
type Screen = {
  id: string;
  title?: string;
  layout: { children: Component[] };
};
type Values = Record<string, string | string[]>;

interface Shown {
  id: string;
  data: Record<string, unknown>;
  values: Values;
  /** Fields edited since the server's last answer: their server error is hidden. */
  edited: Set<string>;
  /** Fields left empty although required, found when Continue was tapped. */
  missing: Set<string>;
}

const DATA = /^\$\{data\.(\w+)\}$/;
const FORM = /^\$\{form\.(\w+)\}$/;

function resolve(value: unknown, shown: Shown): unknown {
  if (typeof value !== "string") return value;
  const d = DATA.exec(value);
  if (d) return shown.data[d[1]!];
  const f = FORM.exec(value);
  if (f) return shown.values[f[1]!];
  return value;
}

const asText = (value: unknown) => (typeof value === "string" ? value : "");

function errorOf(message: string | string[]): string {
  return Array.isArray(message) ? message.join("; ") : message;
}

export function FlowSheet({
  flow,
  token,
  cta,
  onClose,
}: {
  flow: FlowName;
  token: string;
  cta: string;
  onClose: () => void;
}) {
  const [definition, setDefinition] = useState<FlowDefinitionResponse | null>(
    null,
  );
  const [stack, setStack] = useState<Shown[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let stopped = false;
    void (async () => {
      const [def, first] = await Promise.all([
        api.get("/dev/flows/:name", { params: { name: flow } }),
        api.post("/dev/flows/exchange", {
          body: { flow_token: token, action: "INIT" },
        }),
      ]);
      if (stopped) return;
      if (!def.ok) return setProblem(`Couldn't load the form (${def.status})`);
      setDefinition(def.data);
      if (!first.ok) {
        if (first.status === 410) setExpired(true);
        return setProblem(errorOf(first.error.message));
      }
      setStack([
        {
          id: first.data.screen ?? "",
          data: first.data.data,
          values: {},
          edited: new Set(),
          missing: new Set(),
        },
      ]);
    })().catch((error: unknown) => {
      if (!stopped) setProblem(String(error));
    });
    return () => {
      stopped = true;
    };
  }, [flow, token]);

  const shown = stack.at(-1);
  const screen = definition?.screens.find((s) => s.id === shown?.id) as
    Screen | undefined;

  const update = (patch: Partial<Shown>) =>
    setStack((list) => [...list.slice(0, -1), { ...list.at(-1)!, ...patch }]);

  const setValue = (name: string, value: string | string[]) => {
    if (!shown) return;
    const edited = new Set(shown.edited).add(name);
    const missing = new Set(shown.missing);
    missing.delete(name);
    update({ values: { ...shown.values, [name]: value }, edited, missing });
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!shown || !screen || busy) return;
    const children = screen.layout.children;
    // WhatsApp checks required fields and lengths before sending anything.
    const missing = new Set(
      children
        .filter((c) => typeof c.name === "string")
        .filter((c) => resolve(c.visible, shown) !== false)
        .filter((c) => {
          const value = shown.values[c.name as string];
          const empty = !value || value.length === 0;
          const tooShort =
            typeof value === "string" &&
            typeof c["min-chars"] === "number" &&
            value.length < c["min-chars"];
          return (c.required === true && empty) || (!empty && tooShort);
        })
        .map((c) => c.name as string),
    );
    if (missing.size > 0) return update({ missing });

    const footer = children.find((c) => c.type === "Footer");
    const action = footer?.["on-click-action"] as
      { payload?: Record<string, unknown> } | undefined;
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(action?.payload ?? {})) {
      const resolved = resolve(value, shown);
      if (resolved !== undefined) data[key] = resolved;
    }

    setBusy(true);
    setProblem(null);
    try {
      const result = await api.post("/dev/flows/exchange", {
        body: {
          flow_token: token,
          action: "data_exchange",
          screen: shown.id,
          data,
        },
      });
      if (!result.ok) {
        if (result.status === 410) setExpired(true);
        return setProblem(errorOf(result.error.message));
      }
      const next = result.data;
      if (next.screen === "SUCCESS") return onClose();
      if (next.screen === shown.id || !next.screen) {
        // The same screen again: the server refused an answer.
        update({ data: next.data, edited: new Set(), missing: new Set() });
        const snack = asText(next.data.error_message);
        if (snack) setProblem(snack);
      } else {
        // Answers already given on that screen are kept, as WhatsApp keeps them.
        const earlier = stack.find((s) => s.id === next.screen);
        setStack((list) => [
          ...list,
          {
            id: next.screen!,
            data: next.data,
            values: earlier?.values ?? {},
            edited: new Set(),
            missing: new Set(),
          },
        ]);
      }
    } catch (error) {
      setProblem(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="sheet flow"
      role="dialog"
      aria-modal="true"
      aria-label={cta}
    >
      <form className="sheet__panel flow__panel" onSubmit={submit}>
        <header className="sheet__header">
          {stack.length > 1 ? (
            <button
              type="button"
              className="link"
              aria-label="Back"
              onClick={() => {
                setProblem(null);
                setStack((list) => list.slice(0, -1));
              }}
            >
              ←
            </button>
          ) : (
            <button
              type="button"
              className="link"
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          )}
          <strong>{screen?.title ?? cta}</strong>
        </header>

        <div className="flow__body">
          {!screen && !problem && <p className="muted">Loading…</p>}
          {expired && (
            <p className="flow__expired">
              This form has expired. Close it and open the latest one in the
              chat.
            </p>
          )}
          {screen &&
            shown &&
            screen.layout.children.map((c, i) => (
              <Field
                key={`${shown.id}:${i}`}
                component={c}
                shown={shown}
                onChange={setValue}
              />
            ))}
        </div>

        {problem && !expired && (
          <div className="flow__snack" role="alert">
            {problem}
          </div>
        )}
        {screen && shown && !expired && (
          <footer className="flow__footer">
            <button type="submit" className="primary" disabled={busy}>
              {busy
                ? "…"
                : asText(
                    screen.layout.children.find((c) => c.type === "Footer")
                      ?.label,
                  )}
            </button>
            <small className="muted">Managed by InvestNow · simulated</small>
          </footer>
        )}
      </form>
    </div>
  );
}

function Field({
  component: c,
  shown,
  onChange,
}: {
  component: Component;
  shown: Shown;
  onChange: (name: string, value: string | string[]) => void;
}) {
  const text = asText(resolve(c.text, shown));
  switch (c.type) {
    case "TextHeading":
      return <h2 className="flow__heading">{text}</h2>;
    case "TextSubheading":
      return <h3 className="flow__subheading">{text}</h3>;
    case "TextBody":
      return <p className="flow__text">{text}</p>;
    case "TextCaption":
      return <p className="flow__caption">{text}</p>;
    case "Footer":
      return null;
  }

  if (resolve(c.visible, shown) === false) return null;
  const name = asText(c.name);
  const label = asText(resolve(c.label, shown));
  const helper = asText(resolve(c["helper-text"], shown));
  const serverError = shown.edited.has(name)
    ? ""
    : asText(resolve(c["error-message"], shown));
  const error = shown.missing.has(name)
    ? c.required === true && !shown.values[name]?.length
      ? "Required"
      : `Enter at least ${String(c["min-chars"] ?? "")} characters`
    : serverError;
  const options = (resolve(c["data-source"], shown) ?? []) as {
    id: string;
    title: string;
  }[];

  switch (c.type) {
    case "TextInput": {
      const kind = asText(c["input-type"]);
      return (
        <label className={`flow__field ${error ? "flow__field--error" : ""}`}>
          <span>{label}</span>
          <input
            name={name}
            type={kind === "password" ? "password" : "text"}
            inputMode={
              kind === "number" || kind === "password" || kind === "passcode"
                ? "numeric"
                : undefined
            }
            autoComplete="off"
            maxLength={typeof c["max-chars"] === "number" ? c["max-chars"] : 80}
            value={asText(shown.values[name])}
            onChange={(e) => onChange(name, e.target.value)}
          />
          {error ? <em>{error}</em> : helper && <small>{helper}</small>}
        </label>
      );
    }
    case "DatePicker":
      return (
        <label className={`flow__field ${error ? "flow__field--error" : ""}`}>
          <span>{label}</span>
          <input
            name={name}
            type="date"
            min={asText(resolve(c["min-date"], shown)) || undefined}
            max={asText(resolve(c["max-date"], shown)) || undefined}
            value={asText(shown.values[name])}
            onChange={(e) => onChange(name, e.target.value)}
          />
          {error ? <em>{error}</em> : helper && <small>{helper}</small>}
        </label>
      );
    case "CheckboxGroup": {
      const picked = (shown.values[name] as string[] | undefined) ?? [];
      return (
        <fieldset className="flow__choices">
          <legend>{label}</legend>
          {options.map((o) => (
            <label key={o.id}>
              <input
                type="checkbox"
                checked={picked.includes(o.id)}
                onChange={(e) =>
                  onChange(
                    name,
                    e.target.checked
                      ? [...picked, o.id]
                      : picked.filter((id) => id !== o.id),
                  )
                }
              />
              {o.title}
            </label>
          ))}
          {error && <em>{error}</em>}
        </fieldset>
      );
    }
    case "RadioButtonsGroup":
      return (
        <fieldset className="flow__choices">
          <legend>{label}</legend>
          {options.map((o) => (
            <label key={o.id}>
              <input
                type="radio"
                name={name}
                checked={shown.values[name] === o.id}
                onChange={() => onChange(name, o.id)}
              />
              {o.title}
            </label>
          ))}
          {error && <em>{error}</em>}
        </fieldset>
      );
    default:
      return null;
  }
}
