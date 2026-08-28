import { useEffect, useRef, useState, type CSSProperties } from "react";

// Freeform scratchpad board under the home page columns: click to drop text
// anywhere, drag to draw red arrows, eraser to remove either. The whole board
// is serialized as JSON into the same /api/notes KV value (no schema change
// server-side), so it persists across days and devices.

interface TextItem {
  id: string;
  x: number;
  y: number;
  text: string;
}

interface ArrowItem {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

type Tool = "text" | "arrow" | "erase";
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

const ARROW_COLOR = "#d32f2f";
const MIN_ARROW_LEN = 15;

const uid = () => Math.random().toString(36).slice(2, 10);

function serialize(texts: TextItem[], arrows: ArrowItem[]): string {
  return JSON.stringify({ v: 2, texts, arrows });
}

// Older saves were a plain string from the textarea version — show them as
// one text item rather than dropping them.
function parseBoard(raw: string): { texts: TextItem[]; arrows: ArrowItem[] } {
  if (!raw) return { texts: [], arrows: [] };
  try {
    const data = JSON.parse(raw);
    if (data && data.v === 2 && Array.isArray(data.texts) && Array.isArray(data.arrows)) {
      return { texts: data.texts, arrows: data.arrows };
    }
  } catch {
    /* legacy plain-text note */
  }
  return { texts: [{ id: uid(), x: 12, y: 12, text: raw }], arrows: [] };
}

export function NotesCard() {
  const [texts, setTexts] = useState<TextItem[]>([]);
  const [arrows, setArrows] = useState<ArrowItem[]>([]);
  const [tool, setTool] = useState<Tool>("text");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftArrow, setDraftArrow] = useState<ArrowItem | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const boardRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<ArrowItem | null>(null);
  // Eat the click that lands right after closing an editor or dragging an
  // item — otherwise it would immediately drop a new text box.
  const suppressNextClick = useRef(false);
  const debounceRef = useRef<number | undefined>(undefined);
  const latestValue = useRef("");
  const lastSaved = useRef("");

  useEffect(() => {
    let closed = false;
    fetch("/api/notes")
      .then(async (r) => {
        if (r.ok && !closed) {
          const data = await r.json();
          const board = parseBoard(data.text || "");
          setTexts(board.texts);
          setArrows(board.arrows);
          const value = serialize(board.texts, board.arrows);
          latestValue.current = value;
          lastSaved.current = value;
        }
      })
      .catch(() => { /* start empty; saving still works */ })
      .finally(() => {
        if (!closed) setLoaded(true);
      });
    return () => {
      closed = true;
    };
  }, []);

