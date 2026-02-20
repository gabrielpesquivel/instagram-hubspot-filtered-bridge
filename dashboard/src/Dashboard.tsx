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

interface LogEntry {
  timestamp: string;
  type: "forwarded" | "skipped" | "replied" | "error";
  message: string;
}

interface ConsoleLogEntry {
  timestamp: string;
  level: "log" | "error";
  message: string;
}

export function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [error, setError] = useState("");

  async function fetchData() {
    try {
      const [statsRes, healthRes, logsRes, consoleRes] = await Promise.all([
        fetch("/api/stats"),
        fetch("/api/health"),
        fetch("/api/logs"),
        fetch("/api/console-logs"),
      ]);

      if (statsRes.status === 401 || healthRes.status === 401) {
        onLogout();
        return;
      }

      setStats(await statsRes.json());
      setHealth(await healthRes.json());
      if (logsRes.ok) setLogs(await logsRes.json());
      if (consoleRes.ok) setConsoleLogs(await consoleRes.json());
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

      <div style={styles.logSection}>
        <h2 style={styles.logTitle}>Activity Log</h2>
        <div style={styles.logContainer}>
          {logs.length === 0 ? (
            <div style={styles.logEmpty}>No activity yet</div>
          ) : (
            [...logs].reverse().map((entry, i) => (
              <div key={i} style={styles.logEntry}>
                <span style={{ ...styles.logBadge, background: logColors[entry.type] }}>
                  {entry.type}
                </span>
                <span style={styles.logMessage}>{entry.message}</span>
                <span style={styles.logTime}>
                  {formatTime(entry.timestamp)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={styles.consoleSection}>
        <button
          onClick={() => setConsoleOpen(!consoleOpen)}
          style={styles.consoleToggle}
        >
          <span style={styles.consoleToggleIcon}>{consoleOpen ? "\u25BC" : "\u25B6"}</span>
          Console Logs
          <span style={styles.consoleCount}>{consoleLogs.length}</span>
        </button>
        {consoleOpen && (
          <div style={styles.consoleContainer}>
            {consoleLogs.length === 0 ? (
              <div style={styles.consoleEmpty}>No console output</div>
            ) : (
              [...consoleLogs].reverse().map((entry, i) => (
                <div
                  key={i}
                  style={{
                    ...styles.consoleLine,
                    color: entry.level === "error" ? "#f44336" : "#b5cea8",
                  }}
                >
                  <span style={styles.consoleTime}>
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span style={styles.consoleLevel}>
                    {entry.level === "error" ? "ERR" : "LOG"}
                  </span>
                  <span style={styles.consoleText}>{entry.message}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const logColors: Record<string, string> = {
  forwarded: "#2196f3",
  skipped: "#ff9800",
  replied: "#4caf50",
  error: "#f44336",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
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
  logSection: { marginTop: "2rem" },
  logTitle: { fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.75rem" },
  logContainer: {
    background: "#fff",
    borderRadius: "6px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    maxHeight: "360px",
    overflowY: "auto" as const,
  },
  logEntry: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.6rem 1rem",
    borderBottom: "1px solid #f0f0f0",
    fontSize: "0.85rem",
  },
  logBadge: {
    color: "#fff",
    fontSize: "0.7rem",
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: "3px",
    textTransform: "uppercase" as const,
    flexShrink: 0,
    minWidth: "64px",
    textAlign: "center" as const,
  },
  logMessage: {
    flex: 1,
    color: "#333",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  logTime: {
    color: "#999",
    fontSize: "0.75rem",
    flexShrink: 0,
  },
  logEmpty: {
    padding: "2rem",
    textAlign: "center" as const,
    color: "#999",
    fontSize: "0.9rem",
  },
  consoleSection: { marginTop: "1.5rem" },
  consoleToggle: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    width: "100%",
    padding: "0.7rem 1rem",
    background: "#1e1e1e",
    color: "#ccc",
    border: "none",
    borderRadius: "6px 6px 0 0",
    cursor: "pointer",
    fontSize: "0.85rem",
    fontWeight: 600,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
  },
  consoleToggleIcon: {
    fontSize: "0.65rem",
  },
  consoleCount: {
    marginLeft: "auto",
    background: "#333",
    color: "#999",
    fontSize: "0.7rem",
    padding: "1px 7px",
    borderRadius: "10px",
  },
  consoleContainer: {
    background: "#1e1e1e",
    borderRadius: "0 0 6px 6px",
    maxHeight: "320px",
    overflowY: "auto" as const,
    padding: "0.25rem 0",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: "0.78rem",
    lineHeight: 1.6,
  },
  consoleLine: {
    display: "flex",
    gap: "0.75rem",
    padding: "2px 1rem",
    borderBottom: "1px solid #2a2a2a",
    alignItems: "baseline",
  },
  consoleTime: {
    color: "#666",
    fontSize: "0.7rem",
    flexShrink: 0,
  },
  consoleLevel: {
    fontSize: "0.65rem",
    fontWeight: 700,
    flexShrink: 0,
    width: "28px",
  },
  consoleText: {
    flex: 1,
    wordBreak: "break-word" as const,
    whiteSpace: "pre-wrap" as const,
  },
  consoleEmpty: {
    padding: "2rem",
    textAlign: "center" as const,
    color: "#666",
    fontSize: "0.85rem",
  },
};
