import { Conversations } from "./Conversations";
import { Toaster } from "./toast";

export function DmManager({
  onLogout,
  onBack,
}: {
  onLogout: () => void;
  onBack: () => void;
}) {
  return (
    <div style={styles.wrapper}>
      <header style={styles.topBar}>
        <div style={styles.topBarInner}>
          <button
            onClick={onBack}
            style={{ ...styles.logoutBtn, marginLeft: 0, marginRight: "0.75rem" }}
          >
            ← Dashboard
          </button>
          <img src="/logo.png" alt="BootInk" style={styles.topBarLogo} />
          <span style={styles.topBarTitle}>Instagram DM Manager</span>
          <button onClick={onLogout} style={styles.logoutBtn}>
            Log out
          </button>
        </div>
      </header>

      <div style={styles.body}>
        <Conversations fullPage />
      </div>

      <Toaster />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#333",
    height: "100vh",
    display: "flex",
    flexDirection: "column" as const,
    background: "#f5f5f5",
    overflow: "hidden",
  },
  topBar: {
    background: "#fff",
    borderBottom: "1px solid #e0e0e0",
    padding: "0 1rem",
    flexShrink: 0,
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  },
  topBarInner: {
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
  body: {
    flex: 1,
    minHeight: 0,
    padding: "1rem",
    boxSizing: "border-box" as const,
  },
};
