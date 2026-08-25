import { useState } from "react";
import { Inbox } from "./Inbox";
import { SettingsDrawer } from "./SettingsDrawer";
import { ThemeToggle } from "./ThemeToggle";
import { Toaster } from "./toast";
import { AmendmentPrompt } from "./AmendmentPrompt";
import { ActionPrompt } from "./ActionPrompt";

interface InboxPageProps {
  onBack: () => void;
  onLogout: () => void;
}

export function InboxPage({ onBack, onLogout }: InboxPageProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div style={styles.wrapper}>
      <header style={styles.topBar}>
        <div style={styles.topBarInner}>
          <img
            src="/logo.png"
            alt="BootInk"
            style={styles.logo}
            onClick={onBack}
            title="Back to tools"
          />
          <span style={styles.title}>Customer Support</span>
          <div style={styles.right}>
            <button onClick={() => setSettingsOpen(true)} style={styles.ghostBtn} title="Channels & settings">
              ⚙ Settings
            </button>
            <ThemeToggle />
            <button onClick={onLogout} style={styles.ghostBtn}>
              Log out
            </button>
          </div>
        </div>
      </header>

      <div style={styles.body}>
        <Inbox />
      </div>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Toaster />
      <AmendmentPrompt />
      <ActionPrompt />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "var(--text)",
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg)",
    overflow: "hidden",
  },
  topBar: {
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    padding: "0 1rem",
    flexShrink: 0,
  },
  topBarInner: {
    display: "flex",
    alignItems: "center",
    position: "relative",
    height: "56px",
    gap: "0.75rem",
  },
  logo: { height: "30px", width: "auto", cursor: "pointer" },
  title: {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: "1.05rem",
    fontWeight: 700,
    color: "var(--text)",
    whiteSpace: "nowrap",
  },
  right: { marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem" },
  ghostBtn: {
    padding: "0.4rem 0.9rem",
    background: "var(--surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "7px",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "var(--text-muted)",
  },
  body: {
    flex: 1,
    minHeight: 0,
    boxSizing: "border-box",
  },
};
