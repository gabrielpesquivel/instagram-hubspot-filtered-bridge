import { useCallback, useEffect, useState } from "react";
import { MetaConnection } from "./MetaConnection";
import { WebhookSubscriptions } from "./WebhookSubscriptions";
import { FilterSettings } from "./FilterSettings";
import { AgentSettings } from "./AgentSettings";

interface BlocklistEntry {
  senderId: string;
  username: string;
}

interface EmailConn {
  connected: boolean;
  email?: string;
  connected_at?: string;
}

interface Correction {
  id: string;
  at: string;
  customer: string;
  draft: string;
  corrected: string;
}

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [meta, setMeta] = useState<any>(null);
  const [filter, setFilter] = useState<any>(null);
  const [agent, setAgent] = useState<any>(null);
  const [blocklist, setBlocklist] = useState<BlocklistEntry[]>([]);
  const [email, setEmail] = useState<EmailConn | null>(null);
  const [blockInput, setBlockInput] = useState("");
  const [signature, setSignature] = useState("");
  const [sigSaved, setSigSaved] = useState(false);
  const [useGmailSig, setUseGmailSig] = useState(false);
  const [pendingFixes, setPendingFixes] = useState<Correction[]>([]);
  const [approvedFixes, setApprovedFixes] = useState<Correction[]>([]);

  const refetch = useCallback(async () => {
    const [m, f, a, b, e, s] = await Promise.all([
      fetch("/api/meta/connection").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/settings/filter").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/settings/agent").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/blocklist").then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch("/api/email/connection").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/email/signature").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    setMeta(m);
    setFilter(f);
    setAgent(a);
    setBlocklist(Array.isArray(b) ? b : []);
    setEmail(e);
    setSignature(s?.signature ?? "");
    setUseGmailSig(!!s?.useGmail);
    fetchCorrections();
  }, []);

  async function fetchCorrections() {
    try {
      const res = await fetch("/api/ai/corrections");
      if (res.ok) {
        const d = await res.json();
        setPendingFixes(d.pending || []);
        setApprovedFixes(d.approved || []);
      }
    } catch {
      /* ignore */
    }
  }

  async function correctionAction(id: string, action: "approve" | "reject" | "delete") {
    if (action === "approve") {
      setPendingFixes((p) => p.filter((c) => c.id !== id));
    } else if (action === "reject") {
      setPendingFixes((p) => p.filter((c) => c.id !== id));
    } else {
      setApprovedFixes((p) => p.filter((c) => c.id !== id));
    }
    await fetch("/api/ai/corrections/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    fetchCorrections();
  }

  async function saveSignature() {
    await fetch("/api/email/signature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature }),
    });
    setSigSaved(true);
    setTimeout(() => setSigSaved(false), 1500);
  }

  async function toggleGmailSig(next: boolean) {
    setUseGmailSig(next);
    await fetch("/api/email/signature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useGmail: next }),
    });
  }

  useEffect(() => {
    if (open) refetch();
  }, [open, refetch]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function addBlock() {
    const username = blockInput.trim().replace(/^@/, "");
    if (!username) return;
    await fetch("/api/blocklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    setBlockInput("");
    refetch();
  }

  async function unblock(senderId: string) {
    await fetch("/api/blocklist/unblock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId }),
    });
    refetch();
  }

  async function disconnectEmail() {
    await fetch("/api/email/disconnect", { method: "POST" });
    refetch();
  }

  return (
    <>
      <div
        style={{ ...styles.backdrop, ...(open ? styles.backdropOpen : {}) }}
        onClick={onClose}
      />
      <aside style={{ ...styles.drawer, ...(open ? styles.drawerOpen : {}) }} aria-hidden={!open}>
        <header style={styles.header}>
          <span style={styles.headerTitle}>Settings</span>
          <button onClick={onClose} style={styles.closeBtn} title="Close">
            ×
          </button>
        </header>

        <div style={styles.scroll}>
          {/* Channels */}
          <h3 style={styles.sectionTitle}>Channels</h3>

          <div style={styles.block}>
            <div style={styles.blockLabel}>Instagram</div>
            <MetaConnection connection={meta} onRefresh={refetch} />
            <div style={{ marginTop: "0.75rem" }}>
              <WebhookSubscriptions />
            </div>
          </div>

          <div style={styles.block}>
            <div style={styles.blockLabel}>Email (Gmail)</div>
            {email?.connected ? (
              <div style={styles.emailRow}>
                <span style={styles.emailText}>
                  Connected: <strong>{email.email}</strong>
                </span>
                <div style={styles.emailBtns}>
                  <a href="/auth/google" style={styles.reconnectBtn}>
                    Reconnect
                  </a>
                  <button onClick={disconnectEmail} style={styles.smallBtn}>
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <div style={styles.emailRow}>
                <span style={styles.mutedText}>Not connected — needed to read & send support email.</span>
                <a href="/auth/google" style={styles.connectBtn}>
                  Connect Gmail
                </a>
              </div>
            )}
            <p style={styles.hint}>
              Sending requires the send permission — if email replies fail, click Reconnect once to
              grant it.
            </p>

            <div style={styles.sigBlock}>
              <div style={styles.sigLabel}>Email signature</div>
              <label style={styles.sigToggle}>
                <input
                  type="checkbox"
                  checked={useGmailSig}
                  onChange={(e) => toggleGmailSig(e.target.checked)}
                />
                Use my Gmail signature automatically
              </label>
              {useGmailSig ? (
                <p style={styles.hint}>
                  Your Gmail signature is pulled from this account and added to every reply (sent as
                  HTML to keep its formatting).
                </p>
              ) : (
                <>
                  <p style={styles.hint}>Appended to the bottom of every email you send.</p>
                  <textarea
                    value={signature}
                    onChange={(e) => setSignature(e.target.value)}
                    placeholder={"Kind regards,\nThe BootInk Team\nwww.bootink.com"}
                    style={styles.sigTextarea}
                    rows={4}
                  />
                  <button onClick={saveSignature} style={styles.sigSaveBtn}>
                    {sigSaved ? "Saved ✓" : "Save signature"}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Automation */}
          <h3 style={styles.sectionTitle}>Automation</h3>
          <div style={styles.block}>
            <FilterSettings settings={filter} onUpdate={refetch} />
          </div>
          <div style={styles.block}>
            <AgentSettings settings={agent} onUpdate={refetch} />
          </div>

          {/* AI training */}
          <h3 style={styles.sectionTitle}>AI training</h3>
          <div style={styles.block}>
            <div style={styles.blockLabel}>Pending lessons ({pendingFixes.length})</div>
            <p style={styles.hint}>
              When you edit an Auto Draft before sending, the change is captured here. Approve the
              ones that should teach the AI; reject the rest. Nothing affects replies until approved.
            </p>
            {pendingFixes.length === 0 ? (
              <div style={{ ...styles.mutedText, marginTop: "0.5rem" }}>No pending lessons.</div>
            ) : (
              pendingFixes.map((c) => (
                <div key={c.id} style={styles.fixCard}>
                  <div style={styles.fixRow}>
                    <span style={styles.fixTag}>Customer</span> {c.customer || "—"}
                  </div>
                  <div style={styles.fixRow}>
                    <span style={styles.fixTagBad}>AI drafted</span>
                    <span style={styles.fixStrike}>{c.draft}</span>
                  </div>
                  <div style={styles.fixRow}>
                    <span style={styles.fixTagGood}>You sent</span> {c.corrected}
                  </div>
                  <div style={styles.fixBtns}>
                    <button style={styles.fixApprove} onClick={() => correctionAction(c.id, "approve")}>
                      Approve
                    </button>
                    <button style={styles.fixReject} onClick={() => correctionAction(c.id, "reject")}>
                      Reject
                    </button>
                  </div>
                </div>
              ))
            )}

            {approvedFixes.length > 0 && (
              <>
                <div style={{ ...styles.blockLabel, marginTop: "1rem" }}>
                  Active lessons ({approvedFixes.length})
                </div>
                <p style={styles.hint}>These are shaping replies now. Remove any that misfire.</p>
                {approvedFixes.map((c) => (
                  <div key={c.id} style={styles.fixCardActive}>
                    <div style={styles.fixRow}>
                      <span style={styles.fixTagGood}>Preferred</span> {c.corrected}
                    </div>
                    <div style={styles.fixBtns}>
                      <button style={styles.fixReject} onClick={() => correctionAction(c.id, "delete")}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Blocklist */}
          <h3 style={styles.sectionTitle}>Blocked senders ({blocklist.length})</h3>
          <div style={styles.block}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addBlock();
              }}
              style={styles.blockForm}
            >
              <input
                value={blockInput}
                onChange={(e) => setBlockInput(e.target.value)}
                placeholder="@username"
                style={styles.blockInputField}
              />
              <button type="submit" style={styles.addBtn}>
                Block
              </button>
            </form>
            <div style={styles.blockListBox}>
              {blocklist.length === 0 ? (
                <div style={styles.mutedText}>No blocked senders</div>
              ) : (
                blocklist.map((b) => (
                  <div key={b.senderId} style={styles.blockEntry}>
                    <span style={styles.blockUser}>@{b.username}</span>
                    <button onClick={() => unblock(b.senderId)} style={styles.unblockBtn}>
                      Unblock
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

const BORDER = "var(--border)";
const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "var(--overlay)",
    opacity: 0,
    pointerEvents: "none",
    transition: "opacity 0.2s",
    zIndex: 200,
  },
  backdropOpen: { opacity: 1, pointerEvents: "auto" },
  drawer: {
    position: "fixed",
    top: 0,
    right: 0,
    height: "100vh",
    width: "min(440px, 100vw)",
    background: "var(--surface)",
    boxShadow: "-4px 0 24px rgba(0,0,0,0.12)",
    transform: "translateX(100%)",
    transition: "transform 0.22s ease",
    zIndex: 201,
    display: "flex",
    flexDirection: "column",
    color: "var(--text)",
  },
  drawerOpen: { transform: "translateX(0)" },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 1rem",
    height: "56px",
    borderBottom: `1px solid ${BORDER}`,
    flexShrink: 0,
  },
  headerTitle: { fontSize: "1.05rem", fontWeight: 700, color: "var(--text)" },
  closeBtn: {
    background: "none",
    border: "none",
    fontSize: "1.5rem",
    lineHeight: 1,
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "0.2rem 0.5rem",
  },
  scroll: { flex: 1, overflowY: "auto", padding: "1rem 1.25rem 3rem" },
  sectionTitle: {
    fontSize: "0.72rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--text-faint)",
    margin: "1.5rem 0 0.6rem",
  },
  block: {
    border: `1px solid ${BORDER}`,
    borderRadius: "10px",
    padding: "0.85rem",
    marginBottom: "0.75rem",
    background: "var(--surface-2)",
  },
  blockLabel: { fontSize: "0.8rem", fontWeight: 700, color: "var(--text)", marginBottom: "0.6rem" },
  emailRow: { display: "flex", flexDirection: "column", gap: "0.6rem" },
  emailText: { fontSize: "0.85rem", color: "var(--text)" },
  mutedText: { fontSize: "0.82rem", color: "var(--text-muted)" },
  emailBtns: { display: "flex", gap: "0.5rem" },
  connectBtn: {
    alignSelf: "flex-start",
    padding: "0.45rem 1.1rem",
    background: "#1a73e8",
    color: "#fff",
    borderRadius: "7px",
    fontSize: "0.82rem",
    fontWeight: 600,
    textDecoration: "none",
  },
  reconnectBtn: {
    padding: "0.35rem 0.9rem",
    background: "#1a73e8",
    color: "#fff",
    borderRadius: "7px",
    fontSize: "0.78rem",
    fontWeight: 600,
    textDecoration: "none",
  },
  smallBtn: {
    padding: "0.35rem 0.9rem",
    background: "var(--surface)",
    border: `1px solid ${BORDER}`,
    borderRadius: "7px",
    cursor: "pointer",
    fontSize: "0.78rem",
    color: "var(--text-muted)",
  },
  hint: { fontSize: "0.72rem", color: "var(--text-faint)", margin: "0.6rem 0 0", lineHeight: 1.4 },
  sigBlock: { marginTop: "0.85rem", paddingTop: "0.85rem", borderTop: `1px solid ${BORDER}` },
  sigLabel: { fontSize: "0.8rem", fontWeight: 700, color: "var(--text)" },
  sigToggle: {
    display: "flex",
    alignItems: "center",
    gap: "0.45rem",
    fontSize: "0.82rem",
    color: "var(--text)",
    margin: "0.5rem 0 0.3rem",
    cursor: "pointer",
  },
  sigTextarea: {
    width: "100%",
    marginTop: "0.5rem",
    padding: "0.55rem 0.7rem",
    border: `1px solid ${BORDER}`,
    background: "var(--surface)",
    color: "var(--text)",
    borderRadius: "8px",
    fontSize: "0.82rem",
    fontFamily: "inherit",
    resize: "vertical",
    outline: "none",
    boxSizing: "border-box",
    lineHeight: 1.45,
  },
  sigSaveBtn: {
    marginTop: "0.5rem",
    padding: "0.4rem 1rem",
    background: "#111",
    color: "#fff",
    border: "none",
    borderRadius: "7px",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  blockForm: { display: "flex", gap: "0.5rem", marginBottom: "0.6rem" },
  blockInputField: {
    flex: 1,
    padding: "0.45rem 0.7rem",
    border: `1px solid ${BORDER}`,
    background: "var(--surface)",
    color: "var(--text)",
    borderRadius: "7px",
    fontSize: "0.82rem",
    outline: "none",
  },
  addBtn: {
    padding: "0.45rem 1rem",
    background: "#111",
    color: "#fff",
    border: "none",
    borderRadius: "7px",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  fixCard: {
    border: `1px solid var(--border)`,
    background: "var(--surface)",
    borderRadius: "8px",
    padding: "0.6rem 0.7rem",
    marginTop: "0.6rem",
    fontSize: "0.8rem",
    color: "var(--text)",
    lineHeight: 1.4,
  },
  fixCardActive: {
    border: `1px solid #16a34a55`,
    background: "var(--surface)",
    borderRadius: "8px",
    padding: "0.5rem 0.7rem",
    marginTop: "0.5rem",
    fontSize: "0.8rem",
    color: "var(--text)",
  },
  fixRow: { marginBottom: "0.3rem" },
  fixTag: {
    fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
    color: "var(--text-muted)", marginRight: "0.4rem",
  },
  fixTagBad: {
    fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
    color: "#d32f2f", marginRight: "0.4rem",
  },
  fixTagGood: {
    fontSize: "0.6rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
    color: "#16a34a", marginRight: "0.4rem",
  },
  fixStrike: { textDecoration: "line-through", opacity: 0.6 },
  fixBtns: { display: "flex", gap: "0.4rem", marginTop: "0.4rem" },
  fixApprove: {
    padding: "0.3rem 0.8rem", background: "#16a34a", color: "#fff", border: "none",
    borderRadius: "6px", fontSize: "0.72rem", fontWeight: 700, cursor: "pointer",
  },
  fixReject: {
    padding: "0.3rem 0.8rem", background: "var(--surface)", color: "var(--text-muted)",
    border: `1px solid ${BORDER}`, borderRadius: "6px", fontSize: "0.72rem", fontWeight: 600, cursor: "pointer",
  },
  blockListBox: { display: "flex", flexDirection: "column", gap: "0.3rem" },
  blockEntry: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.35rem 0.5rem",
    borderRadius: "6px",
    background: "var(--surface)",
    border: `1px solid ${BORDER}`,
  },
  blockUser: { fontSize: "0.82rem", fontWeight: 600, color: "var(--text)" },
  unblockBtn: {
    padding: "0.2rem 0.6rem",
    background: "none",
    border: `1px solid ${BORDER}`,
    borderRadius: "5px",
    fontSize: "0.72rem",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
};
