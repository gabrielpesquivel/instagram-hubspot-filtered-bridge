import { DigestCard } from "./DigestCard";
import { SiteStatusCard } from "./SiteStatusCard";
import { FileCalendar } from "./FileCalendar";
import { TodoList } from "./TodoList";
import { NotesCard } from "./NotesCard";

// Home page. Navigation, logo, theme and logout live in the SideNav shell —
// this page is just the morning-overview widgets.

export function ToolPicker() {
  return (
    <div style={styles.container}>
      {/* Hero: website health + reviews, full width across both columns */}
      <div style={styles.hero}>
        <SiteStatusCard />
      </div>

      {/* Both columns share the grid's rows (subgrid): row 1 = titles,
          row 2 = calendar week nav + day boxes ↔ digest card (so the digest's
          bottom edge lines up with the day boxes), row 3 = file panel ↔ to-do. */}
      <div style={styles.columns}>
        {/* Left: daily gangsheet calendar */}
        <section style={styles.left}>
          <div>
            <h2 style={styles.colTitle}>Daily Gangsheets</h2>
            <p style={styles.colSub}>Upload, replace or delete the gangsheets for each work day</p>
          </div>
          <FileCalendar />
        </section>

        {/* Right: the morning workflow, top to bottom — what's waiting
            (digest), then act on it (to-do) */}
        <section style={styles.right}>
          <div>
            <h2 style={styles.colTitle}>Today's Overview</h2>
            <p style={styles.colSub}>What's waiting, your checklist and store health</p>
          </div>
          <DigestCard />
          <TodoList />
        </section>
      </div>

      {/* Full-width scratchpad under both columns; persists across days */}
      <div style={styles.notesRow}>
        <NotesCard />
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
  hero: {
    maxWidth: "1100px",
    margin: "0 auto",
  },
  columns: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)",
    // Shared rows across both columns: titles / calendar-top ↔ digest /
    // file panel ↔ to-do. Each row is as tall as its tallest side, so the
    // cards' bottom edges line up horizontally.
    gridTemplateRows: "auto auto 1fr",
    columnGap: "2rem",
    rowGap: "1rem",
    maxWidth: "1100px",
    margin: "0 auto",
  },
  left: { minWidth: 0, display: "grid", gridTemplateRows: "subgrid", gridRow: "span 3" },
  right: { minWidth: 0, display: "grid", gridTemplateRows: "subgrid", gridRow: "span 3" },
  colTitle: { margin: "0 0 0.25rem", fontSize: "1.25rem", color: "var(--text)" },
  colSub: { margin: 0, fontSize: "0.85rem", color: "var(--text-muted)" },
  notesRow: {
    maxWidth: "1100px",
    margin: "1.5rem auto 0",
  },
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
