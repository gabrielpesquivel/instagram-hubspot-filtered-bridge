interface CustomerSupportProps {
  onSelect: (tool: "bridge" | "email") => void;
  onBack: () => void;
  onLogout: () => void;
}

export function CustomerSupport({ onSelect, onBack, onLogout }: CustomerSupportProps) {
  return (
    <div style={styles.wrapper}>
      <header style={styles.topBar}>
        <div style={styles.topBarInner}>
          <button onClick={onBack} style={styles.backBtn}>
            ← Tools
          </button>
          <img src="/logo.png" alt="BootInk" style={styles.topBarLogo} />
          <span style={styles.topBarTitle}>Customer Support Tools</span>
          <button onClick={onLogout} style={styles.logoutBtn}>
            Log out
          </button>
        </div>
      </header>

      <div style={styles.page}>
        <p style={styles.sub}>Pick a customer support tool</p>
        <div style={styles.grid}>
          <button style={styles.card} onClick={() => onSelect("email")}>
            <span style={styles.cardName}>Email Manager</span>
            <span style={styles.cardDesc}>Triage and answer customer support emails</span>
          </button>

          <button style={styles.card} onClick={() => onSelect("bridge")}>
            <span style={styles.cardName}>Instagram DM Manager</span>
            <span style={styles.cardDesc}>
              Filter, approve and answer Instagram DMs — with AI-assisted replies
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    minHeight: "100vh",
    background: "#f5f5f5",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
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
    maxWidth: "900px",
    margin: "0 auto",
    display: "flex",
    alignItems: "center",
    position: "relative" as const,
    height: "56px",
    gap: "0.75rem",
  },
  topBarLogo: { height: "32px", width: "auto" },
  topBarTitle: {
    position: "absolute" as const,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: "1.1rem",
    fontWeight: 600,
    color: "#222",
    whiteSpace: "nowrap" as const,
  },
  backBtn: {
    padding: "0.4rem 1rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "#666",
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
    maxWidth: "900px",
    margin: "0 auto",
    padding: "2rem 1rem",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    boxSizing: "border-box" as const,
  },
  sub: { margin: "0 0 1.5rem", fontSize: "0.85rem", color: "#888", textAlign: "center" as const },
  grid: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "1.5rem",
    justifyContent: "center",
  },
  card: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "0.75rem",
    width: "260px",
    height: "260px",
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: "12px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    padding: "1.5rem",
    cursor: "pointer",
    textAlign: "center" as const,
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
  },
  cardName: { fontSize: "1.3rem", fontWeight: 700, color: "#222", lineHeight: 1.25 },
  cardDesc: { fontSize: "0.82rem", color: "#777", lineHeight: 1.4 },
};
