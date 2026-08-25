import { DigestCard } from "./DigestCard";
import { FileCalendar } from "./FileCalendar";
import { TodoList } from "./TodoList";
import { ThemeToggle } from "./ThemeToggle";

interface ToolPickerProps {
  onSelect: (tool: "support" | "gangsheet") => void;
  onLogout: () => void;
}

export function ToolPicker({ onSelect, onLogout }: ToolPickerProps) {
  return (
    <div style={styles.container}>
      {/* Header: gangsheet button left, logo centered, customer support right */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.tab} onClick={() => onSelect("gangsheet")}>
            Gangsheet Generator
          </button>
          <button style={styles.tab} onClick={() => onSelect("support")}>
            Customer Support
          </button>
        </div>
        <img src="/logo.png" alt="BootInk" style={styles.logo} />
        <div style={styles.headerRight}>
          <ThemeToggle />
          <button onClick={onLogout} style={styles.logoutBtn}>
            Log out
          </button>
        </div>
      </header>

      <div style={styles.columns}>
        {/* Left: daily gangsheet calendar */}
        <section style={styles.left}>
          <h2 style={styles.colTitle}>Daily Gangsheets</h2>
          <p style={styles.colSub}>Upload, replace or delete the gangsheets for each work day</p>
          <FileCalendar />
        </section>

        {/* Right: daily digest + to-do checklist */}
        <section style={styles.right}>
          {/* Invisible copy of the left column's title block so the digest
              card top lines up with the calendar's "This week" row */}
          <div style={{ visibility: "hidden" }} aria-hidden="true">
            <h2 style={styles.colTitle}>&nbsp;</h2>
            <p style={styles.colSub}>&nbsp;</p>
          </div>
          <DigestCard />
          <TodoList />
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
    background: "var(--bg)",
    color: "var(--text)",
    padding: "1.5rem",
    boxSizing: "border-box" as const,
  },
  header: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    gap: "1.5rem",
    maxWidth: "1100px",
    margin: "0 auto 1.75rem",
    paddingBottom: "1rem",
    borderBottom: "1px solid var(--border)",
  },
  logo: {
    width: "150px",
    height: "auto",
    flexShrink: 0,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "0.75rem",
  },
  tab: {
    padding: "0.5rem 1.25rem",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: "0.9rem",
    fontWeight: 600,
    color: "var(--text)",
    boxShadow: "0 1px 3px var(--shadow)",
    fontFamily: "inherit",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "0.6rem",
    flexShrink: 0,
  },
  logoutBtn: {
    padding: "0.4rem 1rem",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "var(--text-muted)",
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
  colTitle: { margin: "0 0 0.25rem", fontSize: "1.25rem", color: "var(--text)" },
  colSub: { margin: "0 0 1rem", fontSize: "0.85rem", color: "var(--text-muted)" },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "1rem",
    width: "100%",
  },
  card: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
    aspectRatio: "1 / 1",
    background: "#fff",
    border: "1px solid #e0e0e0",
    borderRadius: "12px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
    padding: "1.5rem 1.25rem",
    cursor: "pointer",
    textAlign: "center" as const,
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
  },
  cardName: { fontSize: "1.3rem", fontWeight: 700, color: "#222", lineHeight: 1.25 },
  cardDesc: { fontSize: "0.82rem", color: "#777", lineHeight: 1.4 },
};
