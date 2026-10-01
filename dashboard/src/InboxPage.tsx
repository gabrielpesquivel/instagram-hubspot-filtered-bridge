import { useState } from "react";
import { Inbox } from "./Inbox";
import { SettingsDrawer } from "./SettingsDrawer";
import { TopBarActions } from "./TopBar";
import { Toaster } from "./toast";
import { AmendmentPrompt } from "./AmendmentPrompt";
import { ActionPrompt } from "./ActionPrompt";

export function InboxPage() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div style={styles.wrapper}>
      <TopBarActions>
        <button onClick={() => setSettingsOpen(true)} style={styles.ghostBtn} title="Channels & settings">
          ⚙ Settings
        </button>
      </TopBarActions>

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
