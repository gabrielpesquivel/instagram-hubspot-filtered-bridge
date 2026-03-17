import { useEffect, useState } from "react";
import { MetaConnection } from "./MetaConnection";
import { FilterSettings } from "./FilterSettings";
import { WebhookSubscriptions } from "./WebhookSubscriptions";

interface Stats {
  pending: { total: number; today: number };
  forwarded: { total: number; today: number };
  skipped_verified: { total: number; today: number };
  skipped_high_followers: { total: number; today: number };
  skipped_blocklisted: { total: number; today: number };
  replied: { total: number; today: number };
  errors: { total: number; today: number };
}

interface Health {
  pipeline_active: boolean;
  has_hubspot_token: boolean;
  has_channel_id: boolean;
  has_meta_connection: boolean;
}

interface MetaConnectionData {
  connected: boolean;
  facebook_page_name?: string;
  instagram_username?: string;
  instagram_profile_picture_url?: string;
  connected_at?: string;
  user_token_expires_at?: number;
}

interface FilterSettingsData {
  min_followers: number;
  skip_verified: boolean;
}

interface LogEntry {
  timestamp: string;
  type: "forwarded" | "skipped" | "replied" | "error" | "pending";
  message: string;
}

interface ConsoleLogEntry {
  timestamp: string;
  level: "log" | "error";
  message: string;
}

interface PendingMessage {
  id: string;
  senderId: string;
  senderUsername: string;
  followerCount?: number;
  isVerified?: boolean;
  messageText: string;
  hasMedia: boolean;
  timestamp: string;
}

interface BlocklistEntry {
  senderId: string;
  username: string;
  blockedAt: string;
}

type LogTab = "pending" | "skipped" | "forwarded";

