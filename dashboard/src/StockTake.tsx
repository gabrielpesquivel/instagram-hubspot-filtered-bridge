import { useEffect, useRef, useState } from "react";

// Stock Take (v1, manual). A running list of stock items with on-hand counts:
// add what arrives, minus what ships, correct counts inline. Barcode scanning
// hooks in later — the flow is already "type a name/SKU, hit enter".

interface StockItem {
  id: string;
  name: string;
  sku?: string;
  qty: number;
  updatedAt: string;
}

export function StockTake() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/stocktake");
      const data = (await res.json()) as { startedAt: string; items: StockItem[] };
      setItems(data.items || []);
      setStartedAt(data.startedAt || null);
    } catch {
      setError("Could not load the stock list.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const addItem = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    const cleanQty = Number(qty || 0);
    if (!cleanName || !Number.isInteger(cleanQty) || cleanQty < 0) return;
    setError(null);
    const res = await fetch("/api/stocktake/item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cleanName, sku: sku.trim(), qty: cleanQty }),
    });
    if (!res.ok) {
      setError("Could not save the item.");
      return;
    }
    setName("");
    setSku("");
    setQty("");
    nameRef.current?.focus();
    await load();
  };

  const adjust = async (id: string, delta: number) => {
    // Optimistic bump so rapid +/- clicks feel instant; reconcile after.
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, qty: Math.max(0, i.qty + delta) } : i)));
    await fetch("/api/stocktake/adjust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, delta }),
    });
    await load();
  };

  const setCount = async (id: string, value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) return;
    await fetch("/api/stocktake/adjust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, qty: n }),
    });
    await load();
  };

  const remove = async (id: string, itemName: string) => {
    if (!window.confirm(`Remove "${itemName}" from the stock list?`)) return;
    await fetch("/api/stocktake/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await load();
  };

  const reset = async () => {
    if (!window.confirm("Clear the entire stock list and start a fresh take? This cannot be undone.")) return;
    await fetch("/api/stocktake/reset", { method: "POST" });
    await load();
  };

  const totalUnits = items.reduce((s, i) => s + i.qty, 0);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <p style={styles.sub}>
          Running on-hand counts — add stock as it arrives, minus it as it ships. Barcode
          scanning comes later.
        </p>
        <div style={styles.headerRight}>
          {startedAt && (
            <span style={styles.startedAt}>Started {new Date(startedAt).toLocaleDateString()}</span>
          )}
          <button style={styles.resetBtn} onClick={reset}>
            Start fresh take
          </button>
        </div>
      </header>

      {/* Entry row: name → sku → qty → enter, focus returns to name */}
      <form style={styles.addForm} onSubmit={addItem}>
        <input
          ref={nameRef}
          style={{ ...styles.input, flex: 2 }}
          placeholder="Item name (e.g. Wales flag transfer)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          style={{ ...styles.input, flex: 1 }}
          placeholder="SKU (optional)"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
        />
        <input
          style={{ ...styles.input, width: "110px", flex: "none" }}
          placeholder="Qty"
          type="number"
          min={0}
          step={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          required
        />
        <button type="submit" style={styles.addBtn}>
          Add stock
        </button>
      </form>
      <p style={styles.hint}>
        Adding a name that already exists updates that item's count instead of duplicating it.
      </p>
      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.card}>
        {loading && <p style={styles.muted}>Loading stock…</p>}
        {!loading && items.length === 0 && (
          <p style={styles.muted}>No stock recorded yet — add your first item above.</p>
        )}
        {items.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Item</th>
                <th style={styles.th}>SKU</th>
                <th style={{ ...styles.th, textAlign: "center" }}>On hand</th>
                <th style={styles.th}>Last updated</th>
                <th style={styles.th} />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td style={{ ...styles.td, fontWeight: 600 }}>{item.name}</td>
                  <td style={{ ...styles.td, color: "var(--text-muted)" }}>{item.sku || "—"}</td>
                  <td style={{ ...styles.td, textAlign: "center" }}>
                    <div style={styles.stepper}>
                      <button style={styles.stepBtn} onClick={() => adjust(item.id, -1)} aria-label={`Minus one ${item.name}`}>
                        −
                      </button>
                      <input
                        style={styles.qtyInput}
                        type="number"
                        min={0}
                        step={1}
                        value={item.qty}
                        onChange={(e) =>
                          setItems((prev) =>
                            prev.map((i) => (i.id === item.id ? { ...i, qty: Number(e.target.value) || 0 } : i))
                          )
                        }
                        onBlur={(e) => setCount(item.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                      />
                      <button style={styles.stepBtn} onClick={() => adjust(item.id, 1)} aria-label={`Plus one ${item.name}`}>
                        +
                      </button>
                    </div>
                  </td>
                  <td style={{ ...styles.td, color: "var(--text-faint)", fontSize: "0.78rem" }}>
                    {new Date(item.updatedAt).toLocaleString()}
                  </td>
                  <td style={{ ...styles.td, textAlign: "right" }}>
                    <button style={styles.removeBtn} onClick={() => remove(item.id, item.name)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={styles.totalCell}>
                  {items.length} {items.length === 1 ? "item" : "items"}
                </td>
                <td style={styles.totalCell} />
                <td style={{ ...styles.totalCell, textAlign: "center" }}>{totalUnits} units</td>
                <td style={styles.totalCell} />
                <td style={styles.totalCell} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: "var(--bg)",
    color: "var(--text)",
    padding: "1.5rem",
    boxSizing: "border-box",
    maxWidth: "1000px",
    margin: "0 auto",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "1rem",
    flexWrap: "wrap",
    marginBottom: "1.25rem",
    paddingBottom: "1rem",
    borderBottom: "1px solid var(--border)",
  },
  sub: { margin: 0, fontSize: "0.85rem", color: "var(--text-muted)", maxWidth: "520px", alignSelf: "center" },
  headerRight: { display: "flex", alignItems: "center", gap: "0.75rem" },
  startedAt: { fontSize: "0.75rem", color: "var(--text-faint)" },
  resetBtn: {
    padding: "0.45rem 0.9rem",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "var(--text-muted)",
    fontFamily: "inherit",
  },
  addForm: { display: "flex", gap: "0.6rem", flexWrap: "wrap" },
  input: {
    padding: "0.55rem 0.75rem",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    fontSize: "0.9rem",
    color: "var(--text)",
    fontFamily: "inherit",
    minWidth: "140px",
    boxSizing: "border-box",
  },
  addBtn: {
    padding: "0.55rem 1.2rem",
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "0.9rem",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  hint: { fontSize: "0.75rem", color: "var(--text-faint)", margin: "0.5rem 0 1rem" },
  error: { fontSize: "0.85rem", color: "#dc2626", margin: "0 0 0.75rem" },
  muted: { color: "var(--text-muted)", fontSize: "0.9rem", margin: 0 },
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "0 1px 3px var(--shadow)",
    padding: "1rem 1.15rem",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.88rem" },
  th: {
    textAlign: "left",
    padding: "0.4rem 0.6rem",
    borderBottom: "1px solid var(--border-strong)",
    color: "var(--text-muted)",
    fontSize: "0.75rem",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  td: { padding: "0.45rem 0.6rem", borderBottom: "1px solid var(--border)", verticalAlign: "middle" },
  stepper: { display: "inline-flex", alignItems: "center", gap: "0.35rem" },
  stepBtn: {
    width: "26px",
    height: "26px",
    borderRadius: "6px",
    border: "1px solid var(--border-strong)",
    background: "var(--surface-2)",
    color: "var(--text)",
    cursor: "pointer",
    fontSize: "1rem",
    lineHeight: 1,
    fontFamily: "inherit",
  },
  qtyInput: {
    width: "64px",
    textAlign: "center",
    padding: "0.3rem 0.2rem",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    fontSize: "0.9rem",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  removeBtn: {
    padding: "0.3rem 0.7rem",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    cursor: "pointer",
    fontSize: "0.75rem",
    color: "var(--text-muted)",
    fontFamily: "inherit",
  },
  totalCell: {
    padding: "0.55rem 0.6rem",
    fontWeight: 700,
    fontSize: "0.85rem",
    color: "var(--text-muted)",
  },
};
