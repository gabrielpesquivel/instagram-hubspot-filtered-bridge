import { useState, useEffect } from "react";

interface AgentSettingsData {
  gemini_model: string;
  auto_approve_known: boolean;
  has_gemini_key: boolean;
}

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite",
];

export function AgentSettings({
  settings,
  onUpdate,
}: {
  settings: AgentSettingsData | null;
  onUpdate: () => void;
}) {
  const [model, setModel] = useState("gemini-2.5-flash");
  const [autoApprove, setAutoApprove] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setModel(settings.gemini_model);
      setAutoApprove(settings.auto_approve_known);
    }
  }, [settings]);

  async function save(updates: Partial<{
    gemini_model: string;
    auto_approve_known: boolean;
  }>) {
    setSaving(true);
    try {
      await fetch("/api/settings/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      onUpdate();
    } finally {
      setSaving(false);
    }
  }

  function handleAutoApproveToggle() {
    const next = !autoApprove;
    setAutoApprove(next);
    save({ auto_approve_known: next });
  }

  function handleModelChange(newModel: string) {
    setModel(newModel);
    save({ gemini_model: newModel });
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Agent Settings</h2>
      <div style={styles.box}>
        {/* Auto-approve toggle */}
        <div style={styles.toggleRow}>
          <div>
            <div style={styles.label}>Auto-Approve Known Senders</div>
            <div style={styles.hint}>
              {autoApprove
                ? "Messages from known senders go directly to conversations"
                : "All messages go through pending queue"}
            </div>
          </div>
          <button
            onClick={handleAutoApproveToggle}
            disabled={saving}
            style={{
              ...styles.toggle,
              background: autoApprove ? "#4caf50" : "#ccc",
            }}
          >
            <span
              style={{
                ...styles.toggleKnob,
                transform: autoApprove ? "translateX(18px)" : "translateX(0)",
              }}
            />
          </button>
        </div>

        <div style={styles.divider} />

        {/* Gemini model */}
        <div style={styles.field}>
          <div style={styles.label}>Gemini Model</div>
          <div style={styles.modelButtons}>
            {GEMINI_MODELS.map((m) => (
              <button
                key={m}
                onClick={() => handleModelChange(m)}
                disabled={saving}
                style={{
                  ...styles.modelBtn,
                  ...(model === m ? styles.modelBtnActive : {}),
                }}
              >
                {m.replace("gemini-", "")}
              </button>
            ))}
          </div>
          {settings && !settings.has_gemini_key && (
            <div style={styles.warning}>Gemini API key not set</div>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    marginTop: "1.5rem",
  },
  title: {
    fontSize: "1.1rem",
    fontWeight: 600,
    margin: 0,
    marginBottom: "0.75rem",
  },
  box: {
    background: "#fff",
    borderRadius: "6px",
    padding: "1rem",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
  },
  field: {
    marginBottom: "0.25rem",
  },
  label: {
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#555",
    marginBottom: "0.25rem",
  },
  hint: {
    fontSize: "0.75rem",
    color: "#999",
    marginTop: "2px",
    marginBottom: "6px",
  },
  warning: {
    fontSize: "0.75rem",
    color: "#f44336",
    marginTop: "4px",
  },
  divider: {
    height: "1px",
    background: "#f0f0f0",
    margin: "0.75rem 0",
  },
  toggleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "0.75rem",
  },
  toggle: {
    position: "relative" as const,
    width: "42px",
    height: "24px",
    borderRadius: "12px",
    border: "none",
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
    transition: "background 0.2s",
  },
  toggleKnob: {
    position: "absolute" as const,
    top: "3px",
    left: "3px",
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    background: "#fff",
    transition: "transform 0.2s",
    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
  },
  modelButtons: {
    display: "flex",
    gap: "0.35rem",
    flexWrap: "wrap" as const,
  },
  modelBtn: {
    padding: "0.3rem 0.6rem",
    background: "#f0f0f0",
    border: "1px solid #ddd",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.72rem",
    fontWeight: 500,
    color: "#555",
    transition: "all 0.15s",
  },
  modelBtnActive: {
    background: "#2196f3",
    color: "#fff",
    border: "1px solid #2196f3",
    fontWeight: 600,
  },
};
