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
  dailyOrders: { orders: number; items: number; pulledAt: string } | null;
  sheetsUploaded: number | null;
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

  if (!data) return null;

  const needsAttention =
    (data.pendingQueue || 0) + (data.emailUnread || 0) + (data.igUnread || 0);

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>Daily digest</span>
        <span style={styles.date}>{data.date}</span>
      </div>

      <div style={styles.row}>
        <Item label="Awaiting approval" value={fmt(data.pendingQueue)} hot={(data.pendingQueue || 0) > 0} />
        <Item label="Unread emails" value={fmt(data.emailUnread)} hot={(data.emailUnread || 0) > 0} />
        <Item label="Unread DMs" value={fmt(data.igUnread)} hot={(data.igUnread || 0) > 0} />
        <Item label="Replied today" value={fmt(data.stats?.replied ?? null)} />
      </div>

      <div style={styles.orders}>
        {data.dailyOrders ? (
          <>
            <strong>{data.dailyOrders.orders}</strong> orders ({data.dailyOrders.items} items) pulled from
            Shopify — <a href="#/gangsheet" style={styles.link}>generate gangsheet</a>
            {data.sheetsUploaded ? ` · ${data.sheetsUploaded} sheet file(s) stored today` : ""}
          </>
        ) : (
          <>No Shopify pull stored for today yet (runs ~9am AEST)</>
        )}
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

const styles: Record<string, CSSProperties> = {
  card: {
    background: "var(--card-bg, #fff)",
    border: "1px solid var(--border, #e0e0e0)",
    borderRadius: 8,
    padding: "1rem",
    marginBottom: "1rem",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "0.75rem",
  },
  title: { fontWeight: 700, fontSize: "1rem" },
  date: { fontSize: "0.8rem", opacity: 0.6 },
  row: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
    gap: "0.5rem",
    marginBottom: "0.75rem",
  },
  item: { textAlign: "center" },
  itemValue: { fontSize: "1.4rem", fontWeight: 700 },
  itemLabel: { fontSize: "0.72rem", opacity: 0.65 },
  orders: { fontSize: "0.85rem", opacity: 0.9 },
  link: { color: "#2e7d32", fontWeight: 600 },
  allClear: { marginTop: "0.5rem", fontSize: "0.85rem", color: "#2e7d32" },
};
