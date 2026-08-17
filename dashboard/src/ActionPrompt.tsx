import { useEffect, useState } from "react";
import { onActions, type ActionProposal } from "./action";
import { toast } from "./toast";

/** Bottom-right cards for order actions the AI detected. "Review" opens a
 *  per-action modal where the agent confirms details, then we write to Shopify
 *  (+ StarShipit). Mount once near the app root. */
export function ActionPrompt() {
  const [queue, setQueue] = useState<ActionProposal[]>([]);
  const [active, setActive] = useState<ActionProposal | null>(null);

  useEffect(
    () =>
      onActions((actions) =>
        setQueue((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...actions.filter((a) => !seen.has(a.id))];
        })
      ),
    []
  );

  function dismiss(id: string) {
    setQueue((prev) => prev.filter((a) => a.id !== id));
    setActive((cur) => (cur?.id === id ? null : cur));
  }

  if (queue.length === 0) return null;

  return (
    <>
      <div style={styles.stack}>
        {queue.map((a) => (
          <div key={a.id} style={styles.card}>
            <div style={styles.label}>Order action</div>
            <div style={styles.summary}>{a.summary}</div>
            <div style={styles.btns}>
              <button style={styles.yes} onClick={() => setActive(a)}>Review</button>
              <button style={styles.no} onClick={() => dismiss(a.id)}>Dismiss</button>
            </div>
          </div>
        ))}
      </div>
      {active && (
        <ActionModal
          key={active.id}
          proposal={active}
          onClose={() => setActive(null)}
          onDone={() => dismiss(active.id)}
        />
      )}
    </>
  );
}

