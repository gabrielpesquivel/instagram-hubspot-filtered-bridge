import { useEffect, useState } from "react";
import { onActions, type ActionProposal } from "./action";
import { toast } from "./toast";

/** Bottom-right confirmation cards for order actions the AI detected. Detection
 *  test only: Yes just acknowledges (no Shopify write yet), No dismisses. Mount
 *  once near the app root. */
export function ActionPrompt() {
  const [queue, setQueue] = useState<ActionProposal[]>([]);

  useEffect(
    () =>
      onActions((actions) =>
        // De-dupe by id in case the same draft is requested twice.
        setQueue((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...actions.filter((a) => !seen.has(a.id))];
        })
      ),
    []
  );

  if (queue.length === 0) return null;

  function dismiss(id: string) {
    setQueue((prev) => prev.filter((a) => a.id !== id));
  }

  function confirm(a: ActionProposal) {
    // TODO: wire to Shopify. For now just confirm detection worked.
    toast(`✓ Confirmed: ${a.summary} (not wired to Shopify yet)`, "success");
    dismiss(a.id);
  }

  return (
    <div style={styles.stack}>
      {queue.map((a) => (
        <div key={a.id} style={styles.card}>
          <div style={styles.label}>Action needed?</div>
          <div style={styles.summary}>{a.summary}</div>
          <div style={styles.btns}>
            <button style={styles.yes} onClick={() => confirm(a)}>
              Yes
            </button>
            <button style={styles.no} onClick={() => dismiss(a.id)}>
              No
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  stack: {
    position: "fixed",
    bottom: "1.5rem",
    right: "1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.6rem",
    zIndex: 1150,
    width: "min(320px, 92vw)",
  },
  card: {
    background: "var(--surface)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderLeft: "4px solid #2196f3",
    borderRadius: "12px",
    boxShadow: "0 8px 28px rgba(0,0,0,0.22)",
    padding: "0.8rem 0.95rem",
    fontFamily: "inherit",
  },
  label: {
    fontSize: "0.62rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--text-faint)",
  },
  summary: { fontSize: "0.95rem", fontWeight: 700, margin: "0.25rem 0 0.6rem" },
  btns: { display: "flex", gap: "0.5rem" },
  yes: {
    flex: 1,
    padding: "0.45rem 0.8rem",
    background: "#2196f3",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "0.82rem",
    fontWeight: 700,
    cursor: "pointer",
  },
  no: {
    flex: 1,
    padding: "0.45rem 0.8rem",
    background: "var(--surface-2)",
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    fontSize: "0.82rem",
    fontWeight: 600,
    cursor: "pointer",
  },
};
