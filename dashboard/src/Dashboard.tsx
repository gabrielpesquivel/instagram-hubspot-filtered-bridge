import { useEffect, useState } from "react";

interface Stats {
  forwarded: { total: number; today: number };
  skipped_verified: { total: number; today: number };
  skipped_high_followers: { total: number; today: number };
  skipped_media: { total: number; today: number };
  replied: { total: number; today: number };
  errors: { total: number; today: number };
}

interface Health {
  pipeline_active: boolean;
  has_hubspot_token: boolean;
  has_channel_id: boolean;
}

export function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");

  async function fetchData() {
    try {
      const [statsRes, healthRes] = await Promise.all([
        fetch("/api/stats"),
        fetch("/api/health"),
      ]);

      if (statsRes.status === 401 || healthRes.status === 401) {
        onLogout();
        return;
      }

      setStats(await statsRes.json());
      setHealth(await healthRes.json());
      setError("");
    } catch {
      setError("Failed to fetch data");
    }
  }

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Bridge Dashboard</h1>
        <button onClick={onLogout} style={styles.logoutBtn}>
          Log out
        </button>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      {health && (
        <div style={styles.statusBar}>
          <span
            style={{
              ...styles.statusDot,
              background: health.pipeline_active ? "#4caf50" : "#f44336",
            }}
          />
          <span>
            Pipeline {health.pipeline_active ? "Active" : "Inactive"}
          </span>
          {!health.has_hubspot_token && (
            <span style={styles.statusDetail}>Missing HubSpot token</span>
          )}
          {!health.has_channel_id && (
            <span style={styles.statusDetail}>Missing channel ID</span>
          )}
        </div>
      )}

      {stats && (
        <div style={styles.grid}>
          <StatCard
            label="Forwarded"
            total={stats.forwarded.total}
            today={stats.forwarded.today}
            color="#2196f3"
          />
          <StatCard
            label="Skipped (Verified)"
            total={stats.skipped_verified.total}
            today={stats.skipped_verified.today}
            color="#9c27b0"
          />
          <StatCard
            label="Skipped (Followers)"
            total={stats.skipped_high_followers.total}
            today={stats.skipped_high_followers.today}
            color="#ff9800"
          />
          <StatCard
            label="Skipped (Media)"
            total={stats.skipped_media.total}
            today={stats.skipped_media.today}
            color="#607d8b"
          />
          <StatCard
            label="Replied"
            total={stats.replied.total}
            today={stats.replied.today}
            color="#4caf50"
          />
          <StatCard
            label="Errors"
            total={stats.errors.total}
            today={stats.errors.today}
            color="#f44336"
          />
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  total,
  today,
  color,
}: {
  label: string;
  total: number;
  today: number;
  color: string;
}) {
  return (
    <div style={{ ...styles.card, borderTop: `3px solid ${color}` }}>
      <div style={styles.cardLabel}>{label}</div>
      <div style={styles.cardTotal}>{total}</div>
      <div style={styles.cardToday}>+{today} today</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "800px",
    margin: "0 auto",
    padding: "2rem 1rem",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#333",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1.5rem",
  },
  title: { margin: 0, fontSize: "1.5rem" },
  logoutBtn: {
    padding: "0.5rem 1rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  error: { color: "#d32f2f", fontSize: "0.875rem" },
  statusBar: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.75rem 1rem",
    background: "#fff",
    borderRadius: "6px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    marginBottom: "1.5rem",
    fontSize: "0.95rem",
  },
  statusDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    display: "inline-block",
    flexShrink: 0,
  },
  statusDetail: {
    fontSize: "0.8rem",
    color: "#999",
    marginLeft: "0.5rem",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: "1rem",
  },
  card: {
    background: "#fff",
    borderRadius: "6px",
    padding: "1.25rem",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
  },
  cardLabel: { fontSize: "0.85rem", color: "#666", marginBottom: "0.5rem" },
  cardTotal: { fontSize: "2rem", fontWeight: 700 },
  cardToday: { fontSize: "0.85rem", color: "#999", marginTop: "0.25rem" },
};
