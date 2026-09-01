import { useEffect, useRef, useState } from "react";

// Stock View. Print-on-demand means stock is consumables only — a fixed
// catalog (ink, film, bags, wipes, boxes, sleeves, labels). Weekly order
// volume from Shopify drives a runout projection per item, compared against
// its lead time: "order now" means the runout date is inside the lead time.
// The scan box is wired for the USB barcode scanner: first scan of a new
// barcode assigns it to an item with a pack size; every scan after that
// registers stock automatically.

type ItemStatus =
  | "uncounted"
  | "no-rate"
  | "ok"
  | "order-soon"
  | "order-now"
  | "on-order"
  | "order-overdue";

interface OnOrder {
  placedAt: string;
  eta: string | null;
  qty: number | null;
}

interface Item {
  id: string;
  name: string;
  unit: string;
  usage: "perOrder" | "perUnit" | "wipes";
  qty: number | null;
  countedAt: string | null;
  effectiveQty: number | null;
  leadTimeDays: number | null;
  usagePerUnit: number | null;
  barcode: string | null;
  packSize: number;
  onOrder: OnOrder | null;
  weeklyUse: number | null;
  weeklyUse28: number | null;
  weeklyUse7: number | null;
  spike: boolean;
  daysLeft: number | null;
  runoutDate: string | null;
  status: ItemStatus;
}

interface Stats {
  days: number;
  orders: number;
  units: number;
  wipes: number;
}

interface Demand {
  unitsWk28: number;
  unitsWk7: number;
  spikePct: number;
}

const STATUS_LABEL: Record<ItemStatus, string> = {
  uncounted: "Awaiting count",
  "no-rate": "Set usage rate",
  ok: "OK",
  "order-soon": "Order soon",
  "order-now": "ORDER NOW",
  "on-order": "On order",
  "order-overdue": "ORDER OVERDUE",
};

const STATUS_COLOR: Record<ItemStatus, string> = {
  uncounted: "var(--text-faint)",
  "no-rate": "var(--text-faint)",
  ok: "#16a34a",
  "order-soon": "#d97706",
  "order-now": "#dc2626",
  "on-order": "var(--accent)",
  "order-overdue": "#dc2626",
};

const USAGE_DESC: Record<Item["usage"], string> = {
  perOrder: "1 per order",
  perUnit: "per unit (set rate)",
  wipes: "½ per unit, rounded up per order",
};

function fmtWeekly(n: number | null): string {
  if (n == null) return "—";
  return n >= 10 ? String(Math.round(n)) : n.toFixed(1);
}

function fmtRunout(item: Item): string {
  if (item.daysLeft == null || !item.runoutDate) return "—";
  const days = Math.floor(item.daysLeft);
  return `${new Date(item.runoutDate).toLocaleDateString()} (${days}d)`;
}

