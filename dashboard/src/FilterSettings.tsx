import { useState, useEffect } from "react";

interface FilterSettingsData {
  min_followers: number;
  skip_verified: boolean;
}

export function FilterSettings({
  settings,
  onUpdate,
}: {
  settings: FilterSettingsData | null;
  onUpdate: () => void;
}) {
  const [followers, setFollowers] = useState(5000);
  const [skipVerified, setSkipVerified] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (settings) {
      setFollowers(settings.min_followers);
      setSkipVerified(settings.skip_verified);
      setDirty(false);
    }
  }, [settings]);

  async function save(newFollowers: number, newSkipVerified: boolean) {
    setSaving(true);
    try {
      await fetch("/api/settings/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          min_followers: newFollowers,
          skip_verified: newSkipVerified,
        }),
      });
      setDirty(false);
      onUpdate();
    } finally {
      setSaving(false);
    }
  }

  function handleFollowerChange(value: number) {
    setFollowers(value);
    setDirty(true);
  }

  function handleVerifiedToggle() {
    const next = !skipVerified;
    setSkipVerified(next);
    save(followers, next);
  }

  function formatFollowers(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
    return n.toString();
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Filter Settings</h2>
      <div style={styles.box}>
        <div style={styles.field}>
          <div style={styles.labelRow}>
            <label style={styles.label}>Follower Threshold</label>
            <span style={styles.value}>{formatFollowers(followers)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100000}
            step={500}
            value={followers}
            onChange={(e) => handleFollowerChange(Number(e.target.value))}
            onMouseUp={() => { if (dirty) save(followers, skipVerified); }}
            onTouchEnd={() => { if (dirty) save(followers, skipVerified); }}
            style={styles.slider}
          />
          <div style={styles.rangeLabels}>
            <span>0</span>
            <span>100K</span>
          </div>
          <div style={styles.hint}>
            Skip messages from accounts with {formatFollowers(followers)}+ followers
          </div>
        </div>

        <div style={styles.divider} />

        <div style={styles.toggleRow}>
          <div>
            <div style={styles.label}>Skip Verified Users</div>
            <div style={styles.hint}>
              {skipVerified
                ? "Verified accounts are filtered out"
                : "Verified accounts are forwarded"}
            </div>
          </div>
          <button
            onClick={handleVerifiedToggle}
            disabled={saving}
            style={{
              ...styles.toggle,
              background: skipVerified ? "#4caf50" : "#ccc",
            }}
          >
            <span
              style={{
                ...styles.toggleKnob,
                transform: skipVerified ? "translateX(18px)" : "translateX(0)",
              }}
            />
          </button>
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
    background: "var(--surface)",
    borderRadius: "6px",
    padding: "1rem",
    boxShadow: "0 1px 4px var(--shadow)",
  },
  field: {
    marginBottom: "0.25rem",
  },
  labelRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "0.25rem",
  },
  label: {
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "var(--text-muted)",
  },
  value: {
    fontSize: "0.9rem",
    fontWeight: 700,
    color: "var(--text)",
    fontVariantNumeric: "tabular-nums",
  },
  slider: {
    width: "100%",
    cursor: "pointer",
    accentColor: "#1877f2",
  },
  rangeLabels: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "0.7rem",
    color: "var(--text-faint)",
    marginTop: "-2px",
  },
  hint: {
    fontSize: "0.75rem",
    color: "var(--text-faint)",
    marginTop: "4px",
  },
  divider: {
    height: "1px",
    background: "var(--surface-2)",
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
    background: "var(--surface)",
    transition: "transform 0.2s",
    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
  },
};
