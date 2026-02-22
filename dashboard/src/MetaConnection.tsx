interface MetaConnectionData {
  connected: boolean;
  facebook_page_name?: string;
  instagram_username?: string;
  instagram_profile_picture_url?: string;
  connected_at?: string;
  user_token_expires_at?: number;
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
                  {expiringSoon
                    ? `Token expires in ${expiresInDays} day(s) — reconnect soon`
                    : `Token expires in ${expiresInDays} days`}
                </div>
              )}
            </div>
          </div>
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
    background: "#fff",
    borderRadius: "6px",
    padding: "1.25rem",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
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
    color: "#666",
  },
  meta: {
    fontSize: "0.8rem",
    color: "#999",
    marginTop: "2px",
  },
  disconnectBtn: {
    padding: "0.4rem 0.8rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "#666",
  },
  disconnectedBox: {
    background: "#fff",
    borderRadius: "6px",
    padding: "1.25rem",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    borderLeft: "3px solid #ff9800",
    textAlign: "center" as const,
  },
  disconnectedText: {
    fontSize: "0.9rem",
    color: "#666",
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
