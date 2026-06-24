import { Fragment, useEffect, useState } from "react";

interface EmailManagerProps {
  onBack: () => void;
  onLogout: () => void;
}

interface EmailThread {
  threadId: string;
  messageId: string;
  from: string;
  fromName: string;
  subject: string;
  date: string;
  snippet: string;
}

interface Connection {
  connected: boolean;
  email?: string;
}

interface Suggestion {
  loading: boolean;
  text?: string;
  error?: string;
  copied?: boolean;
}

export function EmailManager({ onBack, onLogout }: EmailManagerProps) {
  const [conn, setConn] = useState<Connection | null>(null);
  const [threads, setThreads] = useState<EmailThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [read, setRead] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("email-read") || "{}");
    } catch {
      return {};
    }
  });

  function toggleRead(threadId: string) {
    setRead((prev) => {
      const next = { ...prev, [threadId]: !prev[threadId] };
      try {
        localStorage.setItem("email-read", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  async function loadThreads() {
    setThreadsLoading(true);
    setThreadsError(null);
    try {
      const res = await fetch("/api/email/threads");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setThreads(data.threads || []);
    } catch (err: any) {
      setThreadsError(err.message || "Failed to load");
    } finally {
      setThreadsLoading(false);
    }
  }

  useEffect(() => {
    fetch("/api/email/connection")
      .then((r) => r.json())
      .then((c: Connection) => {
        setConn(c);
        if (c.connected) loadThreads();
      })
      .catch(() => setConn({ connected: false }));
  }, []);

  async function suggest(threadId: string) {
    setExpanded((cur) => (cur === threadId ? null : threadId));
    if (suggestions[threadId]?.text || suggestions[threadId]?.loading) return;
    setSuggestions((s) => ({ ...s, [threadId]: { loading: true } }));
    try {
      const res = await fetch(`/api/email/threads/${encodeURIComponent(threadId)}/suggest`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSuggestions((s) => ({ ...s, [threadId]: { loading: false, text: data.suggestion } }));
    } catch (err: any) {
      setSuggestions((s) => ({ ...s, [threadId]: { loading: false, error: err.message || "Failed" } }));
    }
  }

  async function copy(threadId: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setSuggestions((s) => ({ ...s, [threadId]: { ...s[threadId], copied: true } }));
      setTimeout(() => {
        setSuggestions((s) => ({ ...s, [threadId]: { ...s[threadId], copied: false } }));
      }, 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  async function disconnect() {
    await fetch("/api/email/disconnect", { method: "POST" });
    setConn({ connected: false });
    setThreads([]);
  }

  return (
    <div style={styles.wrapper}>
      <header style={styles.topBar}>
        <div style={styles.topBarInner}>
          <button onClick={onBack} style={styles.backBtn}>
            ← Customer Support
          </button>
          <img src="/logo.png" alt="BootInk" style={styles.topBarLogo} />
          <span style={styles.topBarTitle}>Email Manager</span>
          <button onClick={onLogout} style={styles.logoutBtn}>
            Log out
          </button>
        </div>
      </header>

      <div style={styles.page}>
        {conn === null && <p style={styles.muted}>Loading…</p>}

        {conn && !conn.connected && (
          <div style={styles.placeholder}>
            <p style={styles.placeholderTitle}>Connect your support inbox</p>
            <p style={styles.placeholderSub}>
              Read-only access — the tool reads unread mail and suggests replies. It never sends.
            </p>
            <a href="/auth/google" style={styles.connectBtn}>
              Connect Gmail
            </a>
          </div>
        )}

        {conn?.connected && (
          <>
            <div style={styles.connRow}>
              <span style={styles.connText}>
                Connected: <strong>{conn.email}</strong>
              </span>
              <div style={styles.connActions}>
                <button onClick={loadThreads} style={styles.smallBtn} disabled={threadsLoading}>
                  {threadsLoading ? "Refreshing…" : "Refresh"}
                </button>
                <button onClick={disconnect} style={styles.smallBtn}>
                  Disconnect
                </button>
              </div>
            </div>

            <p style={styles.sub}>Unread inbox messages</p>

            {threadsError && <p style={styles.error}>{threadsError}</p>}
            {!threadsLoading && !threadsError && threads.length === 0 && (
              <p style={styles.muted}>No unread messages 🎉</p>
            )}

            <div style={styles.list}>
              {(() => {
                const ts = (d: string) => {
                  const t = Date.parse(d);
                  return isNaN(t) ? 0 : t;
                };
                const cutoff = Date.now() - 24 * 60 * 60 * 1000;
                const sorted = [...threads].sort((a, b) => ts(b.date) - ts(a.date));
                const firstOldIdx = sorted.findIndex((t) => ts(t.date) < cutoff);
                return sorted.map((t, idx) => {
                  const divider =
                    idx === firstOldIdx && firstOldIdx !== -1 ? (
                      <div key="divider" style={styles.divider}>
                        <span style={styles.dividerText}>Older than 24 hours</span>
                      </div>
                    ) : null;
                    const sug = suggestions[t.threadId];
                const open = expanded === t.threadId;
                const isRead = !!read[t.threadId];
                  return (
                    <Fragment key={t.threadId}>
                      {divider}
                      <div style={styles.card}>
                    <div style={styles.cardRow}>
                      <input
                        type="checkbox"
                        checked={isRead}
                        onChange={() => toggleRead(t.threadId)}
                        style={styles.readCheckbox}
                        title="Mark as read"
                      />
                      <button style={styles.cardHeader} onClick={() => suggest(t.threadId)}>
                        <div style={{ flex: 1, minWidth: 0, ...(isRead ? styles.dim : {}) }}>
                          <div style={styles.cardFrom}>{t.fromName}</div>
                          <div style={styles.cardSubject}>{t.subject}</div>
                          <div style={styles.cardSnippet}>{t.snippet}</div>
                        </div>
                        <span style={styles.chevron}>{open ? "▲" : "▼"}</span>
                      </button>
                    </div>

                    {open && (
                      <div style={styles.suggestBox}>
                        {sug?.loading && <p style={styles.muted}>Generating suggestion…</p>}
                        {sug?.error && <p style={styles.error}>{sug.error}</p>}
                        {sug?.text && (
                          <>
                            <div style={styles.suggestLabel}>Suggested reply</div>
                            <div style={styles.suggestText}>{sug.text}</div>
                            <button style={styles.copyBtn} onClick={() => copy(t.threadId, sug.text!)}>
                              {sug.copied ? "Copied ✓" : "Copy"}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                      </div>
                    </Fragment>
                  );
                });
              })()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    minHeight: "100vh",
    background: "#f5f5f5",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  topBar: {
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
    padding: "0 1rem",
    position: "sticky" as const,
    top: 0,
    zIndex: 100,
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  topBarInner: {
    maxWidth: "760px",
    margin: "0 auto",
    display: "flex",
    alignItems: "center",
    position: "relative" as const,
    height: "56px",
    gap: "0.75rem",
  },
  topBarLogo: { height: "32px", width: "auto" },
  topBarTitle: {
    position: "absolute" as const,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: "1.1rem",
    fontWeight: 600,
    color: "#222",
    whiteSpace: "nowrap" as const,
  },
  backBtn: {
    padding: "0.4rem 1rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "#666",
  },
  logoutBtn: {
    marginLeft: "auto",
    padding: "0.4rem 1rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "#666",
  },
  page: { maxWidth: "760px", margin: "0 auto", padding: "1.5rem 1rem" },
  muted: { fontSize: "0.85rem", color: "#888" },
  error: { fontSize: "0.85rem", color: "#d32f2f" },
  sub: { margin: "0.5rem 0 1rem", fontSize: "0.85rem", color: "#888" },
  placeholder: {
    background: "#fff",
    border: "1px dashed #ccc",
    borderRadius: "8px",
    padding: "3rem 1rem",
    textAlign: "center" as const,
  },
  placeholderTitle: { margin: 0, fontSize: "1.05rem", fontWeight: 600, color: "#333" },
  placeholderSub: { margin: "0.5rem 0 1.25rem", fontSize: "0.85rem", color: "#888" },
  connectBtn: {
    display: "inline-block",
    padding: "0.6rem 1.5rem",
    background: "#1a73e8",
    color: "#fff",
    borderRadius: "6px",
    fontSize: "0.9rem",
    fontWeight: 600,
    textDecoration: "none",
  },
  connRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "1rem",
    flexWrap: "wrap" as const,
  },
  connText: { fontSize: "0.9rem", color: "#444" },
  connActions: { display: "flex", gap: "0.5rem" },
  smallBtn: {
    padding: "0.35rem 0.9rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "#555",
  },
  list: { display: "grid", gap: "0.75rem" },
  divider: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "0.5rem 0",
    borderTop: "1px solid #ddd",
    position: "relative" as const,
  },
  dividerText: {
    position: "absolute" as const,
    top: "-0.6rem",
    background: "#f5f5f5",
    padding: "0 0.6rem",
    fontSize: "0.72rem",
    color: "#999",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  card: {
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    overflow: "hidden",
  },
  cardRow: { display: "flex", alignItems: "center" },
  readCheckbox: {
    width: "18px",
    height: "18px",
    margin: "0 0 0 1rem",
    cursor: "pointer",
    flexShrink: 0,
  },
  dim: { opacity: 0.45, textDecoration: "line-through" },
  cardHeader: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.85rem 1rem",
    background: "none",
    border: "none",
    cursor: "pointer",
    textAlign: "left" as const,
    fontFamily: "inherit",
  },
  cardFrom: { fontSize: "0.9rem", fontWeight: 700, color: "#222" },
  cardSubject: { fontSize: "0.85rem", color: "#444", marginTop: "0.1rem" },
  cardSnippet: {
    fontSize: "0.8rem",
    color: "#999",
    marginTop: "0.2rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  chevron: { fontSize: "0.7rem", color: "#999", flexShrink: 0 },
  suggestBox: { borderTop: "1px solid #f0f0f0", padding: "1rem", background: "#fafafa" },
  suggestLabel: {
    fontSize: "0.72rem",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    color: "#999",
    marginBottom: "0.4rem",
  },
  suggestText: {
    fontSize: "0.9rem",
    color: "#222",
    whiteSpace: "pre-wrap" as const,
    lineHeight: 1.5,
    background: "#fff",
    border: "1px solid #e8e8e8",
    borderRadius: "6px",
    padding: "0.75rem",
  },
  copyBtn: {
    marginTop: "0.75rem",
    padding: "0.45rem 1.1rem",
    background: "#333",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.82rem",
  },
};