// ── shared helpers ────────────────────────────────────────────────────────────
const arg = (a: ActionProposal, k: string): string => {
  const v = a.args?.[k];
  return typeof v === "string" ? v : "";
};
const cleanOrder = (s: string) => s.trim().replace(/^#/, "");

async function postAction(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(`/api/shopify/actions/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

function starshipitNote(data: Record<string, unknown>): string {
  const ss = data.starshipit;
  return typeof ss === "string" && ss !== "updated" ? ` · StarShipit: ${ss}` : "";
}

// ── modal router ──────────────────────────────────────────────────────────────
function ActionModal(props: { proposal: ActionProposal; onClose: () => void; onDone: () => void }) {
  const { proposal, onClose } = props;
  const t = proposal.type;
  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <span>{proposal.summary}</span>
          <button style={styles.x} onClick={onClose}>×</button>
        </div>
        {t === "update_address" && <AddressForm {...props} />}
        {t === "update_email" && <EmailForm {...props} />}
        {t === "cancel_refund" && <CancelRefundForm {...props} />}
        {t === "duplicate_order" && <DuplicateForm {...props} />}
        {t === "add_to_order" && <AddToOrderForm {...props} />}
      </div>
    </div>
  );
}

type FormProps = { proposal: ActionProposal; onClose: () => void; onDone: () => void };

// ── update_address ────────────────────────────────────────────────────────────
interface Addr { firstName: string; lastName: string; company: string; address1: string; address2: string; city: string; province: string; zip: string; country: string; phone: string; }
const EMPTY_ADDR: Addr = { firstName: "", lastName: "", company: "", address1: "", address2: "", city: "", province: "", zip: "", country: "", phone: "" };

/** Coerce an unknown address-shaped object (from the API) into a full Addr with
 *  string fields — undefined/missing keys become "". */
function toAddr(raw: unknown): Addr {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    firstName: s(a.firstName), lastName: s(a.lastName), company: s(a.company),
    address1: s(a.address1), address2: s(a.address2), city: s(a.city),
    province: s(a.province), zip: s(a.zip), country: s(a.country), phone: s(a.phone),
  };
}

function AddressForm({ proposal, onDone }: FormProps) {
  const [order, setOrder] = useState(cleanOrder(proposal.orderNumber || arg(proposal, "order_number")));
  const [addr, setAddr] = useState<Addr>(EMPTY_ADDR);
  const [search, setSearch] = useState(arg(proposal, "new_address"));
  const [parsing, setParsing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // Parse a free-text address into the structured fields (Gemini). Merges only
  // the fields it resolves, so a partial paste doesn't wipe existing values.
  async function autofill(text: string) {
    const raw = text.trim();
    if (!raw) return;
    setParsing(true);
    try {
      const r = await fetch("/api/shopify/actions/parse-address", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: raw }),
      });
      const d = (await r.json().catch(() => ({}))) as { address?: Partial<Addr> };
      const parsed = d.address || {};
      setAddr((p) => {
        const next = { ...p };
        (Object.keys(EMPTY_ADDR) as (keyof Addr)[]).forEach((k) => {
          const v = parsed[k];
          if (typeof v === "string" && v.trim()) next[k] = v.trim();
        });
        return next;
      });
    } catch { /* leave fields as-is */ }
    finally { setParsing(false); }
  }

  // Fetch the order's CURRENT shipping address (no state change) — reused for
  // both the full preload and the state/country backfill below.
  async function fetchCurrentAddress(num: string): Promise<Addr | null> {
    const clean = cleanOrder(num);
    if (!clean) return null;
    try {
      const r = await fetch(`/api/shopify/actions/order-items?name=${encodeURIComponent(clean)}`);
      const d = (await r.json().catch(() => ({}))) as { shippingAddress?: unknown };
      if (r.ok && d.shippingAddress) return toAddr(d.shippingAddress);
    } catch { /* ignore — agent can fill manually */ }
    return null;
  }

  // Pre-load the order's CURRENT shipping address so the form isn't blank — the
  // agent edits from the real starting point instead of retyping everything.
  async function loadCurrent(num: string) {
    setLoading(true);
    const cur = await fetchCurrentAddress(num);
    if (cur) setAddr(cur);
    setLoading(false);
  }

  // On open: if the AI captured the customer's requested new address, parse that;
  // otherwise pre-load the order's current address for editing.
  useEffect(() => {
    const requested = arg(proposal, "new_address");
    if (requested) {
      (async () => {
        await autofill(requested);
        // Guarantee state + country are populated: if the parse still couldn't
        // resolve them, fall back to the order's existing values for just those
        // two (they rarely change on an address edit). Address-specific fields
        // (street/unit/postcode) are NOT backfilled, to avoid old data bleeding in.
        const cur = await fetchCurrentAddress(order);
        if (cur) setAddr((p) => ({
          ...p,
          province: p.province || cur.province,
          country: p.country || cur.country,
        }));
      })();
    } else if (order) {
      loadCurrent(order);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k: keyof Addr) => (e: React.ChangeEvent<HTMLInputElement>) => setAddr((p) => ({ ...p, [k]: e.target.value }));

  async function submit() {
    if (!order) return toast("Enter the order number");
    if (!addr.address1 || !addr.city || !addr.country) return toast("Address needs street, city and country");
    setBusy(true);
    try {
      const { ok, data } = await postAction("update-address", { orderNumber: order, address: addr });
      if (ok) { toast(`✓ #${cleanOrder(order)} address updated${starshipitNote(data)}`, "success"); onDone(); }
      else toast(String(data.error || "Update failed"));
    } finally { setBusy(false); }
  }

  return (
    <div style={styles.body}>
      {arg(proposal, "new_address") && (
        <div style={styles.quote}>Customer: “{arg(proposal, "new_address")}”</div>
      )}
      <div style={styles.row2}>
        <OrderField value={order} onChange={setOrder} />
        <button style={styles.loadBtn} disabled={loading} onClick={() => loadCurrent(order)}>
          {loading ? "Loading…" : "Load current"}
        </button>
      </div>

      {/* Paste/type any address → Gemini parses it into the fields below. */}
      <div style={styles.searchWrap}>
        <textarea
          style={styles.searchArea}
          placeholder="Search: paste or type a full address to autofill the fields…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) autofill(search); }}
        />
        <button style={styles.loadBtn} disabled={parsing} onClick={() => autofill(search)}>
          {parsing ? "Reading…" : "Autofill"}
        </button>
      </div>

      <div style={styles.row2}>
        <Input ph="First name" value={addr.firstName} onChange={set("firstName")} />
        <Input ph="Last name" value={addr.lastName} onChange={set("lastName")} />
      </div>
      <Input ph="Company (optional)" value={addr.company} onChange={set("company")} />
      <Input ph="Address line 1" value={addr.address1} onChange={set("address1")} />
      <Input ph="Address line 2 (optional)" value={addr.address2} onChange={set("address2")} />
      <div style={styles.row2}>
        <Input ph="City" value={addr.city} onChange={set("city")} />
        <Input ph="State / province" value={addr.province} onChange={set("province")} />
      </div>
      <div style={styles.row2}>
        <Input ph="Postcode" value={addr.zip} onChange={set("zip")} />
        <Input ph="Country" value={addr.country} onChange={set("country")} />
      </div>
      <Input ph="Phone (optional)" value={addr.phone} onChange={set("phone")} />
      <SubmitRow busy={busy} label="Update address" onClick={submit} />
    </div>
  );
}