export function StockTake() {
  const [items, setItems] = useState<Item[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [demand, setDemand] = useState<Demand | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scanCode, setScanCode] = useState("");
  const [assigning, setAssigning] = useState<string | null>(null); // unknown barcode awaiting assignment
  const [assignItem, setAssignItem] = useState("");
  const [assignPack, setAssignPack] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/stocktake");
      const data = (await res.json()) as { items: Item[]; stats: Stats | null; demand: Demand | null };
      setItems(data.items || []);
      setStats(data.stats);
      setDemand(data.demand);
    } catch {
      setError("Could not load stock data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // USB scanners type the code and press Enter — this is the whole intake flow.
  const scan = async (code: string) => {
    const clean = code.trim();
    if (!clean) return;
    setScanCode("");
    const res = await fetch("/api/stocktake/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: clean }),
    });
    const data = (await res.json()) as { matched?: boolean; item?: { name: string; added: number; unit: string } };
    if (data.matched && data.item) {
      setScanMsg(`+${data.item.added} ${data.item.unit} — ${data.item.name}`);
      setAssigning(null);
      await load();
    } else {
      // New barcode: ask which item it belongs to and how many units per pack.
      setAssigning(clean);
      setAssignItem("");
      setAssignPack("");
      setScanMsg(null);
    }
    scanRef.current?.focus();
  };

  const saveAssignment = async () => {
    if (!assigning || !assignItem) return;
    const pack = Math.max(1, Math.round(Number(assignPack) || 1));
    await fetch("/api/stocktake/item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: assignItem, barcode: assigning, packSize: pack }),
    });
    const code = assigning;
    setAssigning(null);
    await scan(code); // apply the original scan now that the barcode is known
  };

  const updateField = async (id: string, field: string, raw: string) => {
    const value = raw.trim() === "" ? null : Number(raw);
    if (value !== null && !Number.isFinite(value)) return;
    await fetch("/api/stocktake/item", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, [field]: value }),
    });
    await load();
  };

  const receive = async (id: string, name: string) => {
    const raw = window.prompt(`How many arrived for "${name}"? (negative to correct)`);
    if (raw == null) return;
    const qty = Math.round(Number(raw));
    if (!qty) return;
    await fetch("/api/stocktake/receive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, qty }),
    });
    await load();
  };

  const markOrdered = async (id: string, name: string) => {
    const eta = window.prompt(`Marking "${name}" as ordered. Expected arrival date? (YYYY-MM-DD, blank if unknown)`);
    if (eta === null) return;
    const qtyRaw = window.prompt("How many units are coming? (blank if unknown)");
    await fetch("/api/stocktake/ordered", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, eta: eta.trim(), qty: qtyRaw ? Math.round(Number(qtyRaw)) : null }),
    });
    await load();
  };

  const cancelOrdered = async (id: string) => {
    await fetch("/api/stocktake/ordered", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, cancel: true }),
    });
    await load();
  };

  const alerts = items.filter(
    (i) => i.status === "order-now" || i.status === "order-soon" || i.status === "order-overdue"
  );
  const weeks = stats ? stats.days / 7 : null;
  const spiking = demand && demand.spikePct >= 25;

  return (
    <div style={styles.container}>
      {/* Weekly volume — the engine behind every projection */}
      <div style={styles.statRow}>
        <div style={styles.statCard}>
          <div style={styles.statLabel}>Orders / week</div>
          <div style={styles.statValue}>{stats && weeks ? Math.round(stats.orders / weeks) : "—"}</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statLabel}>Units / week</div>
          <div style={styles.statValue}>{stats && weeks ? Math.round(stats.units / weeks) : "—"}</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statLabel}>Wipes / week</div>
          <div style={styles.statValue}>{stats && weeks ? Math.round(stats.wipes / weeks) : "—"}</div>
        </div>
        <div style={{ ...styles.statCard, flex: 2 }}>
          <div style={styles.statLabel}>Scan incoming stock</div>
          <input
            ref={scanRef}
            style={styles.scanInput}
            placeholder="Scan a barcode (or type it and press Enter)"
            value={scanCode}
            onChange={(e) => setScanCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") scan(scanCode);
            }}
          />
          {scanMsg && <div style={styles.scanOk}>✓ {scanMsg}</div>}
        </div>
      </div>
      {stats && (
        <p style={styles.statNote}>
          Based on the last {stats.days} days: {stats.orders} orders, {stats.units} units. On-hand
          counts tick down automatically as orders go out; projections use this run rate.
        </p>
      )}
      {spiking && demand && (
        <div style={styles.spikeBar}>
          ⚡ Demand up {demand.spikePct}% — last 7 days ran at {demand.unitsWk7} units/week vs the
          monthly average of {demand.unitsWk28}. Projections below are using the hotter rate.
        </div>
      )}
      {!stats && !loading && (
        <p style={styles.statNote}>Shopify volume unavailable right now — projections paused.</p>
      )}

      {/* First scan of an unknown barcode → assign it once, auto-register forever */}
      {assigning && (
        <div style={styles.assignBox}>
          <div style={styles.assignTitle}>
            New barcode <code style={styles.code}>{assigning}</code> — which item is this?
          </div>
          <div style={styles.assignRow}>
            <select style={styles.select} value={assignItem} onChange={(e) => setAssignItem(e.target.value)}>
              <option value="">Choose item…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            <input
              style={{ ...styles.input, width: "170px" }}
              type="number"
              min={1}
              placeholder="Units per pack/carton"
              value={assignPack}
              onChange={(e) => setAssignPack(e.target.value)}
            />
            <button style={styles.primaryBtn} onClick={saveAssignment} disabled={!assignItem}>
              Assign &amp; add stock
            </button>
            <button style={styles.ghostBtn} onClick={() => setAssigning(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {alerts.length > 0 && (
        <div style={styles.alertBar}>
          {alerts.map((i) => (
            <span key={i.id} style={{ color: STATUS_COLOR[i.status], fontWeight: 700 }}>
              {STATUS_LABEL[i.status]}: {i.name}
              {i.daysLeft != null && i.leadTimeDays != null &&
                ` (runs out in ${Math.floor(i.daysLeft)}d, lead time ${i.leadTimeDays}d)`}
            </span>
          ))}
        </div>
      )}

      {error && <p style={styles.error}>{error}</p>}
      {loading && <p style={styles.muted}>Loading stock…</p>}

      {!loading && (
        <div style={styles.card}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Item</th>
                <th style={styles.th}>Usage</th>
                <th style={{ ...styles.th, textAlign: "center" }}>On hand</th>
                <th style={{ ...styles.th, textAlign: "center" }}>Use / week</th>
                <th style={styles.th}>Runs out</th>
                <th style={{ ...styles.th, textAlign: "center" }}>Lead time (days)</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th} />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td style={{ ...styles.td, fontWeight: 600 }}>
                    {item.name}
                    <div style={styles.unitNote}>
                      {item.unit}
                      {item.barcode ? ` · barcode ${item.barcode} (pack of ${item.packSize})` : ""}
                    </div>
                  </td>
                  <td style={{ ...styles.td, color: "var(--text-muted)", fontSize: "0.78rem" }}>
                    {USAGE_DESC[item.usage]}
                    {item.usage === "perUnit" && (
                      <div style={styles.rateRow}>
                        <input
                          style={styles.rateInput}
                          type="number"
                          step="any"
                          min={0}
                          placeholder="rate"
                          defaultValue={item.usagePerUnit ?? ""}
                          onBlur={(e) => updateField(item.id, "usagePerUnit", e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        />
                        <span style={styles.rateUnit}>{item.unit}/unit</span>
                      </div>
                    )}
                  </td>
                  <td style={{ ...styles.td, textAlign: "center" }}>
                    <input
                      key={`${item.id}:${item.effectiveQty ?? "x"}`}
                      style={styles.qtyInput}
                      type="number"
                      min={0}
                      placeholder="—"
                      defaultValue={item.effectiveQty ?? ""}
                      title="Live estimate — type a number to record a fresh physical count"
                      onBlur={(e) => {
                        // Only a changed value is a new count — leaving the
                        // live estimate untouched shouldn't reset the baseline.
                        if (e.target.value !== String(item.effectiveQty ?? "")) {
                          updateField(item.id, "qty", e.target.value);
                        }
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                    {item.countedAt && (
                      <div style={styles.countedNote}>
                        counted {item.qty} on {new Date(item.countedAt).toLocaleDateString()}
                      </div>
                    )}
                  </td>
                  <td style={{ ...styles.td, textAlign: "center" }}>
                    {fmtWeekly(item.weeklyUse)}
                    {item.spike && <span style={styles.spikeTag}> ⚡</span>}
                  </td>
                  <td style={styles.td}>
                    {fmtRunout(item)}
                    {item.onOrder && (
                      <div style={styles.onOrderNote}>
                        on order{item.onOrder.qty ? `: ${item.onOrder.qty}` : ""}
                        {item.onOrder.eta ? `, ETA ${new Date(item.onOrder.eta).toLocaleDateString()}` : ""}{" "}
                        <button style={styles.cancelOrderBtn} onClick={() => cancelOrdered(item.id)} title="Cancel the on-order flag">
                          ×
                        </button>
                      </div>
                    )}
                  </td>
                  <td style={{ ...styles.td, textAlign: "center" }}>
                    <input
                      style={styles.qtyInput}
                      type="number"
                      min={0}
                      placeholder="—"
                      defaultValue={item.leadTimeDays ?? ""}
                      onBlur={(e) => updateField(item.id, "leadTimeDays", e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  </td>
                  <td style={{ ...styles.td, color: STATUS_COLOR[item.status], fontWeight: 700, fontSize: "0.8rem" }}>
                    {STATUS_LABEL[item.status]}
                  </td>
                  <td style={{ ...styles.td, textAlign: "right", whiteSpace: "nowrap" }}>
                    <button style={styles.ghostBtn} onClick={() => receive(item.id, item.name)}>
                      + Stock in
                    </button>{" "}
                    {!item.onOrder && (
                      <button style={styles.ghostBtn} onClick={() => markOrdered(item.id, item.name)}>
                        Ordered
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={styles.footNote}>
        Set each item's lead time and (for ink/film) the per-unit usage rate. Counts fill in as stock
        is scanned or entered — projections and reorder alerts switch on automatically once an item
        has a count, a rate, and a lead time.
      </p>
    </div>
  );
}

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
  statRow: { display: "flex", gap: "1rem", flexWrap: "wrap" },
  statCard: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "0 1px 3px var(--shadow)",
    padding: "0.85rem 1.1rem",
    flex: 1,
    minWidth: "130px",
    boxSizing: "border-box",
  },
  statLabel: {
    fontSize: "0.7rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--text-muted)",
    marginBottom: "0.3rem",
  },
  statValue: { fontSize: "1.6rem", fontWeight: 800, lineHeight: 1.1 },
  statNote: { fontSize: "0.78rem", color: "var(--text-faint)", margin: "0.6rem 0 1rem" },
  scanInput: {
    width: "100%",
    padding: "0.5rem 0.7rem",
    background: "var(--surface-2)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    fontSize: "0.9rem",
    color: "var(--text)",
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  scanOk: { fontSize: "0.8rem", color: "#16a34a", fontWeight: 700, marginTop: "0.35rem" },
  assignBox: {
    background: "var(--surface)",
    border: "1px solid #d97706",
    borderRadius: "12px",
    padding: "0.9rem 1rem",
    marginBottom: "1rem",
  },
  assignTitle: { fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.6rem" },
  code: { background: "var(--surface-3)", padding: "0.1rem 0.4rem", borderRadius: "5px" },
  assignRow: { display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" },
  select: {
    padding: "0.5rem 0.65rem",
    background: "var(--surface-2)",
    color: "var(--text)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    fontSize: "0.85rem",
    fontFamily: "inherit",
  },
  input: {
    padding: "0.5rem 0.65rem",
    background: "var(--surface-2)",
    color: "var(--text)",
    border: "1px solid var(--border-strong)",
    borderRadius: "8px",
    fontSize: "0.85rem",
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  primaryBtn: {
    padding: "0.5rem 1rem",
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "0.82rem",
    fontWeight: 700,
    fontFamily: "inherit",
  },
  ghostBtn: {
    padding: "0.4rem 0.8rem",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "7px",
    cursor: "pointer",
    fontSize: "0.78rem",
    color: "var(--text-muted)",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  alertBar: {
    display: "flex",
    flexDirection: "column",
    gap: "0.3rem",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderLeft: "4px solid #dc2626",
    borderRadius: "10px",
    padding: "0.7rem 1rem",
    marginBottom: "1rem",
    fontSize: "0.85rem",
  },
  muted: { color: "var(--text-muted)", fontSize: "0.9rem" },
  error: { fontSize: "0.85rem", color: "#dc2626", margin: "0 0 0.75rem" },
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "0 1px 3px var(--shadow)",
    padding: "0.75rem 1rem",
    overflowX: "auto",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" },
  th: {
    textAlign: "left",
    padding: "0.4rem 0.55rem",
    borderBottom: "1px solid var(--border-strong)",
    color: "var(--text-muted)",
    fontSize: "0.72rem",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
  },
  td: { padding: "0.45rem 0.55rem", borderBottom: "1px solid var(--border)", verticalAlign: "middle" },
  unitNote: { fontSize: "0.72rem", color: "var(--text-faint)", fontWeight: 400, marginTop: "0.1rem" },
  rateRow: { display: "flex", alignItems: "center", gap: "0.3rem", marginTop: "0.25rem" },
  rateInput: {
    width: "70px",
    padding: "0.25rem 0.4rem",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    fontSize: "0.78rem",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  rateUnit: { fontSize: "0.7rem", color: "var(--text-faint)" },
  qtyInput: {
    width: "76px",
    textAlign: "center",
    padding: "0.3rem 0.2rem",
    background: "var(--surface-2)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    fontSize: "0.85rem",
    color: "var(--text)",
    fontFamily: "inherit",
  },
  footNote: { fontSize: "0.78rem", color: "var(--text-faint)", marginTop: "1rem", maxWidth: "720px" },
  countedNote: { fontSize: "0.68rem", color: "var(--text-faint)", marginTop: "0.15rem" },
  spikeTag: { color: "#d97706" },
  onOrderNote: { fontSize: "0.72rem", color: "var(--accent)", marginTop: "0.15rem" },
  cancelOrderBtn: {
    background: "none",
    border: "none",
    color: "var(--text-faint)",
    cursor: "pointer",
    fontSize: "0.85rem",
    padding: "0 0.15rem",
    lineHeight: 1,
  },
  spikeBar: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderLeft: "4px solid #d97706",
    borderRadius: "10px",
    padding: "0.6rem 1rem",
    marginBottom: "1rem",
    fontSize: "0.85rem",
  },
};
