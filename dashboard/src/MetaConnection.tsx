interface MetaConnectionData {
  connected: boolean;
  facebook_page_name?: string;
  instagram_username?: string;
  instagram_profile_picture_url?: string;
  connected_at?: string;
  user_token_expires_at?: number;
  auto_refresh_enabled?: boolean;
}

export function MetaConnection({
  connection,
  onRefresh,
}: {
  connection: MetaConnectionData | null;
  onRefresh: () => void;
}) {
  async function handleDisconnect() {
    if (!confirm("Disconnect Instagram account? The bridge will fall back to environment variable tokens.")) {
      return;
    }
    await fetch("/api/meta/disconnect", { method: "POST" });
    onRefresh();
  }

  const isConnected = connection?.connected;
  const expiresAt = connection?.user_token_expires_at;
  const expiresInDays = expiresAt
    ? Math.floor((expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
    : null;
  const expiringSoon = expiresInDays !== null && expiresInDays <= 7;

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Instagram Connection</h2>
      {isConnected ? (
        <div style={styles.connectedBox}>
          <div style={styles.accountRow}>
            {connection!.instagram_profile_picture_url && (
              <img
                src={connection!.instagram_profile_picture_url}
                alt=""
                style={styles.avatar}
              />
            )}
            <div>
              <div style={styles.username}>
                @{connection!.instagram_username}
              </div>
              <div style={styles.pageName}>
                via {connection!.facebook_page_name}
              </div>
              <div style={styles.meta}>
                Connected {new Date(connection!.connected_at!).toLocaleDateString()}
              </div>
              {expiresInDays !== null && (
                <div
                  style={{
                    ...styles.meta,
                    color: expiringSoon ? "#f44336" : "#999",
                    fontWeight: expiringSoon ? 600 : 400,
                  }}
                >
                  {connection!.auto_refresh_enabled
                    ? `Token expires in ${expiresInDays} days (auto-renews daily)`
                    : expiringSoon
                      ? `Token expires in ${expiresInDays} day(s) — reconnect soon`
                      : `Token expires in ${expiresInDays} days`}
                </div>
              )}
            </div>
          </div>
          {!connection!.auto_refresh_enabled && (
            <div style={styles.refreshWarning}>
              Auto-renewal is off for this connection.{" "}
              <a href="/auth/facebook" style={styles.refreshWarningLink}>
                Reconnect once
              </a>{" "}
              to stop the token from expiring every ~60 days.
            </div>
          )}
          <button onClick={handleDisconnect} style={styles.disconnectBtn}>
            Disconnect
          </button>
        </div>
      ) : (
        <div style={styles.disconnectedBox}>
          <p style={styles.disconnectedText}>
            No Instagram account connected. Connect via Facebook Login to enable the bridge pipeline with OAuth tokens.
          </p>
          <a href="/auth/facebook" style={styles.connectBtn}>
            Connect Instagram Account
          </a>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    marginBottom: "1.5rem",
  },
  title: {
    fontSize: "1.1rem",
    fontWeight: 600,
    margin: 0,
    marginBottom: "0.75rem",
  },
  connectedBox: {
    background: "var(--surface)",
    borderRadius: "6px",
    padding: "1.25rem",
    boxShadow: "0 1px 4px var(--shadow)",
    borderLeft: "3px solid #4caf50",
  },
  accountRow: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    marginBottom: "0.75rem",
  },
  avatar: {
    width: "48px",
    height: "48px",
    borderRadius: "50%",
    flexShrink: 0,
  },
  username: {
    fontWeight: 600,
    fontSize: "1rem",
  },
  pageName: {
    fontSize: "0.85rem",
    color: "var(--text-muted)",
  },
  meta: {
    fontSize: "0.8rem",
    color: "var(--text-faint)",
    marginTop: "2px",
  },
  refreshWarning: {
    background: "#fff3e0",
    border: "1px solid #ffb74d",
    borderRadius: "4px",
    padding: "0.5rem 0.75rem",
    fontSize: "0.78rem",
    color: "#7a4f01",
    marginBottom: "0.75rem",
  },
  refreshWarningLink: {
    color: "#1877f2",
    fontWeight: 600,
  },
  disconnectBtn: {
    padding: "0.4rem 0.8rem",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "var(--text-muted)",
  },
  disconnectedBox: {
    background: "var(--surface)",
    borderRadius: "6px",
    padding: "1.25rem",
    boxShadow: "0 1px 4px var(--shadow)",
    borderLeft: "3px solid #ff9800",
    textAlign: "center" as const,
  },
  disconnectedText: {
    fontSize: "0.9rem",
    color: "var(--text-muted)",
    margin: "0 0 1rem 0",
  },
  connectBtn: {
    display: "inline-block",
    padding: "0.6rem 1.2rem",
    background: "#1877f2",
    color: "#fff",
    borderRadius: "6px",
    textDecoration: "none",
    fontSize: "0.9rem",
    fontWeight: 600,
  },
};
