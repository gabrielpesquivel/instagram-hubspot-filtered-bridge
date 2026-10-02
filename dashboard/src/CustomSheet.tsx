import { useEffect, useMemo, useState, type CSSProperties } from "react";

// "+ Custom sheet" builder on the Gangsheet page: hand-built extra sheets for
// missed items, reprints and one-offs. Entries map 1:1 onto
// collect_items_from_manual() in the generator's main.py.

export interface Design {
  path: string; // relative to the bundle's assets/, e.g. "flags/europe/GERMANY.svg"
  name: string;
  group: string;
  kind: "flag" | "symbol";
}

type Color = "BLACK" | "WHITE";

export type Entry =
  | { id: number; kind: "kit"; color: Color; initials: [string, string]; numbers: [string, string]; flags: [string, string]; qty: number; order: string }
  | { id: number; kind: "design"; path: string; qty: number; order: string }
  | { id: number; kind: "text"; text: string; heightMm: string; color: string; qty: number; order: string };

// Drafts used to persist in localStorage under this key; the builder now
// starts empty every time (and clears after each generate). Drop any old draft.
try {
  localStorage.removeItem("gangsheet.customSheet.draft");
} catch { /* ignore */ }

let nextEntryId = Date.now();

function newEntry(kind: Entry["kind"]): Entry {
  const id = nextEntryId++;
  if (kind === "kit") return { id, kind, color: "BLACK", initials: ["", ""], numbers: ["", ""], flags: ["", ""], qty: 1, order: "" };
  if (kind === "design") return { id, kind, path: "", qty: 1, order: "" };
  return { id, kind, text: "", heightMm: "", color: "BLACK", qty: 1, order: "" };
}

const designLabel = (d: Design) =>
  `${d.name} · ${d.group}${d.kind === "flag" ? " flag" : ""}`;

function hasContent(e: Entry): boolean {
  if (e.kind === "kit") return [...e.initials, ...e.numbers, ...e.flags].some((v) => v.trim());
  if (e.kind === "design") return !!e.path;
  return !!e.text.trim();
}

/** Entries as main.collect_items_from_manual expects them. */
function toSpec(entries: Entry[]) {
  return entries.filter(hasContent).map((e) => {
    const common = { qty: e.qty, order: e.order.trim() };
    if (e.kind === "kit")
      return { ...common, kind: e.kind, color: e.color, initials: e.initials, numbers: e.numbers, flags: e.flags };
    if (e.kind === "design") return { ...common, kind: e.kind, path: e.path };
    return { ...common, kind: e.kind, text: e.text, height_mm: e.heightMm, color: e.color };
  });
}

