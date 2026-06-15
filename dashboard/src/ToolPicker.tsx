import { FileCalendar } from "./FileCalendar";

interface ToolPickerProps {
  onSelect: (tool: "bridge" | "gangsheet") => void;
  onLogout: () => void;
}

export function ToolPicker({ onSelect, onLogout }: ToolPickerProps) {
  return (
    <div style={styles.container}>
      <div style={styles.topbar}>
        <img src="/logo.png" alt="BootInk" style={styles.logo} />
        <button onClick={onLogout} style={styles.logoutBtn}>
          Log out
        </button>
      </div>

      <div style={styles.columns}>
        {/* Left: daily gangsheet upload calendar */}
        <section style={styles.left}>
          <h2 style={styles.colTitle}>Daily Gangsheets</h2>
          <p style={styles.colSub}>Upload, replace or delete the gangsheets for each work day</p>
          <FileCalendar />
        </section>

        {/* Right: existing tools */}
        <section style={styles.right}>
          <h2 style={styles.colTitle}>Tools</h2>
          <p style={styles.colSub}>Pick a tool to get started</p>

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
        </section>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: "#f5f5f5",
    padding: "1.5rem",
    boxSizing: "border-box" as const,
  },
  topbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "1.5rem",
  },
  logo: { width: "180px", height: "auto" },
  logoutBtn: {
    padding: "0.4rem 1rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "#666",
  },
  columns: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
    gap: "2rem",
    maxWidth: "1100px",
    margin: "0 auto",
    alignItems: "start",
  },
  left: { minWidth: 0 },
  right: { minWidth: 0 },
  colTitle: { margin: "0 0 0.25rem", fontSize: "1.25rem", color: "#222" },
  colSub: { margin: "0 0 1rem", fontSize: "0.85rem", color: "#888" },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "1rem",
    width: "100%",
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
    padding: "1.5rem 1.25rem",
    cursor: "pointer",
    textAlign: "center" as const,
    fontFamily: "inherit",
  },
  cardName: { fontSize: "1.3rem", fontWeight: 700, color: "#222", lineHeight: 1.25 },
  cardDesc: { fontSize: "0.82rem", color: "#777", lineHeight: 1.4 },
};
