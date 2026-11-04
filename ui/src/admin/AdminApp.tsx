import { type FormEvent, useCallback, useEffect, useState } from "react";
import { adminApi, problemText } from "./api";
import type {
  MeResponse,
  SessionDetail,
  SessionSummary,
  SessionsResponse,
} from "../../../src/admin/admin.interface";
import { LoginBodyDto } from "../../../src/admin/admin.dto";

type Me = MeResponse;

/** Where to go after signing in: only a path inside /admin, never another site. */
function nextPath(): string | null {
  const next = new URLSearchParams(window.location.search).get("next");
  return next &&
    /^\/admin(\/[\w\-./%?=&]*)?$/.test(next) &&
    !next.startsWith("//")
    ? next
    : null;
}

export function AdminApp() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    void adminApi
      .get("/admin/api/me")
      .then((r) => setMe(r.ok ? r.data : null))
      .catch(() => setMe(null));
  }, []);

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (!me) {
    return (
      <Login
        onSignedIn={(signedIn) => {
          const next = nextPath();
          if (next && next !== "/admin" && next !== "/admin/")
            window.location.assign(next);
          else setMe(signedIn);
        }}
      />
    );
  }
  return <Dashboard me={me} onSignedOut={() => setMe(null)} />;
}

/* ---------------------------------------------------------------- sign-in */

