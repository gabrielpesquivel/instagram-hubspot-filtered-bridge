import { useEffect, useState, type CSSProperties } from "react";

// Website status card: is bootink.com live, how fast it responds, and the
// store's Shop (shop.app) review stats. Data from /api/site-status (60s
// KV cache; reviews synced daily by the local scraper). Reviews show "—"
// until the first sync; status shows "—" until the first fetch resolves.

interface SiteStatus {
  live: boolean;
  status: number;
  responseMs: number | null;
  checkedAt: string;
  reviews: { count: number; avgRating: number | null; updatedAt: string } | null;
}

export function SiteStatusCard() {
  const [data, setData] = useState<SiteStatus | null>(null);

  useEffect(() => {
    let closed = false;
    const load = () => {
      fetch("/api/site-status")
        .then(async (r) => {
          if (r.ok && !closed) setData(await r.json());
        })
        .catch(() => { /* keep last snapshot */ });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);

  const loading = data === null;
  const avg = data?.reviews?.avgRating == null ? null : Math.round(data.reviews.avgRating * 10) / 10;

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>Website</span>
        <span style={styles.date}>bootink.com</span>
      </div>
      <div style={{ ...styles.row, opacity: loading ? 0.5 : 1 }}>
        <Item
          label="Status"
          value={loading ? "—" : data.live ? "● Live" : "● Down"}
          color={loading ? undefined : data.live ? "#2e7d32" : "#d32f2f"}
        />
        <Item
          label="Response"
          value={data?.responseMs == null ? "—" : `${data.responseMs} ms`}
          color={data?.responseMs != null && data.responseMs > 2000 ? "#ff9800" : undefined}
        />
        <Item
          label={data?.reviews ? `${data.reviews.count.toLocaleString()} reviews` : "Shop reviews"}
          value={avg === null ? "—" : `★ ${avg}`}
          color={avg === null ? undefined : "#ffc60d"}
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

// Matches DigestCard: var(--surface) card with the shared border/shadow.
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
  },
  item: { textAlign: "center" },
  itemValue: { fontSize: "1.4rem", fontWeight: 700, color: "var(--text)" },
  itemLabel: { fontSize: "0.72rem", color: "var(--text-muted)" },
};