function defaultSheetName() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `custom-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function CustomSheet(props: {
  ready: boolean;
  designs: Design[] | null;
  previews: Record<string, string>;
  requestPreview: (path: string) => void;
  onGenerate: (name: string, spec: string, label: string) => void;
}) {
  const { ready, designs, previews, requestPreview, onGenerate } = props;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  const [sheetName, setSheetName] = useState(defaultSheetName);

  const byLabel = useMemo(() => {
    const m = new Map<string, Design>();
    for (const d of designs ?? []) m.set(designLabel(d), d);
    return m;
  }, [designs]);
  const byPath = useMemo(() => new Map((designs ?? []).map((d) => [d.path, d])), [designs]);
  const flagNames = useMemo(
    () => [...new Set((designs ?? []).filter((d) => d.kind === "flag").map((d) => d.name))].sort(),
    [designs],
  );

  function update(id: number, patch: Partial<Entry>) {
    setEntries((prev) => prev.map((e) => (e.id === id ? ({ ...e, ...patch } as Entry) : e)));
  }
  const remove = (id: number) => setEntries((prev) => prev.filter((e) => e.id !== id));
  const add = (kind: Entry["kind"]) => setEntries((prev) => [...prev, newEntry(kind)]);

  const spec = toSpec(entries);
  const stickerCount = spec.reduce((n, e) => n + (e.qty || 1) * (e.kind === "kit"
    ? [...e.initials, ...e.numbers, ...e.flags].filter((v) => v.trim()).length : 1), 0);

  function generate() {
    if (!spec.length) return;
    const name = sheetName.trim() || defaultSheetName();
    onGenerate(name, JSON.stringify(spec), `Custom sheet — ${stickerCount} sticker${stickerCount === 1 ? "" : "s"}`);
    // Fresh builder for the next sheet — nothing carries over.
    setEntries([]);
    setSheetName(defaultSheetName());
  }

  if (!open) {
    return (
      <div style={s.row}>
        <div style={{ flex: 1 }}>
          <div style={s.title}>Custom sheet</div>
          <div style={s.muted}>Missed items, reprints or one-offs — starter kits, any design, or free text.</div>
        </div>
        <button style={s.primaryBtn} onClick={() => { setOpen(true); if (!entries.length) add("kit"); }}>
          + Custom sheet
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...s.row, flexDirection: "column", alignItems: "stretch", gap: "0.75rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <div style={{ ...s.title, flex: 1 }}>Custom sheet</div>
        <label style={s.field}>
          <span style={s.label}>File name</span>
          <input style={{ ...s.input, width: "14rem" }} value={sheetName} onChange={(e) => setSheetName(e.target.value)} />
        </label>
        <button style={s.iconBtn} title="Hide" onClick={() => setOpen(false)}>–</button>
      </div>

      <datalist id="cs-flags">{flagNames.map((n) => <option key={n} value={n} />)}</datalist>
      <datalist id="cs-designs">{[...byLabel.keys()].map((l) => <option key={l} value={l} />)}</datalist>

      {entries.map((e) => (
        <div key={e.id} style={s.card}>
          <div style={s.cardHead}>
            <span style={s.kindTag}>{e.kind === "kit" ? "Starter kit" : e.kind === "design" ? "Design" : "Text"}</span>
            <label style={s.field}>
              <span style={s.label}>Qty</span>
              <input
                type="number" min={1} style={{ ...s.input, width: "4rem" }} value={e.qty}
                onChange={(ev) => update(e.id, { qty: Math.max(1, Number(ev.target.value) || 1) })}
              />
            </label>
            <label style={s.field} title="Optional — shows as #order in the sheet header and keeps these together">
              <span style={s.label}>Order #</span>
              <input style={{ ...s.input, width: "6rem" }} placeholder="optional" value={e.order}
                onChange={(ev) => update(e.id, { order: ev.target.value })} />
            </label>
            <span style={{ flex: 1 }} />
            <button style={s.iconBtn} title="Remove" onClick={() => remove(e.id)}>✕</button>
          </div>

          {e.kind === "kit" && (
            <div style={s.grid}>
              <ColorToggle value={e.color} onChange={(color) => update(e.id, { color })} />
              {(["initials", "numbers", "flags"] as const).map((key) =>
                [0, 1].map((i) => (
                  <label key={`${key}${i}`} style={s.field}>
                    <span style={s.label}>{key === "initials" ? "Initials" : key === "numbers" ? "Number" : "Flag"} {i + 1}</span>
                    <input
                      style={{ ...s.input, width: key === "flags" ? "9rem" : "4.5rem" }}
                      list={key === "flags" ? "cs-flags" : undefined}
                      value={e[key][i]}
                      onChange={(ev) => {
                        const next = [...e[key]] as [string, string];
                        next[i] = key === "flags" ? ev.target.value : ev.target.value.toUpperCase();
                        update(e.id, { [key]: next } as Partial<Entry>);
                      }}
                    />
                  </label>
                )),
              )}
            </div>
          )}

          {e.kind === "design" && (
            <DesignPicker
              design={byPath.get(e.path)}
              byLabel={byLabel}
              loading={!designs}
              preview={e.path ? previews[e.path] : undefined}
              onPick={(d) => { update(e.id, { path: d?.path ?? "" }); if (d) requestPreview(d.path); }}
              requestPreview={requestPreview}
            />
          )}

          {e.kind === "text" && <TextFields entry={e} update={(p) => update(e.id, p)} />}
        </div>
      ))}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <button style={s.addBtn} onClick={() => add("kit")}>+ Starter kit</button>
        <button style={s.addBtn} onClick={() => add("design")}>+ Design</button>
        <button style={s.addBtn} onClick={() => add("text")}>+ Text</button>
        <span style={{ flex: 1 }} />
        {entries.length > 0 && (
          <button style={s.addBtn} onClick={() => setEntries([])}>Clear all</button>
        )}
        <button
          style={{ ...s.primaryBtn, opacity: ready && spec.length ? 1 : 0.5 }}
          disabled={!ready || !spec.length}
          onClick={generate}
        >
          Generate sheet{stickerCount ? ` (${stickerCount})` : ""}
        </button>
      </div>
    </div>
  );
}

function ColorToggle({ value, onChange }: { value: Color; onChange: (c: Color) => void }) {
  return (
    <div style={{ display: "flex", gap: 0 }}>
      {(["BLACK", "WHITE"] as const).map((c, i) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          style={{
            ...s.segBtn,
            borderRadius: i === 0 ? "6px 0 0 6px" : "0 6px 6px 0",
            ...(value === c ? s.segActive : {}),
          }}
        >
          {c === "BLACK" ? "Black" : "White"}
        </button>
      ))}
    </div>
  );
}

function DesignPicker(props: {
  design: Design | undefined;
  byLabel: Map<string, Design>;
  loading: boolean;
  preview: string | undefined;
  onPick: (d: Design | undefined) => void;
  requestPreview: (path: string) => void;
}) {
  const { design, byLabel, loading, preview, onPick, requestPreview } = props;
  const [query, setQuery] = useState(design ? designLabel(design) : "");

  // Keep the label in sync with the picked design and fetch its preview.
  useEffect(() => {
    if (design) {
      setQuery(designLabel(design));
      requestPreview(design.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design?.path]);

  const unmatched = query.trim() !== "" && !byLabel.has(query);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
      <div style={s.thumb}>
        {preview ? <img src={preview} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} /> : null}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <input
          style={{ ...s.input, width: "100%", boxSizing: "border-box" }}
          list="cs-designs"
          placeholder={loading ? "Loading designs…" : "Search flags & symbols (e.g. germany, cobra white)"}
          value={query}
          onChange={(ev) => {
            setQuery(ev.target.value);
            onPick(byLabel.get(ev.target.value));
          }}
        />
        {unmatched && <span style={{ ...s.muted, color: "#d32f2f" }}>Pick a design from the list</span>}
      </div>
    </div>
  );
}

function TextFields({ entry, update }: { entry: Extract<Entry, { kind: "text" }>; update: (p: Partial<Entry>) => void }) {
  const isHex = entry.color.startsWith("#");
  const hexValid = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(entry.color);
  const swatch = entry.color === "WHITE" ? "#ffffff" : entry.color === "BLACK" ? "#111111" : hexValid ? entry.color : "#999";
  return (
    <div style={s.grid}>
      <label style={{ ...s.field, flex: "1 1 14rem" }}>
        <span style={s.label}>Text</span>
        <input style={{ ...s.input, flex: 1, fontWeight: 700 }} placeholder="GABE" value={entry.text}
          onChange={(ev) => update({ text: ev.target.value })} />
      </label>
      <label style={s.field} title="Cap height. Blank = standard product sizing (4mm words / initials)">
        <span style={s.label}>Height</span>
        <input type="number" min={1} step={0.5} style={{ ...s.input, width: "4.5rem" }} placeholder="auto"
          value={entry.heightMm} onChange={(ev) => update({ heightMm: ev.target.value })} />
        <span style={s.label}>mm</span>
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
        <select
          style={s.input}
          value={isHex ? "HEX" : entry.color}
          onChange={(ev) => update({ color: ev.target.value === "HEX" ? "#E53935" : ev.target.value })}
        >
          <option value="BLACK">Black</option>
          <option value="WHITE">White</option>
          <option value="HEX">Custom colour</option>
        </select>
        {isHex && (
          <>
            <input type="color" value={hexValid && entry.color.length === 7 ? entry.color : "#000000"}
              onChange={(ev) => update({ color: ev.target.value.toUpperCase() })}
              style={{ width: 32, height: 28, padding: 0, border: "none", background: "none" }} />
            <input style={{ ...s.input, width: "6rem", borderColor: hexValid ? undefined : "#d32f2f" }}
              value={entry.color} onChange={(ev) => update({ color: ev.target.value })} />
          </>
        )}
      </div>
      {entry.text.trim() && (
        <span style={{
          ...s.textPreview,
          color: swatch,
          background: entry.color === "WHITE" ? "#333" : "transparent",
        }}>
          {entry.text}
        </span>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.85rem 1rem",
    borderBottom: "1px solid #f0f0f0",
  },
  title: { fontSize: "0.95rem", fontWeight: 600, color: "var(--text)" },
  muted: { fontSize: "0.8rem", color: "var(--text-muted)" },
  label: { fontSize: "0.8rem", color: "var(--text-muted)", whiteSpace: "nowrap" },
  field: { display: "flex", alignItems: "center", gap: "0.4rem" },
  input: {
    padding: "0.3rem 0.45rem",
    borderRadius: 4,
    border: "1px solid var(--border, #ccc)",
    background: "var(--bg, #fff)",
    color: "inherit",
    fontSize: "0.85rem",
  },
  card: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "0.6rem 0.75rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.6rem",
  },
  cardHead: { display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" },
  kindTag: {
    fontSize: "0.75rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--text-muted)",
    minWidth: "6rem",
  },
  grid: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem 1rem" },
  thumb: {
    width: 56,
    height: 40,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px dashed var(--border)",
    borderRadius: 6,
    background: "repeating-conic-gradient(#8881 0% 25%, transparent 0% 50%) 50% / 10px 10px",
    padding: 3,
    boxSizing: "border-box",
  },
  textPreview: {
    fontWeight: 900,
    fontSize: "1.1rem",
    letterSpacing: "0.02em",
    padding: "0 0.4rem",
    borderRadius: 4,
    maxWidth: "12rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  segBtn: {
    padding: "0.3rem 0.8rem",
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
  segActive: { background: "#2e7d32", borderColor: "#2e7d32", color: "#fff" },
  addBtn: {
    padding: "0.4rem 0.8rem",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "none",
    color: "var(--text)",
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  primaryBtn: {
    padding: "0.45rem 0.9rem",
    borderRadius: 6,
    border: "1px solid #2e7d32",
    background: "#2e7d32",
    color: "#fff",
    cursor: "pointer",
    fontSize: "0.85rem",
    whiteSpace: "nowrap",
  },
  iconBtn: {
    flexShrink: 0,
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: "50%",
    cursor: "pointer",
    fontSize: "0.75rem",
    color: "var(--text-faint)",
    lineHeight: 1,
  },
};