  function save(value: string) {
    setSaveState("saving");
    fetch("/api/notes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: value }),
    })
      .then((r) => {
        if (r.ok) lastSaved.current = value;
        // Only report the result if nothing newer was drawn meanwhile
        if (latestValue.current === value) setSaveState(r.ok ? "saved" : "error");
      })
      .catch(() => {
        if (latestValue.current === value) setSaveState("error");
      });
  }

  // Any board mutation → debounced save
  useEffect(() => {
    if (!loaded) return;
    const value = serialize(texts, arrows);
    if (value === lastSaved.current) return;
    latestValue.current = value;
    setSaveState("dirty");
    clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => save(value), 800);
  }, [texts, arrows, loaded]);

  // Flush a pending save if the tab closes mid-debounce
  useEffect(() => {
    const flush = () => {
      if (latestValue.current !== lastSaved.current) {
        clearTimeout(debounceRef.current);
        navigator.sendBeacon?.(
          "/api/notes",
          new Blob([JSON.stringify({ text: latestValue.current })], { type: "application/json" })
        );
      }
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  // The suppress flag targets exactly one click; window sees each click after
  // the board handler (bubble order), so clearing here stops a flag set by a
  // blur/drag whose click landed elsewhere from eating a later board click.
  useEffect(() => {
    const clear = () => {
      suppressNextClick.current = false;
    };
    window.addEventListener("click", clear);
    return () => window.removeEventListener("click", clear);
  }, []);

  function updateText(id: string, patch: Partial<TextItem>) {
    setTexts((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function removeText(id: string) {
    setTexts((prev) => prev.filter((t) => t.id !== id));
    if (editingId === id) setEditingId(null);
  }

  function boardPoint(e: { clientX: number; clientY: number }) {
    const el = boardRef.current!;
    const rect = el.getBoundingClientRect();
    // rect is the border box but the SVG overlay starts inside the border —
    // subtract it or everything lands a border-width short of the pointer
    return { x: e.clientX - rect.left - el.clientLeft, y: e.clientY - rect.top - el.clientTop };
  }

  // Text creation happens on click, NOT pointerdown: the browser's default
  // mousedown behavior moves focus AFTER our handler runs, which would
  // instantly blur (and so delete) a textarea created during pointerdown.
  // By click time focus has settled, so autoFocus sticks.
  function onBoardClick(e: React.MouseEvent) {
    if (!loaded || tool !== "text" || e.target !== boardRef.current) return;
    if (suppressNextClick.current) {
      suppressNextClick.current = false;
      return;
    }
    const { x, y } = boardPoint(e);
    const id = uid();
    setTexts((prev) => [...prev, { id, x, y, text: "" }]);
    setEditingId(id);
  }

  function onBoardPointerDown(e: React.PointerEvent) {
    if (!loaded || e.target !== boardRef.current) return;
    const { x, y } = boardPoint(e);

    if (tool === "arrow") {
      const start: ArrowItem = { id: uid(), x1: x, y1: y, x2: x, y2: y };
      draftRef.current = start;
      setDraftArrow(start);
      const onMove = (ev: PointerEvent) => {
        const p = boardPoint(ev);
        const next = { ...draftRef.current!, x2: p.x, y2: p.y };
        draftRef.current = next;
        setDraftArrow(next);
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        let d = draftRef.current;
        // End on the release point itself — the last pointermove can trail
        // the pointer by several px on a fast drag, leaving the head short.
        if (d) {
          const p = boardPoint(ev);
          d = { ...d, x2: p.x, y2: p.y };
        }
        draftRef.current = null;
        setDraftArrow(null);
        if (d && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= MIN_ARROW_LEN) {
          setArrows((prev) => [...prev, d]);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }
  }

  // Click = edit, drag = move (>3px of travel switches to a drag)
  function onItemPointerDown(e: React.PointerEvent, item: TextItem) {
    e.stopPropagation();
    if (tool === "erase") {
      removeText(item.id);
      return;
    }
    if (editingId === item.id) return;
    const start = { px: e.clientX, py: e.clientY, x: item.x, y: item.y };
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (moved) {
        updateText(item.id, { x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) });
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (moved) {
        // A drag released over empty board still fires a click on the board
        suppressNextClick.current = true;
      } else if (tool === "text") {
        setEditingId(item.id);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // fromBlur: a pointer press elsewhere caused this close — that press's click
  // should only close the editor, not immediately open a new text box.
  function commitEdit(item: TextItem, fromBlur = false) {
    if (!item.text.trim()) removeText(item.id);
    setEditingId(null);
    if (fromBlur) suppressNextClick.current = true;
  }

  function clearBoard() {
    if (!confirm("Clear the whole notes board?")) return;
    setTexts([]);
    setArrows([]);
    setEditingId(null);
  }

  const statusLabel: Record<SaveState, string> = {
    idle: "",
    dirty: "…",
    saving: "Saving…",
    saved: "Saved",
    error: "Save failed — retrying on next edit",
  };

  const hint =
    tool === "text"
      ? "Click to add text · drag text to move it"
      : tool === "arrow"
        ? "Drag to draw an arrow"
        : "Click text or an arrow to erase it";

  const cursor = tool === "arrow" ? "crosshair" : tool === "erase" ? "pointer" : "default";

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>Notes</span>
        <div style={styles.tools}>
          {(["text", "arrow", "erase"] as Tool[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTool(t);
                setEditingId(null);
              }}
              style={{ ...styles.toolBtn, ...(tool === t ? styles.toolBtnActive : {}) }}
            >
              {t === "text" ? "Text" : t === "arrow" ? "Arrow" : "Eraser"}
            </button>
          ))}
          <button onClick={clearBoard} style={styles.clearBtn}>
            Clear
          </button>
        </div>
        <span style={{ ...styles.status, ...(saveState === "error" ? styles.statusError : {}) }}>
          {statusLabel[saveState] || hint}
        </span>
      </div>

      <div
        ref={boardRef}
        onPointerDown={onBoardPointerDown}
        onClick={onBoardClick}
        style={{ ...styles.board, cursor, opacity: loaded ? 1 : 0.5 }}
      >
        <svg style={styles.overlay}>
          <defs>
            {/* userSpaceOnUse: head is a fixed 11px and refX sits on the tip,
                so the point lands exactly on the line's endpoint instead of
                scaling/drifting with stroke width */}
            <marker
              id="notes-arrowhead"
              markerUnits="userSpaceOnUse"
              markerWidth="12"
              markerHeight="10"
              refX="11"
              refY="5"
              orient="auto"
            >
              <path d="M0,0 L11,5 L0,10 z" fill={ARROW_COLOR} />
            </marker>
          </defs>
          {arrows.map((a) => (
            <g
              key={a.id}
              onClick={() => tool === "erase" && setArrows((prev) => prev.filter((x) => x.id !== a.id))}
              style={{ pointerEvents: tool === "erase" ? "auto" : "none", cursor: "pointer" }}
            >
              {/* invisible fat line = comfortable eraser hit area */}
              <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="transparent" strokeWidth={14} />
              <line
                x1={a.x1}
                y1={a.y1}
                x2={a.x2}
                y2={a.y2}
                stroke={ARROW_COLOR}
                strokeWidth={2.5}
                strokeLinecap="butt"
                markerEnd="url(#notes-arrowhead)"
              />
            </g>
          ))}
          {draftArrow && (
            <line
              x1={draftArrow.x1}
              y1={draftArrow.y1}
              x2={draftArrow.x2}
              y2={draftArrow.y2}
              stroke={ARROW_COLOR}
              strokeWidth={2.5}
              strokeLinecap="butt"
              strokeDasharray="6 4"
              markerEnd="url(#notes-arrowhead)"
            />
          )}
        </svg>

        {texts.map((item) =>
          editingId === item.id ? (
            <textarea
              key={item.id}
              value={item.text}
              autoFocus
              onChange={(e) => updateText(item.id, { text: e.target.value })}
              onBlur={() => commitEdit(item, true)}
              onKeyDown={(e) => {
                if (e.key === "Escape") commitEdit(item);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              rows={Math.max(1, item.text.split("\n").length)}
              style={{ ...styles.textItem, ...styles.textEdit, left: item.x, top: item.y }}
            />
          ) : (
            <div
              key={item.id}
              onPointerDown={(e) => onItemPointerDown(e, item)}
              style={{
                ...styles.textItem,
                left: item.x,
                top: item.y,
                cursor: tool === "erase" ? "pointer" : "move",
              }}
            >
              {item.text}
            </div>
          )
        )}
      </div>
    </div>
  );
}

// Same card family as DigestCard/TodoList: surface card, bold-title header.
const styles: Record<string, CSSProperties> = {
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 2px 8px var(--shadow)",
    padding: "1rem",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "1rem",
    marginBottom: "0.5rem",
  },
  title: { margin: 0, fontSize: "1.25rem", color: "var(--text)", fontWeight: 700 },
  tools: { display: "flex", gap: "0.35rem" },
  toolBtn: {
    padding: "0.25rem 0.7rem",
    border: "1px solid var(--border)",
    borderRadius: "999px",
    background: "var(--surface)",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: "0.78rem",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  toolBtnActive: { background: "#111", borderColor: "#111", color: "#fff" },
  clearBtn: {
    padding: "0.25rem 0.7rem",
    border: "1px solid #f0c4c0",
    borderRadius: "999px",
    background: "var(--surface)",
    color: "#b3261e",
    cursor: "pointer",
    fontSize: "0.78rem",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  status: {
    marginLeft: "auto",
    fontSize: "0.78rem",
    color: "var(--text-muted)",
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  statusError: { color: "#d32f2f" },
  board: {
    position: "relative",
    height: "440px",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    background: "var(--surface)",
    overflow: "hidden",
    touchAction: "none",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
  textItem: {
    position: "absolute",
    maxWidth: "320px",
    padding: "0.15rem 0.3rem",
    fontSize: "0.9rem",
    lineHeight: 1.4,
    color: "var(--text)",
    whiteSpace: "pre-wrap",
    userSelect: "none",
  },
  textEdit: {
    minWidth: "180px",
    border: "1px dashed var(--border-strong)",
    borderRadius: "4px",
    background: "var(--surface)",
    fontFamily: "inherit",
    outline: "none",
    resize: "none",
    userSelect: "text",
  },
};
