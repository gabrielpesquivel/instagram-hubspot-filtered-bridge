import { useEffect, useState } from "react";

// Fixed daily checklist. Tick state is stored per calendar day in localStorage,
// so it naturally resets each new day.
const TASKS = [
  { id: "gangsheet", label: "Generate gangsheet" },
  { id: "dms", label: "Answer Instagram DMs" },
  { id: "emails", label: "Answer emails" },
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
    <div>
      <div style={styles.headerRow}>
        <h2 style={styles.title}>Today's To-Do</h2>
        <span style={styles.count}>
          {completed}/{TASKS.length}
        </span>
      </div>
      <p style={styles.sub}>Your checklist for the day</p>

      <ul style={styles.list}>
        {TASKS.map((task) => {
          const checked = !!done[task.id];
          return (
            <li key={task.id} style={styles.item}>
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

const styles: Record<string, React.CSSProperties> = {
  headerRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    margin: "0 0 0.25rem",
  },
  title: { margin: 0, fontSize: "1.25rem", color: "var(--text)" },
  count: { fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600 },
  sub: { margin: "0 0 1rem", fontSize: "0.85rem", color: "var(--text-muted)" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" },
  item: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 2px 8px var(--shadow)",
  },
  label: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.85rem 1rem",
    cursor: "pointer",
  },
  checkbox: { width: "18px", height: "18px", cursor: "pointer", flexShrink: 0 },
  text: { fontSize: "0.95rem", color: "var(--text)" },
  textDone: { textDecoration: "line-through", color: "var(--text-faint)" },
};
