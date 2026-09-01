import { useEffect, useRef, useState } from "react";
import { MetaConnection } from "./MetaConnection";
import { FilterSettings } from "./FilterSettings";
import { WebhookSubscriptions } from "./WebhookSubscriptions";
import { AgentSettings } from "./AgentSettings";
import { DigestCard } from "./DigestCard";
import { Toaster, toast } from "./toast";
import { TopBarActions } from "./TopBar";

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
  has_meta_connection: boolean;
  has_gemini_key: boolean;
}

interface MetaConnectionData {
  connected: boolean;
  facebook_page_name?: string;
  instagram_username?: string;
  instagram_profile_picture_url?: string;
  connected_at?: string;
  user_token_expires_at?: number;
  auto_refresh_enabled?: boolean;
}

interface FilterSettingsData {
  min_followers: number;
  skip_verified: boolean;
}

interface AgentSettingsData {
  gemini_model: string;
  auto_approve_known: boolean;
  has_gemini_key: boolean;
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
  windowExpired?: boolean;
  language?: string;
}

interface BlocklistEntry {
  senderId: string;
  username: string;
  blockedAt: string;
}

type LogTab = "pending" | "skipped";

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([]);
  const [metaConnection, setMetaConnection] =
    useState<MetaConnectionData | null>(null);
  const [filterSettings, setFilterSettings] =
    useState<FilterSettingsData | null>(null);
  const [agentSettings, setAgentSettings] =
    useState<AgentSettingsData | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [blocklist, setBlocklist] = useState<BlocklistEntry[]>([]);
  const [blockInput, setBlockInput] = useState("");
  const [activeTab, setActiveTab] = useState<LogTab>("pending");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [error, setError] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyOpenId, setReplyOpenId] = useState<string | null>(null);
  const [sendingReplyId, setSendingReplyId] = useState<string | null>(null);
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied"
  );
  const prevPendingCount = useRef<number | null>(null);

  async function fetchData() {
    try {
      const [statsRes, healthRes, logsRes, consoleRes, connectionRes, filterRes, agentRes, pendingRes, blocklistRes] =
        await Promise.all([
          fetch("/api/stats"),
          fetch("/api/health"),
          fetch("/api/logs"),
          fetch("/api/console-logs"),
          fetch("/api/meta/connection"),
          fetch("/api/settings/filter"),
          fetch("/api/settings/agent"),
          fetch("/api/pending"),
          fetch("/api/blocklist"),
        ]);

      if (statsRes.status === 401 || healthRes.status === 401) {
        // Session expired — reload; the health check in App shows the login.
        window.location.reload();
        return;
      }

      setStats(await statsRes.json());
      setHealth(await healthRes.json());
      if (logsRes.ok) setLogs(await logsRes.json());
      if (consoleRes.ok) setConsoleLogs(await consoleRes.json());
      if (connectionRes.ok) setMetaConnection(await connectionRes.json());
      if (filterRes.ok) setFilterSettings(await filterRes.json());
      if (agentRes.ok) setAgentSettings(await agentRes.json());
      if (pendingRes.ok) {
        const pending: PendingMessage[] = await pendingRes.json();
        // Notify on new pending messages (skip initial load)
        if (
          prevPendingCount.current !== null &&
          pending.length > prevPendingCount.current
        ) {
          const newest = pending[pending.length - 1];
          const text = `New DM from @${newest?.senderUsername ?? "someone"}`;
          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted" &&
            document.hidden
          ) {
            new Notification("Instagram DM Manager", { body: text });
          } else {
            toast(text, "info");
          }
        }
        prevPendingCount.current = pending.length;
        setPendingMessages(pending);
      }
      if (blocklistRes.ok) setBlocklist(await blocklistRes.json());
      setError("");
    } catch {
      setError("Failed to fetch data");
    }
  }

  const fetchDataRef = useRef(fetchData);
  fetchDataRef.current = fetchData;

  async function handleApprove(id: string) {
    const msg = pendingMessages.find((m) => m.id === id);
    // Remove this message + all from same sender instantly
    if (msg) {
      setPendingMessages((prev) => prev.filter((m) => m.senderId !== msg.senderId));
    }
    fetch("/api/pending/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
      .then((res) => {
        if (!res.ok) toast("Approve failed — message restored");
      })
      .catch(() => toast("Network error — approve failed"))
      .finally(() => fetchData());
  }

  async function handleReject(id: string) {
    const msg = pendingMessages.find((m) => m.id === id);
    if (msg) {
      setPendingMessages((prev) => prev.filter((m) => m.senderId !== msg.senderId));
      setBlocklist((prev) => [...prev, { senderId: msg.senderId, username: msg.senderUsername, blockedAt: new Date().toISOString() }]);
    }
    fetch("/api/pending/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
      .then((res) => {
        if (!res.ok) toast("Reject failed — message restored");
      })
      .catch(() => toast("Network error — reject failed"))
      .finally(() => fetchData());
  }

  async function handleDismiss(id: string) {
    setPendingMessages((prev) => prev.filter((m) => m.id !== id));
    fetch("/api/pending/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })
      .then((res) => {
        if (!res.ok) toast("Dismiss failed — message restored");
      })
      .catch(() => toast("Network error — dismiss failed"))
      .finally(() => fetchData());
  }

  async function handleUnblock(senderId: string) {
    setBlocklist((prev) => prev.filter((e) => e.senderId !== senderId));
    fetch("/api/blocklist/unblock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId }),
    }).then(() => fetchData());
  }

  async function handleApproveAll() {
    if (pendingMessages.length === 0) return;
    if (!confirm(`Approve all ${pendingMessages.length} pending messages?`)) return;
    setPendingMessages([]);
    await fetch("/api/pending/approve-all", { method: "POST" });
    fetchData();
  }

  async function handleDismissAll() {
    if (pendingMessages.length === 0) return;
    if (!confirm(`Dismiss all ${pendingMessages.length} pending messages?`)) return;
    setPendingMessages([]);
    await fetch("/api/pending/dismiss-all", { method: "POST" });
    fetchData();
  }

  async function handleClearAllConversations() {
    if (!confirm("Clear ALL conversations? This cannot be undone.")) return;
    await fetch("/api/conversations/clear-all", { method: "POST" });
    fetchData();
  }

  async function handleAddBlock() {
    const username = blockInput.trim().replace(/^@/, "");
    if (!username) return;
    await fetch("/api/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    setBlockInput("");
    fetchData();
  }

  useEffect(() => {
    fetchData();
    // 30s polling stays as fallback; WebSocket below pushes updates instantly
    const interval = setInterval(() => fetchDataRef.current(), 30_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live updates: WebSocket to the worker's Durable Object; reconnects with
  // backoff, debounces bursts of change events into one refetch.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retryMs = 1000;
    let debounce: number | undefined;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      try {
        ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      } catch {
        return;
      }
      ws.onopen = () => {
        retryMs = 1000;
      };
      ws.onmessage = () => {
        clearTimeout(debounce);
        debounce = window.setTimeout(() => fetchDataRef.current(), 300);
      };
      ws.onclose = () => {
        if (!closed) {
          retryMs = Math.min(retryMs * 2, 30_000);
          setTimeout(connect, retryMs);
        }
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(debounce);
      ws?.close();
    };
  }, []);

  // Tab title badge with pending count
  useEffect(() => {
    document.title =
      pendingMessages.length > 0
        ? `(${pendingMessages.length}) DM Manager`
        : "BootInk Internal Tools";
    return () => {
      document.title = "BootInk Internal Tools";
    };
  }, [pendingMessages.length]);

  async function handleApproveReply(id: string) {
    const text = replyDrafts[id]?.trim();
    if (!text) return;
    setSendingReplyId(id);
    try {
      const res = await fetch("/api/pending/approve-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, text }),
      });
      if (res.ok) {
        toast("Approved & reply sent", "success");
        const msg = pendingMessages.find((m) => m.id === id);
        if (msg) {
          setPendingMessages((prev) => prev.filter((m) => m.senderId !== msg.senderId));
        }
        setReplyOpenId(null);
        setReplyDrafts((prev) => ({ ...prev, [id]: "" }));
      } else {
        const body = await res.json().catch(() => ({}));
        toast(body.error || "Approve & reply failed");
      }
    } catch {
      toast("Network error — approve & reply failed");
    } finally {
      setSendingReplyId(null);
      fetchData();
    }
  }

  const skippedLogs = logs.filter((l) => l.type === "skipped");
  const totalSkipped = stats
    ? stats.skipped_verified.total + stats.skipped_high_followers.total + stats.skipped_blocklisted.total
    : 0;
  const todaySkipped = stats
    ? stats.skipped_verified.today + stats.skipped_high_followers.today + stats.skipped_blocklisted.today
    : 0;

  return (
    <div style={styles.wrapper}>
      <TopBarActions>
        {notifPerm === "default" && (
          <button
            onClick={() =>
              Notification.requestPermission().then((p) => setNotifPerm(p))
            }
            style={styles.logoutBtn}
            title="Get a desktop notification when a new DM arrives"
          >
            🔔 Enable alerts
          </button>
        )}
      </TopBarActions>

      <div style={styles.page}>
      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.columns}>
        {/* Left column — connection, config & blocklist */}
        <div style={styles.leftCol}>
          <MetaConnection connection={metaConnection} onRefresh={fetchData} />
          <WebhookSubscriptions />
          <FilterSettings settings={filterSettings} onUpdate={fetchData} />
          <AgentSettings settings={agentSettings} onUpdate={fetchData} />

          {/* Blocklist section */}
          <div style={styles.blocklistSection}>
            <h3 style={styles.blocklistTitle}>Blocked Senders ({blocklist.length})</h3>
            <form
              onSubmit={(e) => { e.preventDefault(); handleAddBlock(); }}
              style={styles.blocklistForm}
            >
              <input
                type="text"
                value={blockInput}
                onChange={(e) => setBlockInput(e.target.value)}
                placeholder="@username"
                style={styles.blocklistInput}
              />
              <button type="submit" style={styles.blocklistAddBtn}>Block</button>
            </form>
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
          <div style={{ marginBottom: "1rem" }}>
            <DigestCard />
          </div>
          {stats && (
            <div style={styles.grid}>
              <StatCard
                label="Pending"
                total={pendingMessages.length}
                today={stats.pending.today}
                color="#ff9800"
              />
              <StatCard
                label="Approved"
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

          {/* Tabbed section */}
          <div style={styles.logSection}>
            <div style={styles.tabBar}>
              {(["pending", "skipped"] as LogTab[]).map((tab) => (
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
              <button
                onClick={() => { window.location.hash = "#/dms"; }}
                style={styles.convLaunchBtn}
                title="Open the full-page DM manager"
              >
                Conversations →
              </button>
            </div>

            <div style={styles.logContainer}>
              {activeTab === "pending" && (
                pendingMessages.length === 0 ? (
                  <div style={styles.logEmpty}>No pending messages</div>
                ) : (
                  <>
                  <div style={styles.bulkActions}>
                    <button onClick={handleApproveAll} style={styles.approveAllBtn}>
                      Accept All ({pendingMessages.length})
                    </button>
                    <button onClick={handleDismissAll} style={styles.clearAllBtn}>
                      Dismiss All
                    </button>
                    <button onClick={handleClearAllConversations} style={styles.clearAllBtn}>
                      Clear Conversations
                    </button>
                  </div>
                  {[...pendingMessages].reverse().map((msg) => (
                    <div key={msg.id} style={styles.pendingEntry}>
                      <div style={styles.pendingTop}>
                        <span style={styles.pendingUser}>@{msg.senderUsername}</span>
                        {msg.language && (
                          <span style={styles.langBadge}>{msg.language}</span>
                        )}
                        {msg.windowExpired && (
                          <span style={styles.expiredBadge}>24h expired</span>
                        )}
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
                          onClick={() =>
                            setReplyOpenId(replyOpenId === msg.id ? null : msg.id)
                          }
                          style={styles.replyToggleBtn}
                        >
                          Approve & Reply…
                        </button>
                        <button
                          onClick={() => handleReject(msg.id)}
                          style={styles.rejectBtn}
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => handleDismiss(msg.id)}
                          style={styles.dismissBtn}
                        >
                          Dismiss
                        </button>
                      </div>
                      {replyOpenId === msg.id && (
                        <div style={styles.inlineReplyRow}>
                          <textarea
                            value={replyDrafts[msg.id] || ""}
                            onChange={(e) =>
                              setReplyDrafts((prev) => ({ ...prev, [msg.id]: e.target.value }))
                            }
                            placeholder={`Reply to @${msg.senderUsername}…`}
                            rows={2}
                            style={styles.inlineReplyInput}
                            autoFocus
                          />
                          <button
                            onClick={() => handleApproveReply(msg.id)}
                            disabled={sendingReplyId === msg.id || !replyDrafts[msg.id]?.trim()}
                            style={styles.inlineReplySend}
                          >
                            {sendingReplyId === msg.id ? "Sending…" : "Send"}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  </>
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

      <div style={styles.buildStamp}>
        Last updated {formatBuildTime()}
      </div>
      <Toaster />
    </div>
  );
}

declare const __BUILD_TIME__: string;

function formatBuildTime(): string {
  const d = new Date(__BUILD_TIME__);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " at " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
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
    flexWrap: "wrap" as const,
  },
  leftCol: {
    flexBasis: "calc(30% - 0.75rem)",
    flexGrow: 0,
    flexShrink: 0,
    minWidth: "280px",
    maxWidth: "100%",
  },
  rightCol: {
    flexBasis: "calc(70% - 0.75rem)",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  error: { color: "#d32f2f", fontSize: "0.875rem" },
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
  convLaunchBtn: {
    marginLeft: "auto",
    alignSelf: "center",
    padding: "0.5rem 1rem",
    background: "#2196f3",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.85rem",
    fontWeight: 600,
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
    minHeight: "200px",
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
  bulkActions: {
    padding: "0.5rem 1rem",
    borderBottom: "1px solid #f0f0f0",
    display: "flex",
    gap: "0.5rem",
  },
  approveAllBtn: {
    padding: "0.35rem 0.8rem",
    background: "#4caf50",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
  clearAllBtn: {
    padding: "0.35rem 0.8rem",
    background: "#f44336",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
    marginLeft: "auto",
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
  replyToggleBtn: {
    padding: "0.3rem 0.8rem",
    background: "#2196f3",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
  inlineReplyRow: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "0.5rem",
    alignItems: "flex-end",
  },
  inlineReplyInput: {
    flex: 1,
    padding: "0.5rem",
    border: "1px solid #ccc",
    borderRadius: "4px",
    fontSize: "0.85rem",
    fontFamily: "inherit",
    resize: "vertical" as const,
  },
  inlineReplySend: {
    padding: "0.45rem 1rem",
    background: "#4caf50",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  langBadge: {
    fontSize: "0.6rem",
    fontWeight: 700,
    background: "#e0e0e0",
    color: "#555",
    padding: "1px 5px",
    borderRadius: "3px",
  },
  expiredBadge: {
    fontSize: "0.6rem",
    fontWeight: 700,
    background: "#ff5722",
    color: "#fff",
    padding: "1px 5px",
    borderRadius: "3px",
  },
  dismissBtn: {
    padding: "0.3rem 0.8rem",
    background: "none",
    color: "#999",
    border: "1px solid #ccc",
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
  blocklistForm: {
    display: "flex",
    gap: "0.35rem",
    marginBottom: "0.5rem",
  },
  blocklistInput: {
    flex: 1,
    padding: "0.3rem 0.5rem",
    border: "1px solid #ccc",
    borderRadius: "4px",
    fontSize: "0.8rem",
    outline: "none",
  },
  blocklistAddBtn: {
    padding: "0.3rem 0.6rem",
    background: "#f44336",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
    flexShrink: 0,
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
  buildStamp: {
    position: "fixed" as const,
    bottom: "0.75rem",
    right: "1rem",
    fontSize: "0.7rem",
    color: "#aaa",
  },
};
