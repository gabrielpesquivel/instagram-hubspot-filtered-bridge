import { useEffect, useState, type CSSProperties } from "react";

// Morning digest card: one glance at what needs attention today. Data comes
// from /api/digest; null sections mean that integration isn't connected (or
// failed) and render as "—" rather than alarming zeros.

interface DigestData {
  date: string;
  emailUnread: number | null;
  igUnread: number | null;
  sheetsUploaded: number | null;
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : String(n));

export function DigestCard() {
  const [data, setData] = useState<DigestData | null>(null);
  const [emailsTicked, setEmailsTicked] = useState(false);
  const [dmsTicked, setDmsTicked] = useState(false);

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

  // Mirror the "Answer emails" / "Answer Instagram DMs" ticks from TodoList
  // (same per-day localStorage key). "todo-changed" covers same-tab toggles,
  // "storage" other tabs.
  useEffect(() => {
    const read = () => {
      try {
        const raw = localStorage.getItem(`todo:${new Date().toISOString().slice(0, 10)}`);
        const done = raw ? JSON.parse(raw) : {};
        setEmailsTicked(!!done.emails);
        setDmsTicked(!!done.dms);
      } catch {
        setEmailsTicked(false);
        setDmsTicked(false);
      }
    };
    read();
    window.addEventListener("todo-changed", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("todo-changed", read);
      window.removeEventListener("storage", read);
    };
  }, []);

  // Render the card shell immediately with "—" placeholders — a card that pops
  // in after the fetch makes the whole page jump.
  const loading = data === null;

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>Daily digest</span>
        <span style={styles.date}>{data?.date
            ? new Date(`${data.date}T00:00:00`).toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
              })
            :" "}</span>
      </div>

      <div style={{ ...styles.row, opacity: loading ? 0.5 : 1 }}>
        {emailsTicked ? (
          <Item label="Unread emails" value="✓" color="#2e7d32" />
        ) : (
          <Item label="Unread emails" value={fmt(data?.emailUnread ?? null)} color={(data?.emailUnread || 0) > 0 ? "#ff9800" : undefined} />
        )}
        {dmsTicked ? (
          <Item label="Unread DMs" value="✓" color="#2e7d32" />
        ) : (
          <Item label="Unread DMs" value={fmt(data?.igUnread ?? null)} color={(data?.igUnread || 0) > 0 ? "#ff9800" : undefined} />
        )}
        <Item
          label="Gangsheet"
          value={data?.sheetsUploaded == null ? "—" : data.sheetsUploaded > 0 ? "✓" : "✗"}
          color={data?.sheetsUploaded == null ? undefined : data.sheetsUploaded > 0 ? "#2e7d32" : "#d32f2f"}
        />
      </div>
    </div>
  );
}

function Item({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={styles.item}>
      <div style={{ ...styles.itemValue, color: color || "inherit" }}>{value}</div>
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
    // No own margin: the home page grid row stretches this card so its bottom
    // lines up with the calendar's day boxes; callers add spacing outside.
    boxSizing: "border-box",
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
  },
  item: { textAlign: "center" },
  itemValue: { fontSize: "1.4rem", fontWeight: 700, color: "var(--text)" },
  itemLabel: { fontSize: "0.72rem", color: "var(--text-muted)" },
};
