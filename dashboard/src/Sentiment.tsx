import { useEffect, useState } from "react";

// Customer Sentiment: a running log of recurring customer problems, built up
// automatically as DMs and support emails come through (10-min sweep). Open
// issues on top with mention trends and example quotes; mark resolved with a
// note of what you did. Resolved issues reopen automatically if the same
// problem comes back.

interface Mention {
  at: string;
  source: "instagram" | "email";
  name: string;
  quote: string;
}

interface ResolutionRecord {
  resolvedAt: string;
  note: string;
}

interface Issue {
  id: string;
  location: string;
  problem: string;
  status: "open" | "resolved";
  mentionCount: number;
  mentions: Mention[];
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
  reopenedAt?: string;
  resolutionHistory: ResolutionRecord[];
}

interface ScanLogEntry {
  at: string;
  source: "instagram" | "email";
  name: string;
  snippet: string;
  loggedIssue: boolean;
}

// Urgency colour for open problems — orange, not the app's default blue.
const URGENT = "#ea580c";

function weekCount(mentions: Mention[]): number {
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  return mentions.filter((m) => (Date.parse(m.at) || 0) >= cutoff).length;
}

function fmtDate(iso?: string): string {
  return iso ? new Date(iso).toLocaleDateString() : "";
}

function fmtTime(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : "";
}

// The dropdown body: every logged complaint behind an issue, newest first.
function EvidenceList({ mentions }: { mentions: Mention[] }) {
  return (
    <div style={styles.mentionList}>
      {[...mentions].reverse().map((m, i) => (
        <div key={i} style={styles.mentionRow}>
          <span style={styles.mentionMeta}>
            {fmtDate(m.at)} · {m.source === "instagram" ? "IG" : "Email"} · {m.name}
          </span>
          <span>“{m.quote}”</span>
        </div>
      ))}
    </div>
  );
}

