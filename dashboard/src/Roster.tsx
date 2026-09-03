import { useEffect, useRef, useState } from "react";

// Weekly roster — the whole page is one editable sheet. Rows are positions,
// columns are Monday–Friday; every cell (role, start time, names) edits in
// place and autosaves. Tue/Thu columns carry a faint tint so the eye can
// track a row across the week, same trick as the printed sheet this replaces.

interface RosterRow {
  id: string;
  role: string;
  start: string;
  days: string[]; // Monday..Friday
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// Seed matching the sheet the team already uses — shown until the first save.
const DEFAULT_ROWS: RosterRow[] = [
  { id: "producer", role: "Producer", start: "09:00", days: ["Gabe", "Gabe", "Gabe", "Gabe", "Gabe"] },
  { id: "picker1", role: "Picker #1", start: "10:30", days: ["Adi", "Alyssa", "Adi", "Adi", "Adi"] },
  { id: "picker2", role: "Picker #2", start: "11:00", days: ["Penelope", "Lance", "", "", ""] },
  { id: "packer1", role: "Packer #1", start: "11:00", days: ["Harry", "Harry", "Harry", "Alyssa", "Alyssa"] },
  { id: "packer2", role: "Packer #2", start: "11:00", days: ["Lance", "Ryan", "Lance", "Penelope", "Penelope"] },
  { id: "content", role: "Content", start: "10:00", days: ["", "", "", "Harry", "Harry"] },
];

const SAVE_DEBOUNCE_MS = 800;

export function Roster() {
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const rowsRef = useRef<RosterRow[]>([]);
  rowsRef.current = rows;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/roster");
        const data = (await res.json()) as { rows: RosterRow[] | null; updatedAt: string | null };
        setRows(data.rows && data.rows.length ? data.rows : DEFAULT_ROWS);
        setSavedAt(data.updatedAt);
      } catch {
        setError("Could not load the roster.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaveState("saving");
    try {
      const res = await fetch("/api/roster", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: rowsRef.current }),
      });
      const data = (await res.json()) as { updatedAt?: string };
      setSavedAt(data.updatedAt ?? new Date().toISOString());
      setSaveState("saved");
    } catch {
      setSaveState("dirty");
      setError("Save failed — edits are still on screen, try changing a cell again.");
    }
  };

  const scheduleSave = () => {
    setSaveState("dirty");
    setError(null);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(save, SAVE_DEBOUNCE_MS);
  };

  const setCell = (rowId: string, patch: Partial<RosterRow>, dayIndex?: number, value?: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r;
        if (dayIndex !== undefined) {
          const days = [...r.days];
          days[dayIndex] = value ?? "";
          return { ...r, days };
        }
        return { ...r, ...patch };
      })
    );
    scheduleSave();
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "", start: "", days: ["", "", "", "", ""] },
    ]);
    scheduleSave();
  };

  const removeRow = (rowId: string) => {
    setRows((prev) => prev.filter((r) => r.id !== rowId));
    scheduleSave();
  };

  // Share as an image: draw the grid onto a canvas in a fixed light "printed
  // sheet" style (independent of the dashboard theme) and download it — ready
  // to drop straight into the group chat.
  const savePng = () => {
    const colRole = 150;
    const colStart = 100;
    const colDay = 130;
    const rowH = 44;
    const width = colRole + colStart + colDay * 5;
    const height = rowH * (rows.length + 1);
    const scale = 2; // retina-crisp in chat previews

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(scale, scale);

    const colX = (i: number) =>
      i === 0 ? 0 : i === 1 ? colRole : colRole + colStart + (i - 2) * colDay;
    const colW = (i: number) => (i === 0 ? colRole : i === 1 ? colStart : colDay);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // Tue/Thu column tint, same as the on-screen sheet
    ctx.fillStyle = "#e9e9e9";
    for (const day of [1, 3]) {
      ctx.fillRect(colX(day + 2), rowH, colDay, height - rowH);
    }

    ctx.textBaseline = "middle";
    const drawCell = (text: string, col: number, rowY: number, bold: boolean, left: boolean) => {
      if (!text) return;
      ctx.font = `${bold ? "700" : "400"} 15px -apple-system, "Segoe UI", sans-serif`;
      ctx.fillStyle = "#111111";
      ctx.textAlign = left ? "left" : "center";
      const x = left ? colX(col) + 12 : colX(col) + colW(col) / 2;
      ctx.fillText(text, x, rowY + rowH / 2, colW(col) - 16);
    };

    const headers = ["Role", "Start Time", ...DAYS];
    headers.forEach((h, i) => drawCell(h, i, 0, true, i === 0));
    rows.forEach((row, r) => {
      const y = rowH * (r + 1);
      drawCell(row.role, 0, y, true, true);
      drawCell(row.start, 1, y, true, false);
      row.days.forEach((name, d) => drawCell(name, d + 2, y, false, false));
    });

    ctx.strokeStyle = "#222222";
    ctx.lineWidth = 1;
    for (let r = 0; r <= rows.length + 1; r++) {
      ctx.strokeRect(0, 0, width, rowH * r);
    }
    for (let c = 0; c < 7; c++) {
      ctx.strokeRect(colX(c), 0, colW(c), height);
    }

    const link = document.createElement("a");
    link.download = `roster-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const saveLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "dirty"
      ? "Unsaved changes"
      : savedAt
      ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "";

  return (
    <div style={styles.container}>
      <style>{rosterCss}</style>

      <div style={styles.headRow}>
        <span style={{ ...styles.saveTag, color: saveState === "dirty" ? "#d97706" : "var(--text-faint)" }}>
          {saveLabel}
        </span>
        <button style={styles.pngBtn} onClick={savePng} disabled={loading} title="Download the roster as an image for sharing">
          Save as PNG
        </button>
      </div>

      {error && <p style={styles.error}>{error}</p>}
      {loading && <p style={styles.muted}>Loading roster…</p>}

      {!loading && (
        <div style={styles.card}>
          <table className="roster-table">
            <thead>
              <tr>
                <th className="roster-th roster-sticky">Role</th>
                <th className="roster-th" style={{ width: "90px" }}>Start</th>
                {DAYS.map((d, i) => (
                  <th key={d} className={`roster-th${i % 2 === 1 ? " roster-tint" : ""}`}>
                    {d}
                  </th>
                ))}
                <th className="roster-th" style={{ width: "34px" }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="roster-tr">
                  <td className="roster-td roster-sticky">
                    <input
                      className="roster-cell roster-role"
                      value={row.role}
                      placeholder="Role"
                      onChange={(e) => setCell(row.id, { role: e.target.value })}
                    />
                  </td>
                  <td className="roster-td">
                    <input
                      className="roster-cell roster-start"
                      value={row.start}
                      placeholder="00:00"
                      onChange={(e) => setCell(row.id, { start: e.target.value })}
                    />
                  </td>
                  {row.days.map((name, i) => (
                    <td key={i} className={`roster-td${i % 2 === 1 ? " roster-tint" : ""}`}>
                      <input
                        className="roster-cell"
                        value={name}
                        onChange={(e) => setCell(row.id, {}, i, e.target.value)}
                      />
                    </td>
                  ))}
                  <td className="roster-td roster-remove-td">
                    <button
                      className="roster-remove"
                      title={`Remove ${row.role || "row"}`}
                      onClick={() => removeRow(row.id)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button style={styles.addBtn} onClick={addRow}>
            + Add position
          </button>
        </div>
      )}
    </div>
  );
}

// The sheet needs :focus / :hover states, which inline styles can't express —
// scoped classes, injected with the component.
const rosterCss = `
.roster-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.roster-th {
  padding: 0.55rem 0.4rem; text-align: center; font-size: 0.72rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);
  border: 1px solid var(--border-strong); background: var(--surface-2);
}
.roster-th.roster-sticky { text-align: left; padding-left: 0.7rem; width: 130px; }
.roster-td { border: 1px solid var(--border); padding: 0; height: 42px; }
.roster-tint { background: color-mix(in srgb, var(--surface-2) 55%, transparent); }
.roster-tr:hover .roster-td { background: color-mix(in srgb, var(--accent) 5%, transparent); }
.roster-cell {
  width: 100%; height: 100%; border: none; background: transparent; color: var(--text);
  font-family: inherit; font-size: 0.88rem; text-align: center; padding: 0 0.4rem;
  box-sizing: border-box; outline: none;
}
.roster-cell:focus {
  outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 2px;
  background: var(--surface);
}
.roster-role { text-align: left; font-weight: 700; padding-left: 0.7rem; }
.roster-start { font-variant-numeric: tabular-nums; color: var(--text-muted); font-weight: 600; }
.roster-remove-td { border-color: transparent; text-align: center; }
.roster-remove {
  border: none; background: none; color: var(--text-faint); font-size: 1rem;
  cursor: pointer; padding: 0.2rem 0.4rem; line-height: 1; opacity: 0;
  transition: opacity 120ms;
}
.roster-tr:hover .roster-remove { opacity: 1; }
.roster-remove:hover { color: #dc2626; }
@media (prefers-reduced-motion: reduce) { .roster-remove { transition: none; } }
`;

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    background: "var(--bg)",
    color: "var(--text)",
    padding: "1.5rem",
    boxSizing: "border-box",
    maxWidth: "1150px",
    margin: "0 auto",
  },
  headRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "1rem",
    marginBottom: "0.9rem",
  },
  saveTag: { fontSize: "0.75rem", fontWeight: 600, whiteSpace: "nowrap", marginLeft: "auto" },
  pngBtn: {
    padding: "0.45rem 0.95rem",
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 700,
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "0 1px 3px var(--shadow)",
    padding: "1rem",
    overflowX: "auto",
  },
  addBtn: {
    marginTop: "0.75rem",
    padding: "0.4rem 0.9rem",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "7px",
    cursor: "pointer",
    fontSize: "0.78rem",
    color: "var(--text-muted)",
    fontFamily: "inherit",
  },
  muted: { color: "var(--text-muted)", fontSize: "0.9rem" },
  error: { fontSize: "0.85rem", color: "#dc2626", margin: "0 0 0.75rem" },
};
