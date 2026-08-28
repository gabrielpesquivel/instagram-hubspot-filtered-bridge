import { useEffect, useState } from "react";

// Fixed daily checklist in the order the work happens each morning. Tick state
// is stored per calendar day in localStorage, so it naturally resets each new day.
const TASKS = [
  { id: "emails", label: "Answer emails" },
  { id: "dms", label: "Answer Instagram DMs" },
  { id: "gangsheet", label: "Generate gangsheet" },
  { id: "prints", label: "Print gangsheets" },
];

function todayKey(): string {
  return `todo:${new Date().toISOString().slice(0, 10)}`;
}

export function TodoList() {
  const [done, setDone] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(todayKey());
      if (raw) setDone(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  function toggle(id: string) {
    setDone((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(todayKey(), JSON.stringify(next));
      } catch {
        /* ignore */
      }
      // Same-tab localStorage writes don't fire "storage" — tell siblings
      // (DigestCard mirrors the "emails" tick) explicitly.
      window.dispatchEvent(new Event("todo-changed"));
      return next;
    });
  }

  const completed = TASKS.filter((t) => done[t.id]).length;

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>Today's To-Do</span>
        <span style={{ ...styles.count, ...(completed === TASKS.length ? styles.countDone : {}) }}>
          {completed}/{TASKS.length}
        </span>
      </div>

      <ul style={styles.list}>
        {TASKS.map((task, i) => {
          const checked = !!done[task.id];
          return (
            <li
              key={task.id}
              style={{ ...styles.item, ...(i > 0 ? styles.itemDivider : {}) }}
            >
              <label style={styles.label}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(task.id)}
                  style={styles.checkbox}
                />
                <span
                  style={{
                    ...styles.text,
                    ...(checked ? styles.textDone : {}),
                  }}
                >
                  {task.label}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Same card family as DigestCard/SiteStatusCard: one surface card with a
// bold-title header row; tasks are hairline-divided rows, not nested cards.
// Green marks "done" everywhere on this page (checkboxes here, ✓ in digest).
const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 2px 8px var(--shadow)",
    padding: "1rem",
    // Last card in the right column — no trailing margin, so the column's
    // true bottom (which the left file panel stretches to) is this card.
    marginBottom: 0,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "0.25rem",
  },
  title: { margin: 0, fontSize: "1.25rem", color: "var(--text)", fontWeight: 700 },
  count: { fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600 },
  countDone: { color: "#2e7d32" },
  list: { listStyle: "none", margin: 0, padding: 0 },
  item: {},
  itemDivider: { borderTop: "1px solid var(--border)" },
  label: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.7rem 0.15rem",
    cursor: "pointer",
  },
  checkbox: {
    width: "18px",
    height: "18px",
    cursor: "pointer",
    flexShrink: 0,
    accentColor: "#2e7d32",
  },
  text: { fontSize: "0.95rem", color: "var(--text)" },
  textDone: { textDecoration: "line-through", color: "var(--text-faint)" },
};
