import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { toast } from "./toast";

// "Delays" tab of the Support Assistant: shipments the order globe flags as
// delayed (past the usual delivery window) or with a delivery issue, so the
// team can email the customer before they write in. Drafts come from the same
// AI as replies (/api/support/delays/draft) and go out as a new Gmail thread.

export interface DelayItem {
  order: string;
  status: "delayed" | "issue";
  country: string;
  city: string;
  carrier: string;
  shippedAt: string;
  eta: string | null;
  approx: boolean; // no carrier scans — flagged on age alone
  days: number;
  contacted: string | null;
}

interface Draft {
  to: string;
  name: string;
  subject: string;
  body: string;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

/** Not-yet-contacted delays, for the tab's count pill. */
export async function fetchDelayCount(): Promise<number> {
  try {
    const res = await fetch("/api/support/delays");
    if (!res.ok) return 0;
    const data = (await res.json()) as { items: DelayItem[] };
    return data.items.filter((i) => !i.contacted).length;
  } catch {
    return 0;
  }
}

export function Delays({ header, onCountChange }: { header: ReactNode; onCountChange: (n: number) => void }) {
  const [items, setItems] = useState<DelayItem[] | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<DelayItem | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const current = useRef<string | null>(null); // guards async results after switching

  async function load() {
    try {
      const res = await fetch("/api/support/delays");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { refreshedAt: string | null; items: DelayItem[] };
      setItems(data.items);
      setRefreshedAt(data.refreshedAt);
      onCountChange(data.items.filter((i) => !i.contacted).length);
    } catch {
      setItems([]);
      toast("Couldn't load delayed orders");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function select(item: DelayItem) {
    current.current = item.order;
    setSelected(item);
    setDraft(null);
    setSending(false);
    setDrafting(true);
    try {
      const res = await fetch("/api/support/delays/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: item.order }),
      });
      const data = await res.json().catch(() => ({}));
      if (current.current !== item.order) return;
      if (!res.ok) throw new Error(data.error || "Failed to draft email");
      setDraft(data as Draft);
    } catch (e) {
      if (current.current === item.order) toast(e instanceof Error ? e.message : "Failed to draft email");
    } finally {
      if (current.current === item.order) setDrafting(false);
    }
  }

  async function send() {
    if (!selected || !draft) return;
    const order = selected.order;
    setSending(true);
    try {
      const res = await fetch("/api/support/delays/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order, ...draft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to send");
      toast(`Sent to ${draft.to}`, "success");
      if (current.current === order) {
        setSelected(null);
        setDraft(null);
      }
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to send");
    } finally {
      setSending(false);
    }
  }

  async function dismiss(item: DelayItem) {
    const res = await fetch("/api/support/delays/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: item.order }),
    }).catch(() => null);
    if (!res?.ok) return toast("Couldn't dismiss");
    if (current.current === item.order) {
      current.current = null;
      setSelected(null);
      setDraft(null);
    }
    load();
  }

  return (
    <div style={s.root}>
      <aside style={s.sidebar}>
        {header}
        <div style={s.note}>
          Shipped orders running late or with a failed delivery. Email them before they ask.
          {refreshedAt && <> Updated {new Date(refreshedAt).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}.</>}
        </div>
        <div style={s.list}>
          {items === null ? (
            <div style={s.empty}>Loading…</div>
          ) : items.length === 0 ? (
            <div style={s.empty}>No delayed orders 🎉</div>
          ) : (
            items.map((i) => (
              <button
                key={i.order}
                onClick={() => select(i)}
                style={{
                  ...s.card,
                  ...(selected?.order === i.order ? s.cardActive : {}),
                  ...(i.contacted ? s.cardDone : {}),
                }}
              >
                <div style={s.cardTop}>
                  <span style={s.cardTitle}>{i.order}</span>
                  <span style={i.status === "issue" ? s.badgeIssue : s.badgeDelay}>
                    {i.status === "issue" ? "Delivery issue" : `${i.days} days`}
                  </span>
                </div>
                <div style={s.cardMeta}>
                  {[i.city, i.country].filter(Boolean).join(", ")} · {i.carrier || "Unknown carrier"}
                  {i.approx && " · no scans"}
                </div>
                <div style={s.cardMeta}>
                  Shipped {fmtDate(i.shippedAt)}
                  {i.contacted && <> · emailed {fmtDate(i.contacted)}</>}
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <main style={s.main}>
        {!selected ? (
          <div style={s.noSel}>
            <div style={s.noSelTitle}>Select a delayed order</div>
            <div style={s.noSelSub}>An email is drafted from its live tracking.</div>
          </div>
        ) : (
          <div style={s.pane}>
            <div style={s.paneHead}>
              <div>
                <div style={s.paneTitle}>{selected.order}{draft?.name ? ` · ${draft.name}` : ""}</div>
                <div style={s.cardMeta}>
                  {selected.status === "issue" ? "Carrier couldn't deliver" : `In transit ${selected.days} days`}
                  {selected.eta && ` · ETA was ${fmtDate(selected.eta)}`}
                  {selected.contacted && ` · already emailed ${fmtDate(selected.contacted)}`}
                </div>
              </div>
              <button style={s.ghostBtn} onClick={() => dismiss(selected)} title="Hide this order from the list">
                Dismiss
              </button>
            </div>

            {drafting ? (
              <div style={s.noSel}><div style={s.noSelSub}>Drafting from tracking…</div></div>
            ) : draft ? (
              <>
                <label style={s.label}>
                  To
                  <input style={s.input} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
                </label>
                <label style={s.label}>
                  Subject
                  <input style={s.input} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
                </label>
                <textarea
                  style={s.body}
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
                <div style={s.actions}>
                  <button style={s.ghostBtn} onClick={() => select(selected)} disabled={sending}>Redraft</button>
                  <button style={s.sendBtn} onClick={send} disabled={sending || !draft.body.trim()}>
                    {sending ? "Sending…" : "Send email"}
                  </button>
                </div>
              </>
            ) : (
              <div style={s.actions}>
                <button style={s.ghostBtn} onClick={() => select(selected)}>Try again</button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

const BORDER = "var(--border)";
const s: Record<string, CSSProperties> = {
  root: { display: "flex", height: "100%", background: "var(--surface)", minHeight: 0 },
  sidebar: { width: "340px", flexShrink: 0, borderRight: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", minHeight: 0 },
  note: { fontSize: "0.75rem", color: "var(--text-faint)", padding: "0 0.9rem 0.5rem" },
  list: { flex: 1, overflowY: "auto", padding: "0 0.5rem 1rem", minHeight: 0 },
  empty: { padding: "2rem 1rem", textAlign: "center", color: "var(--text-faint)", fontSize: "0.85rem" },
  card: {
    display: "block", width: "100%", textAlign: "left", background: "none", border: "none",
    borderRadius: "10px", padding: "0.6rem 0.7rem", cursor: "pointer", fontFamily: "inherit",
  },
  cardActive: { background: "var(--surface-3)" },
  cardDone: { opacity: 0.55 },
  cardTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" },
  cardTitle: { fontWeight: 700, fontSize: "0.85rem", color: "var(--text)" },
  cardMeta: { fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "2px" },
  badgeDelay: { fontSize: "0.68rem", fontWeight: 700, color: "#b45309", background: "rgba(245,158,11,0.15)", borderRadius: "999px", padding: "0.05rem 0.45rem" },
  badgeIssue: { fontSize: "0.68rem", fontWeight: 700, color: "#b91c1c", background: "rgba(239,68,68,0.15)", borderRadius: "999px", padding: "0.05rem 0.45rem" },
  main: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  noSel: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
  noSelTitle: { fontSize: "1rem", fontWeight: 600, color: "var(--text-muted)" },
  noSelSub: { fontSize: "0.85rem", color: "var(--text-faint)", marginTop: "0.3rem" },
  pane: { flex: 1, display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem 1.25rem", minHeight: 0, overflowY: "auto" },
  paneHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" },
  paneTitle: { fontSize: "1rem", fontWeight: 700, color: "var(--text)" },
  label: { display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)" },
  input: {
    padding: "0.5rem 0.7rem", border: `1px solid ${BORDER}`, borderRadius: "8px",
    background: "var(--surface)", color: "var(--text)", fontSize: "0.85rem", fontFamily: "inherit",
  },
  body: {
    flex: 1, minHeight: "260px", padding: "0.75rem", border: `1px solid ${BORDER}`, borderRadius: "8px",
    background: "var(--surface)", color: "var(--text)", fontSize: "0.88rem", lineHeight: 1.5,
    fontFamily: "inherit", resize: "vertical",
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: "0.5rem" },
  ghostBtn: {
    padding: "0.4rem 0.9rem", background: "var(--surface)", border: "1px solid var(--border-strong)",
    borderRadius: "8px", cursor: "pointer", fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)",
  },
  sendBtn: {
    padding: "0.45rem 1.3rem", background: "#2563eb", color: "#fff", border: "none",
    borderRadius: "8px", fontSize: "0.8rem", fontWeight: 700, cursor: "pointer",
  },
};
