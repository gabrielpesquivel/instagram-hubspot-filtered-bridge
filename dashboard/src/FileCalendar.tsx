import { useEffect, useRef, useState, useCallback } from "react";

interface FileEntry {
  key: string;
  name: string;
  size: number;
  uploaded: string;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// Local-time YYYY-MM-DD (avoids UTC off-by-one from toISOString)
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Monday of the week containing `d`
function mondayOf(d: Date): Date {
  const out = new Date(d);
  const dow = (out.getDay() + 6) % 7; // 0 = Monday
  out.setDate(out.getDate() - dow);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function weekLabel(monday: Date): string {
  const friday = addDays(monday, 4);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${monday.toLocaleDateString(undefined, opts)} – ${friday.toLocaleDateString(undefined, opts)}`;
}

export function FileCalendar() {
  const today = new Date();
  const [weekStart, setWeekStart] = useState<Date>(() => mondayOf(today));
  const [selected, setSelected] = useState<string>(() => {
    // Weekends aren't shown — fall back to that week's Friday
    const dow = (today.getDay() + 6) % 7; // 0 = Monday
    return ymd(dow > 4 ? addDays(mondayOf(today), 4) : today);
  });
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);

  const days = DAY_NAMES.map((_, i) => addDays(weekStart, i));
  const todayStr = ymd(today);

  const loadFiles = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/files?date=${date}`);
      if (!res.ok) throw new Error("Failed to load files");
      const data = await res.json();
      setFiles(data.files || []);
    } catch {
      setError("Could not load files");
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFiles(selected);
  }, [selected, loadFiles]);

  const uploadOne = async (file: File, name: string) => {
    const res = await fetch(
      `/api/files?date=${selected}&name=${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Upload failed");
    }
  };

  const onUploadPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (!picked.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of picked) await uploadOne(f, f.name);
      await loadFiles(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const onReplacePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    const target = replaceTarget.current;
    e.target.value = "";
    replaceTarget.current = null;
    if (!f || !target) return;
    setBusy(true);
    setError(null);
    try {
      await uploadOne(f, target); // same name overwrites
      await loadFiles(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replace failed");
    } finally {
      setBusy(false);
    }
  };

  const triggerReplace = (name: string) => {
    replaceTarget.current = name;
    replaceInput.current?.click();
  };

  const remove = async (file: FileEntry) => {
    if (!confirm(`Delete "${file.name}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/files?key=${encodeURIComponent(file.key)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      await loadFiles(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.wrap}>
      {/* Week nav + day boxes grouped as one block: on the home page grid this
          is the row shared with the digest card, so their bottoms align. */}
      <div style={styles.top}>
      <div style={styles.header}>
        <button
          style={styles.navBtn}
          onClick={() => setWeekStart(addDays(weekStart, -7))}
          aria-label="Previous week"
        >
          ‹
        </button>
        <div style={styles.weekLabel}>{weekLabel(weekStart)}</div>
        <button
          style={styles.navBtn}
          onClick={() => setWeekStart(addDays(weekStart, 7))}
          aria-label="Next week"
        >
          ›
        </button>
        <button style={styles.todayBtn} onClick={() => setWeekStart(mondayOf(new Date()))}>
          This week
        </button>
      </div>

      <div style={styles.daysRow}>
        {days.map((d, i) => {
          const ds = ymd(d);
          const isSel = ds === selected;
          const isToday = ds === todayStr;
          return (
            <button
              key={ds}
              onClick={() => setSelected(ds)}
              style={{
                ...styles.day,
                ...(isSel ? styles.daySel : {}),
                ...(isToday && !isSel ? styles.dayToday : {}),
              }}
            >
              <span style={styles.dayName}>{DAY_NAMES[i]}</span>
              <span style={styles.dayNum}>{d.getDate()}</span>
            </button>
          );
        })}
      </div>
      </div>

      <div style={styles.panel}>
        <div style={styles.panelHead}>
          <span style={styles.panelTitle}>
            Gangsheets —{" "}
            {new Date(selected + "T00:00:00").toLocaleDateString(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </span>
          <button
            style={styles.uploadBtn}
            disabled={busy}
            onClick={() => uploadInput.current?.click()}
          >
            {busy ? "Working…" : "+ Upload"}
          </button>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        {loading ? (
          <div style={styles.empty}>Loading…</div>
        ) : files.length === 0 ? (
          <div style={styles.empty}>No files for this day yet.</div>
        ) : (
          <ul style={styles.list}>
            {files.map((f) => (
              <li key={f.key} style={styles.item}>
                <a
                  href={`/api/files/get?key=${encodeURIComponent(f.key)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={styles.fileName}
                >
                  {f.name}
                </a>
                <span style={styles.fileMeta}>{formatSize(f.size)}</span>
                <button style={styles.smallBtn} disabled={busy} onClick={() => triggerReplace(f.name)}>
                  Replace
                </button>
                <button
                  style={{ ...styles.smallBtn, ...styles.delBtn }}
                  disabled={busy}
                  onClick={() => remove(f)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <input
        ref={uploadInput}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={onUploadPick}
      />
      <input
        ref={replaceInput}
        type="file"
        style={{ display: "none" }}
        onChange={onReplacePick}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // `contents` dissolves the wrapper so `top` and `panel` land in the parent
  // grid's shared rows (aligned with the digest card / to-do list).
  wrap: { display: "contents" },
  top: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "1rem",
    minHeight: 0,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  navBtn: {
    width: "32px",
    height: "32px",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--surface)",
    cursor: "pointer",
    fontSize: "1.1rem",
    lineHeight: 1,
    color: "var(--text)",
  },
  weekLabel: { flex: 1, textAlign: "center" as const, fontWeight: 600, color: "var(--text)" },
  todayBtn: {
    padding: "0.35rem 0.7rem",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--surface)",
    cursor: "pointer",
    fontSize: "0.78rem",
    color: "var(--text-muted)",
  },
  daysRow: {
    display: "grid",
    gridTemplateColumns: "repeat(5, 1fr)",
    gap: "0.5rem",
    // Absorb any extra row height (if the digest card is taller) so the day
    // boxes' bottom edge stays flush with the digest card's bottom.
    flex: 1,
  },
  day: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "0.2rem",
    padding: "0.6rem 0",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    background: "var(--surface)",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  daySel: { background: "#111", borderColor: "#111", color: "#fff" },
  dayToday: { borderColor: "#111" },
  dayName: { fontSize: "0.72rem", textTransform: "uppercase" as const, opacity: 0.8 },
  dayNum: { fontSize: "1.2rem", fontWeight: 700 },
  panel: {
    border: "1px solid var(--border)",
    borderRadius: "10px",
    background: "var(--surface)",
    padding: "1rem",
    // Shares the grid's last row with the to-do card, so their bottoms match;
    // long file lists scroll instead of growing.
    minHeight: "120px",
    overflowY: "auto" as const,
  },
  panelHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "0.75rem",
    gap: "0.5rem",
  },
  panelTitle: { fontWeight: 600, color: "var(--text)", fontSize: "0.95rem" },
  uploadBtn: {
    padding: "0.4rem 0.9rem",
    border: "none",
    borderRadius: "6px",
    background: "#111",
    color: "#fff",
    cursor: "pointer",
    fontSize: "0.82rem",
    fontWeight: 600,
  },
  error: {
    background: "#fdecea",
    color: "#b3261e",
    padding: "0.5rem 0.75rem",
    borderRadius: "6px",
    fontSize: "0.82rem",
    marginBottom: "0.75rem",
  },
  empty: { color: "var(--text-faint)", fontSize: "0.88rem", padding: "1.5rem 0", textAlign: "center" as const },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" as const, gap: "0.4rem" },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    padding: "0.5rem 0.6rem",
    border: "1px solid #eee",
    borderRadius: "6px",
  },
  fileName: { flex: 1, color: "#1558d6", textDecoration: "none", fontSize: "0.88rem", wordBreak: "break-all" as const },
  fileMeta: { fontSize: "0.75rem", color: "var(--text-faint)", whiteSpace: "nowrap" as const },
  smallBtn: {
    padding: "0.3rem 0.6rem",
    border: "1px solid var(--border)",
    borderRadius: "5px",
    background: "var(--surface)",
    cursor: "pointer",
    fontSize: "0.75rem",
    color: "var(--text-muted)",
  },
  delBtn: { color: "#b3261e", borderColor: "#f0c4c0" },
};