function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{
    identifier?: string;
    password?: string;
    form?: string;
  }>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = LoginBodyDto.safeParse({ identifier, password });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as "identifier" | "password";
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await adminApi.post("/admin/api/login", { body: parsed.data });
      if (r.ok) onSignedIn(r.data);
      else
        setErrors({
          form: problemText(r.error, `Sign-in failed (${r.status}).`),
        });
    } catch (error) {
      setErrors({
        form: `Couldn't reach the server (${error instanceof Error ? error.message : String(error)}).`,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card login" onSubmit={submit} noValidate>
        <div className="brand">
          <span className="logo">IN</span>
          <div>
            <h1>InvestNow admin</h1>
            <p className="muted">Sign in with your email or username.</p>
          </div>
        </div>
        <label className={`field ${errors.identifier ? "invalid" : ""}`}>
          <span>Email or username</span>
          <input
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            maxLength={254}
            autoFocus
            aria-invalid={!!errors.identifier}
          />
          {errors.identifier && <small>{errors.identifier}</small>}
        </label>
        <label className={`field ${errors.password ? "invalid" : ""}`}>
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={200}
            aria-invalid={!!errors.password}
          />
          {errors.password && <small>{errors.password}</small>}
        </label>
        {errors.form && (
          <p className="alert" role="alert">
            {errors.form}
          </p>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

/* -------------------------------------------------------------- dashboard */

type Filters = {
  source: "" | "whatsapp" | "simulator";
  status: "" | "active" | "ended" | "expired";
  search: string;
};

function Dashboard({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [filters, setFilters] = useState<Filters>({
    source: "",
    status: "",
    search: "",
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await adminApi.get("/admin/api/sessions", {
        query: {
          page,
          pageSize: 25,
          ...(filters.source ? { source: filters.source } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
        },
      });
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else if (r.status === 401) onSignedOut();
      else
        setError(problemText(r.error, `Couldn't load sessions (${r.status}).`));
    } catch (e) {
      setError(
        `Couldn't reach the server (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }, [filters, page, onSignedOut]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load]);

  async function signOut() {
    await adminApi.post("/admin/api/logout").catch(() => undefined);
    onSignedOut();
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const update = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">IN</span>
          <strong>InvestNow admin</strong>
        </div>
        <nav>
          <a className="nav-link active" href="/admin/">
            Sessions
          </a>
          <a className="nav-link" href="/admin/jobs/">
            Jobs dashboard ↗
          </a>
        </nav>
        <div className="who">
          <span className="muted">
            {me.admin.username} · {me.admin.email}
          </span>
          <button className="button ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        {data && (
          <section className="stats">
            <Stat label="Active now" value={data.stats.active} tone="green" />
            <Stat label="From WhatsApp" value={data.stats.whatsapp} />
            <Stat label="From the simulator" value={data.stats.simulator} />
            <Stat label="All conversations" value={data.stats.total} />
          </section>
        )}

        <section className="card">
          <div className="toolbar">
            <input
              className="search"
              type="search"
              placeholder="Search number or name"
              value={filters.search}
              onChange={(e) => update({ search: e.target.value })}
              maxLength={100}
            />
            <select
              value={filters.source}
              onChange={(e) =>
                update({ source: e.target.value as Filters["source"] })
              }
            >
              <option value="">All sources</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="simulator">Simulator</option>
            </select>
            <select
              value={filters.status}
              onChange={(e) =>
                update({ status: e.target.value as Filters["status"] })
              }
            >
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="ended">Ended</option>
            </select>
            <span className="muted refresh">Refreshes every 5 s</span>
          </div>

          {error && <p className="alert">{error}</p>}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Name</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Step</th>
                  <th>Onboarded</th>
                  <th className="num">Messages</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {data?.sessions.map((s) => (
                  <tr
                    key={s.waId}
                    onClick={() => setSelected(s.waId)}
                    className={selected === s.waId ? "selected" : ""}
                  >
                    <td className="mono">+{s.waId}</td>
                    <td>{s.profileName ?? <span className="muted">—</span>}</td>
                    <td>
                      <span className={`badge source-${s.source}`}>
                        {s.source}
                      </span>
                    </td>
                    <td>
                      <span className={`badge status-${s.status}`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="mono">
                      {s.step ?? <span className="muted">—</span>}
                    </td>
                    <td>{s.onboarded ? "Yes" : "No"}</td>
                    <td className="num">{s.messageCount}</td>
                    <td title={s.lastActivityAt}>{ago(s.lastActivityAt)}</td>
                  </tr>
                ))}
                {data && data.sessions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="empty">
                      No conversations match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <button
              className="button ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Previous
            </button>
            <span className="muted">
              Page {page} of {pages} · {data?.total ?? 0} conversations
            </span>
            <button
              className="button ghost"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </div>
        </section>
      </main>

      {selected && (
        <SessionDrawer
          waId={selected}
          onClose={() => setSelected(null)}
          onChanged={() => void load()}
          onSignedOut={onSignedOut}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "green";
}) {
  return (
    <div className={`card stat ${tone ?? ""}`}>
      <span className="muted">{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

/* ----------------------------------------------------------------- detail */

function SessionDrawer({
  waId,
  onClose,
  onChanged,
  onSignedOut,
}: {
  waId: string;
  onClose: () => void;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await adminApi.get("/admin/api/sessions/:waId", {
      params: { waId },
    });
    if (r.ok) setDetail(r.data);
    else if (r.status === 401) onSignedOut();
    else
      setError(
        problemText(r.error, `Couldn't load the session (${r.status}).`),
      );
  }, [waId, onSignedOut]);

  useEffect(() => {
    setDetail(null);
    setConfirming(false);
    setNotice(null);
    void load();
    const timer = setInterval(() => void load(), 5_000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [load, onClose]);

  async function reset() {
    const r = await adminApi.post("/admin/api/sessions/:waId/reset", {
      params: { waId },
    });
    setConfirming(false);
    if (r.ok) {
      setNotice(
        r.data.wasLive
          ? "Session reset: the next message starts from the welcome."
          : "There was no live session; it is marked ended.",
      );
      onChanged();
      void load();
    } else setError(problemText(r.error, `Reset failed (${r.status}).`));
  }

  const s = detail?.session;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label={`Session +${waId}`}
      >
        <header className="drawer-head">
          <div>
            <h2 className="mono">+{waId}</h2>
            {s && (
              <p className="muted">
                {s.profileName ?? "No profile name"} ·{" "}
                <span className={`badge source-${s.source}`}>{s.source}</span>{" "}
                <span className={`badge status-${s.status}`}>{s.status}</span>
              </p>
            )}
          </div>
          <button className="button ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {error && <p className="alert">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
        {!detail && !error && <p className="muted">Loading…</p>}

        {detail && s && (
          <>
            <section className="facts">
              <Fact label="Step" value={s.step ?? "—"} mono />
              <Fact label="Started" value={formatTime(s.startedAt)} />
              <Fact
                label="Last activity"
                value={formatTime(s.lastActivityAt)}
              />
              <Fact
                label="Expires"
                value={s.expiresAt ? formatTime(s.expiresAt) : "—"}
              />
              <Fact label="Messages" value={String(s.messageCount)} />
              <Fact
                label="Business number id"
                value={s.phoneNumberId ?? "— (simulator)"}
                mono
              />
              {s.endedAt && (
                <Fact
                  label="Ended"
                  value={`${formatTime(s.endedAt)} · ${s.endReason ?? ""}`}
                />
              )}
            </section>

            <div className="actions">
              {confirming ? (
                <>
                  <span>End this conversation now?</span>
                  <button
                    className="button danger"
                    onClick={() => void reset()}
                  >
                    Yes, reset
                  </button>
                  <button
                    className="button ghost"
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className="button danger-outline"
                  onClick={() => setConfirming(true)}
                  disabled={s.status !== "active"}
                >
                  Reset session
                </button>
              )}
            </div>

            <h3>Live state</h3>
            {detail.state ? (
              <pre className="json">
                {JSON.stringify(detail.state, null, 2)}
              </pre>
            ) : (
              <p className="muted">No live session.</p>
            )}

            <h3>Account</h3>
            {detail.user ? (
              <section className="facts">
                <Fact label="Name" value={detail.user.name ?? "—"} />
                <Fact label="BVN" value={detail.user.bvn} mono />
                <Fact label="Date of birth" value={detail.user.dateOfBirth} />
                <Fact
                  label="Wallet"
                  value={naira(detail.user.walletBalanceKobo)}
                />
                <Fact
                  label="Holdings"
                  value={
                    detail.user.holdings
                      .map((h) => `${h.productCode} ${naira(h.balanceKobo)}`)
                      .join(" · ") || "—"
                  }
                />
                <Fact
                  label="Onboarded"
                  value={formatTime(detail.user.createdAt)}
                />
              </section>
            ) : (
              <p className="muted">Not onboarded.</p>
            )}

            <h3>Messages</h3>
            <ol className="events">
              {detail.events.map((e) => (
                <li key={e.id} className={`event ${e.direction}`}>
                  <div className="event-meta">
                    <span>
                      {e.direction === "in" ? "User" : `Bot · ${e.kind}`}
                    </span>
                    <span className="mono">
                      {e.stepBefore ?? "∅"} → {e.stepAfter ?? "∅"}
                    </span>
                    <span>{formatTime(e.at)}</span>
                  </div>
                  <div className="event-text">
                    {e.text || <span className="muted">(empty)</span>}
                    {e.choiceId && (
                      <span className="choice mono"> [{e.choiceId}]</span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </aside>
    </div>
  );
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="fact">
      <span className="muted">{label}</span>
      <span className={mono ? "mono" : ""}>{value}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

const NAIRA = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
});
const naira = (kobo: number) => NAIRA.format(kobo / 100);
const formatTime = (iso: string) => new Date(iso).toLocaleString();

function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export type { SessionSummary };
