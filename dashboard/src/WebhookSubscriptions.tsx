import { useState } from "react";

interface WebhookStatus {
  subscribed: boolean;
  data?: { data: Array<{ id: string; name: string; subscribed_fields: string[] }> };
  error?: unknown;
  message?: string;
}

export function WebhookSubscriptions() {
  const [status, setStatus] = useState<WebhookStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeResult, setSubscribeResult] = useState<{
    success?: boolean;
    error?: unknown;
  } | null>(null);

  async function fetchStatus() {
    setLoading(true);
    try {
      const res = await fetch("/api/meta/webhooks");
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus({ subscribed: false, error: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  async function handleSubscribe() {
    setSubscribing(true);
    setSubscribeResult(null);
    try {
      const res = await fetch("/api/meta/webhooks", { method: "POST" });
      const data = await res.json();
      setSubscribeResult(data);
      if (data.success) {
        fetchStatus();
      }
    } catch {
      setSubscribeResult({ success: false, error: "Network error" });
    } finally {
      setSubscribing(false);
    }
  }

  const apps = status?.data?.data || [];

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Webhook Subscriptions</h2>
      <div style={styles.box}>
        <div style={styles.row}>
          <button
            onClick={fetchStatus}
            disabled={loading}
            style={styles.refreshBtn}
          >
            {loading ? "Checking..." : "Check Status"}
          </button>
          <button
            onClick={handleSubscribe}
            disabled={subscribing}
            style={{
              ...styles.subscribeBtn,
              opacity: subscribing ? 0.6 : 1,
            }}
          >
            {subscribing ? "Subscribing..." : "Subscribe to Messages"}
          </button>
        </div>

        {status && (
          <div style={styles.statusSection}>
            {status.message ? (
              <div style={styles.noConnection}>{status.message}</div>
            ) : apps.length > 0 ? (
              apps.map((app, i) => (
                <div key={i} style={styles.appEntry}>
                  <div style={styles.appName}>{app.name || app.id}</div>
                  <div style={styles.fields}>
                    Fields: {app.subscribed_fields?.join(", ") || "none"}
                  </div>
                </div>
              ))
            ) : (
              <div style={styles.noSubscription}>
                No webhook subscriptions found for this page.
              </div>
            )}
          </div>
        )}

        {subscribeResult && !subscribeResult.success && (
          <div style={styles.error}>
            <pre style={styles.errorPre}>
              {JSON.stringify(subscribeResult.error, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    marginTop: "1.5rem",
  },
  title: {
    fontSize: "1.1rem",
    fontWeight: 600,
    margin: 0,
    marginBottom: "0.75rem",
  },
  box: {
    background: "var(--surface)",
    borderRadius: "6px",
    padding: "1.25rem",
    boxShadow: "0 1px 4px var(--shadow)",
  },
  row: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "0.75rem",
  },
  refreshBtn: {
    padding: "0.4rem 0.8rem",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
  subscribeBtn: {
    padding: "0.4rem 0.8rem",
    background: "#1877f2",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  statusSection: {
    marginTop: "0.5rem",
  },
  appEntry: {
    padding: "0.5rem",
    background: "var(--surface-2)",
    borderRadius: "4px",
    marginBottom: "0.5rem",
  },
  appName: {
    fontWeight: 600,
    fontSize: "0.85rem",
  },
  fields: {
    fontSize: "0.8rem",
    color: "var(--text-muted)",
    marginTop: "2px",
  },
  noSubscription: {
    fontSize: "0.85rem",
    color: "var(--text-faint)",
    fontStyle: "italic",
  },
  noConnection: {
    fontSize: "0.85rem",
    color: "#ff9800",
  },
  error: {
    marginTop: "0.5rem",
    padding: "0.5rem",
    background: "#fef0f0",
    borderRadius: "4px",
    border: "1px solid #f44336",
  },
  errorPre: {
    fontSize: "0.75rem",
    margin: 0,
    overflow: "auto",
    whiteSpace: "pre-wrap" as const,
    color: "#d32f2f",
  },
};