// ── update_email ──────────────────────────────────────────────────────────────
function EmailForm({ proposal, onDone }: FormProps) {
  const [order, setOrder] = useState(cleanOrder(proposal.orderNumber || arg(proposal, "order_number")));
  const [email, setEmail] = useState(arg(proposal, "new_email"));
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!order) return toast("Enter the order number");
    if (!email.includes("@")) return toast("Enter a valid email");
    setBusy(true);
    try {
      const { ok, data } = await postAction("update-email", { orderNumber: order, email });
      if (ok) { toast(`✓ #${cleanOrder(order)} email updated${starshipitNote(data)}`, "success"); onDone(); }
      else toast(String(data.error || "Update failed"));
    } finally { setBusy(false); }
  }
  return (
    <div style={styles.body}>
      <OrderField value={order} onChange={setOrder} />
      <Input ph="New email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <SubmitRow busy={busy} label="Update email" onClick={submit} />
    </div>
  );
}

// ── cancel_refund ─────────────────────────────────────────────────────────────
const REASONS = ["CUSTOMER", "INVENTORY", "FRAUD", "DECLINED", "STAFF", "OTHER"];
function CancelRefundForm({ proposal, onDone }: FormProps) {
  const [order, setOrder] = useState(cleanOrder(proposal.orderNumber || arg(proposal, "order_number")));
  const [mode, setMode] = useState<"cancel" | "refund">("cancel");
  const [reason, setReason] = useState("CUSTOMER");
  const [restock, setRestock] = useState(true);
  const [notify, setNotify] = useState(true);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!order) return toast("Enter the order number");
    if (mode === "refund" && !(Number(amount) > 0)) return toast("Enter a refund amount");
    setBusy(true);
    try {
      const { ok, data } = await postAction("cancel-refund", { orderNumber: order, mode, reason, restock, notify, amount });
      if (ok) {
        const msg = mode === "cancel" ? `cancelled + refunded${starshipitNote(data)}` : `refunded ${data.amount} ${data.currency}`;
        toast(`✓ #${cleanOrder(order)} ${msg}`, "success"); onDone();
      } else toast(String(data.error || "Action failed"));
    } finally { setBusy(false); }
  }
  return (
    <div style={styles.body}>
      {arg(proposal, "reason") && <div style={styles.quote}>Reason: “{arg(proposal, "reason")}”</div>}
      <OrderField value={order} onChange={setOrder} />
      <div style={styles.seg}>
        <button style={mode === "cancel" ? styles.segOn : styles.segOff} onClick={() => setMode("cancel")}>Cancel + full refund</button>
        <button style={mode === "refund" ? styles.segOn : styles.segOff} onClick={() => setMode("refund")}>Partial refund</button>
      </div>
      <label style={styles.fieldLabel}>Reason
        <select style={styles.select} value={reason} onChange={(e) => setReason(e.target.value)}>
          {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      {mode === "refund" && <Input ph="Refund amount (e.g. 12.50)" value={amount} onChange={(e) => setAmount(e.target.value)} />}
      {mode === "cancel" && <Check label="Restock items" checked={restock} onChange={setRestock} />}
      <Check label="Notify customer by email" checked={notify} onChange={setNotify} />
      <SubmitRow busy={busy} danger label={mode === "cancel" ? "Cancel & refund order" : "Issue partial refund"} onClick={submit} />
    </div>
  );
}

