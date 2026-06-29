import { useEffect, useState } from "react";
import { onAmendment, type Amendment } from "./amendment";
import { toast } from "./toast";

/** Bottom-right popup that appears when an edited Auto Draft is sent. Shows the
 *  model's proposed guideline rule (editable); approving it amends the live
 *  guidelines so future replies follow it. Mount once near the app root. */
export function AmendmentPrompt() {
  const [item, setItem] = useState<Amendment | null>(null);
  const [rule, setRule] = useState("");
  const [showContext, setShowContext] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      onAmendment((a) => {
        setItem(a);
        setRule(a.rule);
        setShowContext(false);
      }),
    []
  );

  if (!item) return null;

  async function act(action: "approve" | "reject") {
    if (busy || !item) return;
    setBusy(true);
    try {
      await fetch("/api/ai/amendments/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action, rule: rule.trim() }),
      });
      if (action === "approve") toast("Guideline added", "success");
    } catch {
      toast("Failed to save guideline");
    } finally {
      setBusy(false);
      setItem(null);
    }
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title}>💡 Suggested guideline update</span>
        <button style={styles.close} title="Dismiss" onClick={() => act("reject")}>
          ×
        </button>
      </div>
      <p style={styles.hint}>
        Based on your edit. Approve to teach the AI this rule for future replies.
      </p>
      <textarea
        value={rule}
        onChange={(e) => setRule(e.target.value)}
        style={styles.textarea}
        rows={3}
      />

      <button style={styles.contextToggle} onClick={() => setShowContext((s) => !s)}>
        {showContext ? "Hide" : "Show"} what changed
      </button>
      {showContext && (
        <div style={styles.context}>
          <div style={styles.ctxRow}>
            <span style={styles.ctxTag}>Customer</span> {item.customer || "—"}
          </div>
          <div style={styles.ctxRow}>
            <span style={styles.ctxTagBad}>AI drafted</span>
            <span style={styles.strike}>{item.draft}</span>
          </div>
          <div style={styles.ctxRow}>
            <span style={styles.ctxTagGood}>You sent</span> {item.corrected}
          </div>
        </div>
      )}

      <div style={styles.btns}>
        <button
          style={{ ...styles.approve, ...(busy || !rule.trim() ? styles.disabled : {}) }}
          disabled={busy || !rule.trim()}
          onClick={() => act("approve")}
        >
          Add to guidelines
        </button>
        <button style={styles.dismiss} disabled={busy} onClick={() => act("reject")}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    position: "fixed",
    bottom: "1.5rem",
    right: "1.5rem",
    width: "min(360px, 92vw)",
    background: "var(--surface)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "12px",
    boxShadow: "0 8px 28px rgba(0,0,0,0.22)",
    padding: "0.9rem 1rem",
    zIndex: 1100,
    fontFamily: "inherit",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: "0.9rem", fontWeight: 700 },
  close: {
    background: "none",
    border: "none",
    fontSize: "1.3rem",
    lineHeight: 1,
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "0 0.2rem",
  },
  hint: { fontSize: "0.74rem", color: "var(--text-faint)", margin: "0.35rem 0 0.5rem", lineHeight: 1.4 },
  textarea: {
    width: "100%",
    padding: "0.55rem 0.7rem",
    border: "1px solid var(--border)",
    background: "var(--surface-2)",
    color: "var(--text)",
    borderRadius: "8px",
    fontSize: "0.82rem",
    fontFamily: "inherit",
    resize: "vertical",
    outline: "none",
    boxSizing: "border-box",
    lineHeight: 1.45,
  },
  contextToggle: {
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    fontSize: "0.72rem",
    cursor: "pointer",
    padding: "0.4rem 0 0",
    textDecoration: "underline",
  },
  context: {
    marginTop: "0.4rem",
    padding: "0.5rem 0.6rem",
    background: "var(--surface-2)",
    borderRadius: "8px",
    fontSize: "0.76rem",
    lineHeight: 1.4,
  },
  ctxRow: { marginBottom: "0.3rem" },
  ctxTag: {
    fontSize: "0.58rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
    color: "var(--text-muted)", marginRight: "0.4rem",
  },
  ctxTagBad: {
    fontSize: "0.58rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
    color: "#d32f2f", marginRight: "0.4rem",
  },
  ctxTagGood: {
    fontSize: "0.58rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
    color: "#16a34a", marginRight: "0.4rem",
  },
  strike: { textDecoration: "line-through", opacity: 0.6 },
  btns: { display: "flex", gap: "0.5rem", marginTop: "0.7rem" },
  approve: {
    flex: 1,
    padding: "0.5rem 0.8rem",
    background: "#16a34a",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "0.8rem",
    fontWeight: 700,
    cursor: "pointer",
  },
  dismiss: {
    padding: "0.5rem 0.9rem",
    background: "var(--surface-2)",
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  disabled: { opacity: 0.5, cursor: "not-allowed" },
};
