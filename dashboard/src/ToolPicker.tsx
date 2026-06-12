interface ToolPickerProps {
  onSelect: (tool: "bridge" | "gangsheet") => void;
  onLogout: () => void;
}

export function ToolPicker({ onSelect, onLogout }: ToolPickerProps) {
  return (
    <div style={styles.container}>
      <div style={styles.panel}>
        <img src="/logo.png" alt="BootInk" style={styles.logo} />
        <h1 style={styles.title}>Internal Tools</h1>
        <p style={styles.subtitle}>Pick a tool to get started</p>

        <div style={styles.grid}>
          <button style={styles.card} onClick={() => onSelect("gangsheet")}>
            <span style={styles.cardName}>Gangsheet Generator</span>
            <span style={styles.cardDesc}>
              Turn Shopify order CSVs into print-ready gangsheet PDF/AI files
            </span>
          </button>

          <button style={styles.card} onClick={() => onSelect("bridge")}>
            <span style={styles.cardName}>Instagram DM Manager</span>
            <span style={styles.cardDesc}>
              Filter, approve and answer Instagram DMs — with AI-assisted replies
            </span>
          </button>
        </div>

        <button onClick={onLogout} style={styles.logoutBtn}>
          Log out
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100vh",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: "#f5f5f5",
  },
  panel: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "0.75rem",
    padding: "2rem 1rem",
    width: "100%",
    maxWidth: "640px",
  },
  logo: { width: "240px", height: "auto" },
  title: { margin: 0, fontSize: "1.5rem", color: "#333", textAlign: "center" as const },
  subtitle: { margin: 0, fontSize: "0.9rem", color: "#888" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "1rem",
    width: "100%",
    marginTop: "1rem",
  },
  card: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    padding: "1.25rem",
    aspectRatio: "1 / 1",
    cursor: "pointer",
    textAlign: "center" as const,
    fontFamily: "inherit",
  },
  cardName: { fontSize: "1.4rem", fontWeight: 700, color: "#222", lineHeight: 1.25 },
  cardDesc: { fontSize: "0.82rem", color: "#777", lineHeight: 1.4 },
  logoutBtn: {
    marginTop: "1.5rem",
    padding: "0.4rem 1rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "#666",
  },
};