// ── duplicate_order ───────────────────────────────────────────────────────────
interface LI { variantId: string | null; title: string; quantity: number; properties?: { key: string; value: string }[]; }
function DuplicateForm({ proposal, onDone }: FormProps) {
  const [order, setOrder] = useState(cleanOrder(proposal.orderNumber || arg(proposal, "order_number")));
  const [items, setItems] = useState<LI[] | null>(null);
  const [sel, setSel] = useState<Record<number, boolean>>({});
  const [qty, setQty] = useState<Record<number, number>>({});
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!order) return;
    setLoadErr(""); setItems(null);
    const res = await fetch(`/api/shopify/actions/order-items?name=${encodeURIComponent(order)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setLoadErr(String(data.error || "Lookup failed")); return; }
    const lis: LI[] = data.lineItems || [];
    setItems(lis);
    const init: Record<number, boolean> = {};
    const q: Record<number, number> = {};
    lis.forEach((li, i) => { init[i] = true; q[i] = li.quantity; }); // preselect all at full qty; agent trims
    setSel(init);
    setQty(q);
  }
  useEffect(() => { if (order) load(); /* eslint-disable-next-line */ }, []);

  async function submit() {
    if (!items) return toast("Load the order first");
    const chosen = items.map((li, i) => ({ li, i })).filter(({ li, i }) => sel[i] && li.variantId)
      .map(({ li, i }) => ({
        variantId: li.variantId as string,
        quantity: Math.min(li.quantity, Math.max(1, qty[i] || 1)),
        properties: li.properties || [],
      }));
    if (!chosen.length) return toast("Select at least one replaceable item");
    setBusy(true);
    try {
      const { ok, data } = await postAction("duplicate-order", { orderNumber: order, items: chosen });
      if (ok) { toast(`✓ $0 replacement ${data.replacementOrder} created for #${cleanOrder(order)}`, "success"); onDone(); }
      else toast(String(data.error || "Failed to create replacement"));
    } finally { setBusy(false); }
  }
  return (
    <div style={styles.body}>
      {arg(proposal, "items") && <div style={styles.quote}>Customer mentioned: “{arg(proposal, "items")}”</div>}
      <div style={styles.row2}>
        <OrderField value={order} onChange={setOrder} />
        <button style={styles.loadBtn} onClick={load}>Load items</button>
      </div>
      {loadErr && <div style={styles.err}>{loadErr}</div>}
      {items && items.length === 0 && <div style={styles.hint}>No line items found.</div>}
      {items && items.map((li, i) => {
        const shown = (li.properties || []).filter((p) => !p.key.startsWith("_"));
        return (
          <div key={i} style={{ opacity: li.variantId ? 1 : 0.5 }}>
            <label style={styles.itemRow}>
              <input type="checkbox" disabled={!li.variantId} checked={!!sel[i]} onChange={(e) => setSel((p) => ({ ...p, [i]: e.target.checked }))} />
              {li.quantity > 1 && li.variantId ? (
                <>
                  <input type="number" min={1} max={li.quantity} value={qty[i] ?? li.quantity} style={styles.qty}
                    onChange={(e) => setQty((p) => ({ ...p, [i]: Math.min(li.quantity, Math.max(1, Number(e.target.value) || 1)) }))} />
                  <span>of {li.quantity}× {li.title}</span>
                </>
              ) : (
                <span>{li.quantity}× {li.title}{!li.variantId && " (no variant — can't replace)"}</span>
              )}
            </label>
            {shown.length > 0 && (
              <div style={styles.props}>
                {shown.map((p, j) => <div key={j}>{p.key}: {p.value}</div>)}
              </div>
            )}
          </div>
        );
      })}
      <div style={styles.hint}>Replacement is created at $0, shipped to the original address. Item attributes (names, initials, etc.) are copied over.</div>
      <SubmitRow busy={busy} label="Create $0 replacement" onClick={submit} />
    </div>
  );
}