export function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [metaConnection, setMetaConnection] =
    useState<MetaConnectionData | null>(null);
  const [filterSettings, setFilterSettings] =
    useState<FilterSettingsData | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [blocklist, setBlocklist] = useState<BlocklistEntry[]>([]);
  const [activeTab, setActiveTab] = useState<LogTab>("pending");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [error, setError] = useState("");

  async function fetchData() {
    try {
      const [statsRes, healthRes, logsRes, consoleRes, connectionRes, filterRes, pendingRes, blocklistRes] =
        await Promise.all([
          fetch("/api/stats"),
          fetch("/api/health"),
          fetch("/api/logs"),
          fetch("/api/console-logs"),
          fetch("/api/meta/connection"),
          fetch("/api/settings/filter"),
          fetch("/api/pending"),
          fetch("/api/blocklist"),
        ]);

      if (statsRes.status === 401 || healthRes.status === 401) {
        onLogout();
        return;
      }

      setStats(await statsRes.json());
      setHealth(await healthRes.json());
      if (logsRes.ok) setLogs(await logsRes.json());
      if (consoleRes.ok) setConsoleLogs(await consoleRes.json());
      if (connectionRes.ok) setMetaConnection(await connectionRes.json());
      if (filterRes.ok) setFilterSettings(await filterRes.json());
      if (pendingRes.ok) setPendingMessages(await pendingRes.json());
      if (blocklistRes.ok) setBlocklist(await blocklistRes.json());
      setError("");
    } catch {
      setError("Failed to fetch data");
    }
  }

  async function handleApprove(id: string) {
    await fetch("/api/pending/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    fetchData();
  }

  async function handleReject(id: string) {
    await fetch("/api/pending/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    fetchData();
  }

  async function handleUnblock(senderId: string) {
    await fetch("/api/blocklist/unblock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId }),
    });
    fetchData();
  }

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, []);

  const skippedLogs = logs.filter((l) => l.type === "skipped");
  const forwardedLogs = logs.filter((l) => l.type === "forwarded" || l.type === "replied");
  const totalSkipped = stats
    ? stats.skipped_verified.total + stats.skipped_high_followers.total + stats.skipped_blocklisted.total
    : 0;
  const todaySkipped = stats
    ? stats.skipped_verified.today + stats.skipped_high_followers.today + stats.skipped_blocklisted.today
    : 0;

  return (
    <div style={styles.wrapper}>
      <header style={styles.topBar}>
        <div style={styles.topBarInner}>
          <img src="/logo.png" alt="BootInk" style={styles.topBarLogo} />
          <span style={styles.topBarTitle}>Instagram-HubSpot Filtered Bridge</span>
          <button onClick={onLogout} style={styles.logoutBtn}>
            Log out
          </button>
        </div>
      </header>

      <div style={styles.page}>
      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.columns}>
        {/* Left column — connection, config & blocklist */}
        <div style={styles.leftCol}>
          <MetaConnection connection={metaConnection} onRefresh={fetchData} />
          <WebhookSubscriptions />
          <FilterSettings settings={filterSettings} onUpdate={fetchData} />

          {/* Blocklist section */}
          <div style={styles.blocklistSection}>
            <h3 style={styles.blocklistTitle}>Blocked Senders ({blocklist.length})</h3>
            <div style={styles.blocklistContainer}>
              {blocklist.length === 0 ? (
                <div style={styles.blocklistEmpty}>No blocked senders</div>
              ) : (
                blocklist.map((entry) => (
                  <div key={entry.senderId} style={styles.blocklistEntry}>
                    <span style={styles.blocklistUser}>@{entry.username}</span>
                    <button
                      onClick={() => handleUnblock(entry.senderId)}
                      style={styles.unblockBtn}
                    >
                      Unblock
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right column — monitoring */}
        <div style={styles.rightCol}>
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
                label="Pending"
                total={pendingMessages.length}
                today={stats.pending.today}
                color="#ff9800"
              />
              <StatCard
                label="Forwarded"
                total={stats.forwarded.total}
                today={stats.forwarded.today}
                color="#2196f3"
              />
              <StatCard
                label="Skipped"
                total={totalSkipped}
                today={todaySkipped}
                color="#9c27b0"
              />
              <StatCard
                label="Blocked"
                total={blocklist.length}
                today={0}
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

          {/* Tabbed log section */}
          <div style={styles.logSection}>
            <div style={styles.tabBar}>
              {(["pending", "skipped", "forwarded"] as LogTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  style={{
                    ...styles.tab,
                    ...(activeTab === tab ? styles.tabActive : {}),
                  }}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {tab === "pending" && pendingMessages.length > 0 && (
                    <span style={styles.tabBadge}>{pendingMessages.length}</span>
                  )}
                </button>
              ))}
            </div>

            <div style={styles.logContainer}>
              {activeTab === "pending" && (
                pendingMessages.length === 0 ? (
                  <div style={styles.logEmpty}>No pending messages</div>
                ) : (
                  [...pendingMessages].reverse().map((msg) => (
                    <div key={msg.id} style={styles.pendingEntry}>
                      <div style={styles.pendingTop}>
                        <span style={styles.pendingUser}>@{msg.senderUsername}</span>
                        {msg.followerCount != null && (
                          <span style={styles.pendingMeta}>
                            {msg.followerCount.toLocaleString()} followers
                          </span>
                        )}
                        <span style={styles.logTime}>{formatTime(msg.timestamp)}</span>
                      </div>
                      <div style={styles.pendingText}>
                        {msg.messageText || (msg.hasMedia ? "[media]" : "")}
                      </div>
                      <div style={styles.pendingActions}>
                        <button
                          onClick={() => handleApprove(msg.id)}
                          style={styles.approveBtn}
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleReject(msg.id)}
                          style={styles.rejectBtn}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))
                )
              )}

              {activeTab === "skipped" && (
                skippedLogs.length === 0 ? (
                  <div style={styles.logEmpty}>No skipped messages</div>
                ) : (
                  [...skippedLogs].reverse().map((entry, i) => (
                    <div key={i} style={styles.logEntry}>
                      <span style={{ ...styles.logBadge, background: "#9c27b0" }}>
                        skipped
                      </span>
                      <span style={styles.logMessage}>{entry.message}</span>
                      <span style={styles.logTime}>
                        {formatTime(entry.timestamp)}
                      </span>
                    </div>
                  ))
                )
              )}

              {activeTab === "forwarded" && (
                forwardedLogs.length === 0 ? (
                  <div style={styles.logEmpty}>No forwarded messages</div>
                ) : (
                  [...forwardedLogs].reverse().map((entry, i) => (
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
                )
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
      </div>
      </div>
    </div>
  );
}

const logColors: Record<string, string> = {
  forwarded: "#2196f3",
  skipped: "#9c27b0",
  replied: "#4caf50",
  error: "#f44336",
  pending: "#ff9800",
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
  wrapper: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#333",
    minHeight: "100vh",
    background: "#f5f5f5",
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
    maxWidth: "1100px",
    margin: "0 auto",
    display: "flex",
    alignItems: "center",
    position: "relative" as const,
    height: "56px",
  },
  topBarLogo: {
    height: "32px",
    width: "auto",
  },
  topBarTitle: {
    position: "absolute" as const,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: "1.1rem",
    fontWeight: 600,
    color: "#222",
    whiteSpace: "nowrap" as const,
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
  page: {
    maxWidth: "1100px",
    margin: "0 auto",
    padding: "1.5rem 1rem",
  },
  columns: {
    display: "flex",
    gap: "1.5rem",
    alignItems: "flex-start",
  },
  leftCol: {
    width: "280px",
    flexShrink: 0,
  },
  rightCol: {
    flex: 1,
    minWidth: 0,
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
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
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
  tabBar: {
    display: "flex",
    gap: "0",
    marginBottom: "0",
  },
  tab: {
    padding: "0.6rem 1.25rem",
    background: "#e8e8e8",
    border: "none",
    borderRadius: "6px 6px 0 0",
    cursor: "pointer",
    fontSize: "0.85rem",
    fontWeight: 600,
    color: "#666",
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
  },
  tabActive: {
    background: "#fff",
    color: "#333",
    boxShadow: "0 -1px 4px rgba(0,0,0,0.06)",
  },
  tabBadge: {
    background: "#ff9800",
    color: "#fff",
    fontSize: "0.65rem",
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: "10px",
    minWidth: "18px",
    textAlign: "center" as const,
  },
  logContainer: {
    background: "#fff",
    borderRadius: "0 6px 6px 6px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    maxHeight: "420px",
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
  pendingEntry: {
    padding: "0.75rem 1rem",
    borderBottom: "1px solid #f0f0f0",
    fontSize: "0.85rem",
  },
  pendingTop: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginBottom: "0.35rem",
  },
  pendingUser: {
    fontWeight: 600,
    color: "#333",
  },
  pendingMeta: {
    fontSize: "0.75rem",
    color: "#999",
  },
  pendingText: {
    color: "#555",
    marginBottom: "0.5rem",
    lineHeight: 1.4,
    wordBreak: "break-word" as const,
  },
  pendingActions: {
    display: "flex",
    gap: "0.5rem",
  },
  approveBtn: {
    padding: "0.3rem 0.8rem",
    background: "#4caf50",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
  rejectBtn: {
    padding: "0.3rem 0.8rem",
    background: "#f44336",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
  blocklistSection: {
    marginTop: "1rem",
    background: "#fff",
    borderRadius: "6px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    padding: "1rem",
  },
  blocklistTitle: {
    fontSize: "0.9rem",
    fontWeight: 600,
    margin: 0,
    marginBottom: "0.5rem",
  },
  blocklistContainer: {
    maxHeight: "200px",
    overflowY: "auto" as const,
  },
  blocklistEmpty: {
    fontSize: "0.8rem",
    color: "#999",
    textAlign: "center" as const,
    padding: "0.5rem",
  },
  blocklistEntry: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.35rem 0",
    borderBottom: "1px solid #f0f0f0",
    fontSize: "0.8rem",
  },
  blocklistUser: {
    color: "#333",
    fontWeight: 500,
  },
  unblockBtn: {
    padding: "0.2rem 0.6rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "3px",
    cursor: "pointer",
    fontSize: "0.7rem",
    color: "#666",
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
