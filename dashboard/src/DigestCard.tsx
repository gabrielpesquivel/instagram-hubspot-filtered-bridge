import { useEffect, useState, type CSSProperties } from "react";

// Morning digest card: one glance at what needs attention today. Data comes
// from /api/digest; null sections mean that integration isn't connected (or
// failed) and render as "—" rather than alarming zeros.

interface DigestData {
  date: string;
  stats: { forwarded: number; replied: number; pending: number; errors: number } | null;
  pendingQueue: number | null;
  emailUnread: number | null;
  igUnread: number | null;
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : String(n));

export function DigestCard() {
  const [data, setData] = useState<DigestData | null>(null);

  useEffect(() => {
    let closed = false;
    const load = () => {
      fetch("/api/digest")
        .then(async (r) => {
          if (r.ok && !closed) setData(await r.json());
        })
        .catch(() => { /* keep last snapshot */ });
    };
    load();
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);

  // Render the card shell immediately with "—" placeholders — a card that pops
  // in after the fetch makes the whole page jump.
  const loading = data === null;
  const needsAttention = data
    ? (data.pendingQueue || 0) + (data.emailUnread || 0) + (data.igUnread || 0)
    : null;

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>Daily digest</span>
        <span style={styles.date}>{data?.date || " "}</span>
      </div>

      <div style={{ ...styles.row, opacity: loading ? 0.5 : 1 }}>
        <Item label="Awaiting approval" value={fmt(data?.pendingQueue ?? null)} hot={(data?.pendingQueue || 0) > 0} />
        <Item label="Unread emails" value={fmt(data?.emailUnread ?? null)} hot={(data?.emailUnread || 0) > 0} />
        <Item label="Unread DMs" value={fmt(data?.igUnread ?? null)} hot={(data?.igUnread || 0) > 0} />
        <Item label="Replied today" value={fmt(data?.stats?.replied ?? null)} />
      </div>

      {needsAttention === 0 && (
        <div style={styles.allClear}>All clear — nothing waiting.</div>
      )}
    </div>
  );
}

function Item({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return (
    <div style={styles.item}>
      <div style={{ ...styles.itemValue, color: hot ? "#ff9800" : "inherit" }}>{value}</div>
      <div style={styles.itemLabel}>{label}</div>
    </div>
  );
}

// Matches the home page sections (TodoList/FileCalendar): h2 title + muted
// sub outside, content in a var(--surface) card with the shared border/shadow.
const styles: Record<string, CSSProperties> = {
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 2px 8px var(--shadow)",
    padding: "1rem",
    marginBottom: "1.5rem",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "0.75rem",
  },
  title: { margin: 0, fontSize: "1.25rem", color: "var(--text)", fontWeight: 700 },
  date: { fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600 },
  row: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
    gap: "0.5rem",
    marginBottom: "0.75rem",
  },
  item: { textAlign: "center" },
  itemValue: { fontSize: "1.4rem", fontWeight: 700, color: "var(--text)" },
  itemLabel: { fontSize: "0.72rem", color: "var(--text-muted)" },
  allClear: { marginTop: "0.5rem", fontSize: "0.85rem", color: "#2e7d32" },
};