// ── add_to_order ──────────────────────────────────────────────────────────────
interface Pick { variantId: string; label: string; price: string; quantity: number; }
function AddToOrderForm({ proposal, onDone }: FormProps) {
  const [order, setOrder] = useState(cleanOrder(proposal.orderNumber || arg(proposal, "order_number")));
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ variantId: string; label: string; price: string }[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);

  async function search() {
    if (!q.trim()) return;
    const res = await fetch(`/api/shopify/actions/search-variants?q=${encodeURIComponent(q)}`);
    const data = await res.json().catch(() => ({}));
    setHits(data.variants || []);
  }
  function add(h: { variantId: string; label: string; price: string }) {
    setPicks((p) => p.some((x) => x.variantId === h.variantId) ? p : [...p, { ...h, quantity: 1 }]);
  }
  async function submit() {
    if (!order) return toast("Enter the order number");
    if (!picks.length) return toast("Add at least one item");
    setBusy(true);
    try {
      const { ok, data } = await postAction("add-to-order", {
        orderNumber: order, notify, items: picks.map((p) => ({ variantId: p.variantId, quantity: p.quantity })),
      });
      if (ok) { toast(`✓ Items added to #${cleanOrder(order)}${notify ? " · invoice sent" : ""}`, "success"); onDone(); }
      else toast(String(data.error || "Failed to add items"));
    } finally { setBusy(false); }
  }
  return (
    <div style={styles.body}>
      {arg(proposal, "items") && <div style={styles.quote}>Customer wants: “{arg(proposal, "items")}”</div>}
      <OrderField value={order} onChange={setOrder} />
      <div style={styles.row2}>
        <Input ph="Search products to add…" value={q} onChange={(e) => setQ(e.target.value)} onEnter={search} />
        <button style={styles.loadBtn} onClick={search}>Search</button>
      </div>
      {hits.map((h) => (
        <div key={h.variantId} style={styles.itemRow}>
          <span style={{ flex: 1 }}>{h.label} — {h.price}</span>
          <button style={styles.addBtn} onClick={() => add(h)}>Add</button>
        </div>
      ))}
      {picks.length > 0 && <div style={styles.fieldLabel}>To add:</div>}
      {picks.map((p, i) => (
        <div key={p.variantId} style={styles.itemRow}>
          <span style={{ flex: 1 }}>{p.label}</span>
          <input type="number" min={1} value={p.quantity} style={styles.qty}
            onChange={(e) => setPicks((arr) => arr.map((x, j) => j === i ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x))} />
          <button style={styles.x} onClick={() => setPicks((arr) => arr.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <Check label="Send invoice for the added amount" checked={notify} onChange={setNotify} />
      <SubmitRow busy={busy} label="Add items" onClick={submit} />
    </div>
  );
}

// ── small inputs ──────────────────────────────────────────────────────────────
function OrderField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={styles.orderWrap}>
      <span style={styles.hash}>#</span>
      <input style={styles.orderInput} placeholder="Order number" value={value} onChange={(e) => onChange(cleanOrder(e.target.value))} />
    </div>
  );
}
function Input({ ph, value, onChange, onEnter }: { ph: string; value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; onEnter?: () => void }) {
  return <input style={styles.input} placeholder={ph} value={value} onChange={onChange}
    onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }} />;
}
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (b: boolean) => void }) {
  return <label style={styles.check}><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
}
function SubmitRow({ busy, label, onClick, danger }: { busy: boolean; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button disabled={busy} style={{ ...styles.submit, ...(danger ? styles.submitDanger : {}), opacity: busy ? 0.6 : 1 }} onClick={onClick}>
      {busy ? "Working…" : label}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  stack: { position: "fixed", bottom: "1.5rem", right: "1.5rem", display: "flex", flexDirection: "column", gap: "0.6rem", zIndex: 1150, width: "min(320px, 92vw)" },
  card: { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderLeft: "4px solid #ff9800", borderRadius: "12px", boxShadow: "0 8px 28px rgba(0,0,0,0.22)", padding: "0.8rem 0.95rem" },
  label: { fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-faint)" },
  summary: { fontSize: "0.95rem", fontWeight: 700, margin: "0.25rem 0 0.6rem" },
  btns: { display: "flex", gap: "0.5rem" },
  yes: { flex: 1, padding: "0.45rem 0.8rem", background: "#ff9800", color: "#fff", border: "none", borderRadius: "8px", fontSize: "0.82rem", fontWeight: 700, cursor: "pointer" },
  no: { flex: 1, padding: "0.45rem 0.8rem", background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" },
  modal: { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "14px", width: "min(440px, 96vw)", maxHeight: "88vh", overflow: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.35)" },
  modalHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.9rem 1.1rem", borderBottom: "1px solid var(--border)", fontWeight: 700 },
  x: { background: "none", border: "none", color: "var(--text-muted)", fontSize: "1.3rem", cursor: "pointer", lineHeight: 1, padding: 0 },
  body: { padding: "1rem 1.1rem", display: "flex", flexDirection: "column", gap: "0.55rem" },
  quote: { fontSize: "0.8rem", fontStyle: "italic", color: "var(--text-muted)", background: "var(--surface-2)", borderRadius: "8px", padding: "0.5rem 0.6rem" },
  hint: { fontSize: "0.75rem", color: "var(--text-faint)" },
  searchWrap: { display: "flex", gap: "0.5rem", alignItems: "stretch" },
  searchArea: { flex: 1, minHeight: "38px", maxHeight: "96px", padding: "0.5rem 0.65rem", background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "0.85rem", fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" },
  err: { fontSize: "0.8rem", color: "#d32f2f" },
  row2: { display: "flex", gap: "0.5rem" },
  input: { flex: 1, padding: "0.5rem 0.65rem", background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "0.85rem", width: "100%", boxSizing: "border-box" },
  orderWrap: { display: "flex", alignItems: "center", gap: "0.3rem", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "8px", padding: "0 0.6rem" },
  hash: { color: "var(--text-faint)", fontWeight: 700 },
  orderInput: { flex: 1, padding: "0.5rem 0", background: "transparent", color: "var(--text)", border: "none", fontSize: "0.85rem", outline: "none" },
  fieldLabel: { fontSize: "0.8rem", fontWeight: 600, display: "flex", flexDirection: "column", gap: "0.3rem" },
  select: { padding: "0.5rem 0.65rem", background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "0.85rem" },
  seg: { display: "flex", gap: "0.4rem" },
  segOn: { flex: 1, padding: "0.45rem", background: "#2196f3", color: "#fff", border: "none", borderRadius: "8px", fontSize: "0.78rem", fontWeight: 700, cursor: "pointer" },
  segOff: { flex: 1, padding: "0.45rem", background: "var(--surface-2)", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "0.78rem", fontWeight: 600, cursor: "pointer" },
  check: { display: "flex", alignItems: "center", gap: "0.45rem", fontSize: "0.82rem", color: "var(--text-muted)" },
  itemRow: { display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.83rem", padding: "0.25rem 0" },
  props: { margin: "0 0 0.2rem 1.6rem", fontSize: "0.76rem", color: "var(--text-muted)", lineHeight: 1.5 },
  loadBtn: { padding: "0.5rem 0.8rem", background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "8px", fontSize: "0.8rem", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" },
  addBtn: { padding: "0.3rem 0.7rem", background: "#2196f3", color: "#fff", border: "none", borderRadius: "7px", fontSize: "0.78rem", fontWeight: 700, cursor: "pointer" },
  qty: { width: "3rem", padding: "0.3rem", background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "7px", fontSize: "0.8rem" },
  submit: { marginTop: "0.4rem", padding: "0.6rem", background: "#2e7d32", color: "#fff", border: "none", borderRadius: "9px", fontSize: "0.88rem", fontWeight: 700, cursor: "pointer" },
  submitDanger: { background: "#d32f2f" },
};