export function Sentiment() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [scanlog, setScanlog] = useState<ScanLogEntry[]>([]);
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null); // issue id with the note box open
  const [note, setNote] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/sentiment");
      const data = (await res.json()) as {
        issues: Issue[];
        scanlog: ScanLogEntry[];
        lastScanAt: string | null;
      };
      setIssues(data.issues || []);
      setScanlog(data.scanlog || []);
      setLastScanAt(data.lastScanAt);
    } catch {
      setError("Could not load the issue log.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const scanNow = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch("/api/sentiment/scan", { method: "POST" });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError("Scan failed — try again in a moment.");
    } finally {
      setScanning(false);
    }
  };

  const resolve = async (id: string) => {
    const clean = note.trim();
    if (!clean) return;
    await fetch("/api/sentiment/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, note: clean }),
    });
    setResolving(null);
    setNote("");
    await load();
  };

  const reopen = async (id: string) => {
    await fetch("/api/sentiment/reopen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await load();
  };

  const dismiss = async (id: string) => {
    if (!window.confirm("Delete this issue entirely? Use for mis-detections — this cannot be undone.")) return;
    await fetch("/api/sentiment/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await load();
  };

  const open = issues.filter((i) => i.status === "open");
  const resolved = issues.filter((i) => i.status === "resolved");

  return (
    <div style={styles.container}>
      <div style={styles.toolRow}>
        <span style={styles.lastScan}>
          {lastScanAt ? `Last scan ${fmtTime(lastScanAt)} · scans automatically every 10 minutes` : "No scans yet"}
        </span>
        <button style={styles.scanBtn} onClick={scanNow} disabled={scanning}>
          {scanning ? "Scanning…" : "Scan now"}
        </button>
      </div>
      {error && <p style={styles.error}>{error}</p>}
      {loading && <p style={styles.muted}>Loading issue log…</p>}

      {!loading && (
        <div style={styles.columns}>
          <div style={styles.main}>
            <h2 style={styles.sectionTitle}>
              Open issues {open.length > 0 && <span style={styles.count}>{open.length}</span>}
            </h2>
            {open.length === 0 && (
              <p style={styles.muted}>
                Nothing open. New complaints in DMs and emails will appear here as they're scanned.
              </p>
            )}
            {open.map((issue) => (
              <div key={issue.id} style={styles.issueCard}>
                <div style={styles.issueTop}>
                  <span style={styles.locationChip}>{issue.location}</span>
                  <span style={styles.trend}>
                    {weekCount(issue.mentions)} this week · {issue.mentionCount} total
                  </span>
                </div>
                <div style={styles.problem}>{issue.problem}</div>
                {issue.reopenedAt && (
                  <div style={styles.reopenedTag}>
                    Reopened {fmtDate(issue.reopenedAt)} — previously resolved:{" "}
                    “{issue.resolutionHistory[issue.resolutionHistory.length - 1]?.note}”
                  </div>
                )}
                {issue.mentions.length > 0 && (
                  <div style={styles.quote}>
                    “{issue.mentions[issue.mentions.length - 1].quote}” —{" "}
                    {issue.mentions[issue.mentions.length - 1].name}
                  </div>
                )}

                {expanded === issue.id && <EvidenceList mentions={issue.mentions} />}

                {resolving === issue.id ? (
                  <div style={styles.resolveBox}>
                    <input
                      style={styles.noteInput}
                      placeholder="What did you do to fix it? (e.g. switched UK orders to tracked shipping)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") resolve(issue.id);
                        if (e.key === "Escape") setResolving(null);
                      }}
                      autoFocus
                    />
                    <button style={styles.primaryBtn} onClick={() => resolve(issue.id)} disabled={!note.trim()}>
                      Save &amp; resolve
                    </button>
                    <button style={styles.ghostBtn} onClick={() => setResolving(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div style={styles.actions}>
                    <button
                      style={styles.primaryBtn}
                      onClick={() => {
                        setResolving(issue.id);
                        setNote("");
                      }}
                    >
                      Mark resolved
                    </button>
                    {issue.mentions.length > 0 && (
                      <button
                        style={styles.ghostBtn}
                        onClick={() => setExpanded(expanded === issue.id ? null : issue.id)}
                      >
                        Evidence ({issue.mentions.length}) {expanded === issue.id ? "▴" : "▾"}
                      </button>
                    )}
                    <button style={styles.dismissBtn} onClick={() => dismiss(issue.id)}>
                      Not an issue
                    </button>
                    <span style={styles.seen}>
                      first {fmtDate(issue.firstSeenAt)} · last {fmtDate(issue.lastSeenAt)}
                    </span>
                  </div>
                )}
              </div>
            ))}

            {resolved.length > 0 && (
              <>
                <h2 style={{ ...styles.sectionTitle, marginTop: "1.75rem" }}>
                  Resolved <span style={styles.count}>{resolved.length}</span>
                </h2>
                {resolved.map((issue) => (
                  <div key={issue.id} style={{ ...styles.issueCard, ...styles.resolvedCard }}>
                    <div style={styles.issueTop}>
                      <span style={styles.locationChip}>{issue.location}</span>
                      <span style={styles.trend}>{issue.mentionCount} mentions</span>
                    </div>
                    <div style={styles.problem}>{issue.problem}</div>
                    <div style={styles.resolutionNote}>
                      ✓ Resolved {fmtDate(issue.resolvedAt)}: {issue.resolutionNote}
                    </div>
                    {expanded === issue.id && <EvidenceList mentions={issue.mentions} />}
                    <div style={styles.actions}>
                      {issue.mentions.length > 0 && (
                        <button
                          style={styles.ghostBtn}
                          onClick={() => setExpanded(expanded === issue.id ? null : issue.id)}
                        >
                          Evidence ({issue.mentions.length}) {expanded === issue.id ? "▴" : "▾"}
                        </button>
                      )}
                      <button style={styles.ghostBtn} onClick={() => reopen(issue.id)}>
                        Reopen
                      </button>
                      <button style={styles.dismissBtn} onClick={() => dismiss(issue.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Recent scans feed — proof the sweep is running */}
          <aside style={styles.side}>
            <h2 style={styles.sectionTitle}>Recent scans</h2>
            {scanlog.length === 0 && <p style={styles.muted}>No messages scanned yet.</p>}
            <div style={styles.scanList}>
              {scanlog.slice(0, 30).map((s, i) => (
                <div key={i} style={styles.scanRow}>
                  <div style={styles.scanMeta}>
                    <span>{s.source === "instagram" ? "IG" : "Email"} · {s.name}</span>
                    <span style={s.loggedIssue ? styles.flagged : styles.okTag}>
                      {s.loggedIssue ? "issue logged" : "ok"}
                    </span>
                  </div>
                  <div style={styles.scanSnippet}>{s.snippet}</div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    background: "var(--bg)",
    color: "var(--text)",
    padding: "1.5rem",
    boxSizing: "border-box",
    maxWidth: "1100px",
    margin: "0 auto",
  },
  toolRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "1rem",
    flexWrap: "wrap",
    marginBottom: "1.25rem",
    paddingBottom: "1rem",
    borderBottom: "1px solid var(--border)",
  },
  lastScan: { fontSize: "0.8rem", color: "var(--text-muted)" },
  scanBtn: {
    padding: "0.5rem 1.1rem",
    background: URGENT,
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "0.85rem",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  muted: { color: "var(--text-muted)", fontSize: "0.9rem" },
  error: { fontSize: "0.85rem", color: "#dc2626", margin: "0 0 0.75rem" },
  columns: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.8fr) minmax(220px, 1fr)",
    gap: "1.5rem",
    alignItems: "start",
  },
  main: { minWidth: 0 },
  side: { minWidth: 0 },
  sectionTitle: { fontSize: "1.05rem", margin: "0 0 0.75rem" },
  count: {
    background: "var(--surface-3)",
    borderRadius: "999px",
    padding: "0.05rem 0.55rem",
    fontSize: "0.8rem",
    marginLeft: "0.3rem",
  },
  issueCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderLeft: `4px solid ${URGENT}`,
    borderRadius: "12px",
    boxShadow: "0 1px 3px var(--shadow)",
    padding: "0.9rem 1rem",
    marginBottom: "0.9rem",
  },
  resolvedCard: { borderLeft: "4px solid #16a34a", opacity: 0.85 },
  issueTop: { display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.5rem" },
  locationChip: {
    background: "var(--surface-3)",
    borderRadius: "999px",
    padding: "0.15rem 0.7rem",
    fontSize: "0.78rem",
    fontWeight: 700,
  },
  trend: { fontSize: "0.75rem", color: "var(--text-faint)", marginLeft: "auto" },
  problem: { fontSize: "0.95rem", lineHeight: 1.45, fontWeight: 600 },
  reopenedTag: {
    fontSize: "0.78rem",
    color: "#d97706",
    marginTop: "0.4rem",
  },
  quote: { fontSize: "0.82rem", color: "var(--text-muted)", marginTop: "0.5rem", fontStyle: "italic" },
  mentionList: {
    marginTop: "0.6rem",
    borderTop: "1px solid var(--border)",
    paddingTop: "0.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.45rem",
    maxHeight: "260px",
    overflowY: "auto",
  },
  mentionRow: { fontSize: "0.8rem", display: "flex", flexDirection: "column", gap: "0.1rem" },
  mentionMeta: { color: "var(--text-faint)", fontSize: "0.72rem" },
  actions: { display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.7rem", flexWrap: "wrap" },
  seen: { fontSize: "0.72rem", color: "var(--text-faint)", marginLeft: "auto" },
  primaryBtn: {
    padding: "0.35rem 0.9rem",
    background: URGENT,
    color: "#fff",
    border: "none",
    borderRadius: "7px",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  ghostBtn: {
    padding: "0.35rem 0.9rem",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "7px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "var(--text-muted)",
    fontFamily: "inherit",
  },
  dismissBtn: {
    padding: "0.35rem 0.9rem",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: "7px",
    cursor: "pointer",
    fontSize: "0.78rem",
    color: "var(--text-faint)",
    fontFamily: "inherit",
  },
  resolveBox: { display: "flex", gap: "0.5rem", marginTop: "0.7rem", flexWrap: "wrap" },
  noteInput: {
    flex: 1,
    minWidth: "260px",
    padding: "0.45rem 0.7rem",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "7px",
    fontSize: "0.85rem",
    color: "var(--text)",
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  resolutionNote: { fontSize: "0.82rem", color: "#16a34a", marginTop: "0.5rem" },
  scanList: { display: "flex", flexDirection: "column", gap: "0.5rem" },
  scanRow: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "9px",
    padding: "0.5rem 0.7rem",
  },
  scanMeta: {
    display: "flex",
    justifyContent: "space-between",
    gap: "0.5rem",
    fontSize: "0.72rem",
    color: "var(--text-faint)",
    marginBottom: "0.2rem",
  },
  flagged: { color: "#d97706", fontWeight: 700 },
  okTag: { color: "var(--text-faint)" },
  scanSnippet: {
    fontSize: "0.78rem",
    color: "var(--text-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};
