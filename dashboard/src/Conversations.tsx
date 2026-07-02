import { useState, useEffect, useRef } from "react";
import { toast } from "./toast";

interface ConversationSummary {
  senderId: string;
  senderUsername: string;
  lastMessageSnippet: string;
  lastMessageAt: string;
  unread: boolean;
  autoReply?: boolean;
  language?: string;
  status: string;
}

interface ConversationMessage {
  id: string;
  sender: "user" | "agent";
  text: string;
  translation?: string;
  status?: "sent" | "failed";
  timestamp: string;
}

interface ConversationFull {
  senderId: string;
  senderUsername: string;
  messages: ConversationMessage[];
  autoReply: boolean;
  windowExpired?: boolean;
  language?: string;
}

export function Conversations({ fullPage = false }: { fullPage?: boolean } = {}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [selectedUsername, setSelectedUsername] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState("");
  const [autoReply, setAutoReply] = useState(false);
  const [windowExpired, setWindowExpired] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [sending, setSending] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;

  async function fetchConversations() {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) setConversations(await res.json());
    } catch { /* ignore */ }
  }

  async function fetchMessages(senderId: string) {
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(senderId)}`);
      // A slow response for a previously selected thread must not overwrite
      // the current one, and a poll landing mid-send would clobber the
      // optimistic bubble — drop the response in both cases.
      if (res.ok && selectedRef.current === senderId && !sendingRef.current) {
        const data: ConversationFull = await res.json();
        if (selectedRef.current !== senderId || sendingRef.current) return;
        setMessages(data.messages);
        setSelectedUsername(data.senderUsername);
        setSelectedLanguage(data.language ?? "");
        setAutoReply(data.autoReply ?? false);
        setWindowExpired(data.windowExpired ?? false);
      }
    } catch { /* ignore */ }
    finally {
      if (selectedRef.current === senderId) setLoadingMessages(false);
    }
  }

  function selectConversation(senderId: string) {
    setSelected(senderId);
    setMessages([]);
    setReplyText("");
    setGenerateError("");
    setLoadingMessages(true);
    fetchMessages(senderId);
  }

  async function handleSend() {
    if (!selected || !replyText.trim() || sending) return;
    setSending(true);
    const text = replyText.trim();

    const optimistic: ConversationMessage = {
      id: "temp-" + Date.now(),
      sender: "agent",
      text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setReplyText("");

    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(selected)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { failed?: boolean; error?: string }));
        if (body.failed) {
          // Stored server-side as failed — refetch to show the retry button.
          // Clear the sending flag first so the refetch isn't dropped by the
          // mid-send guard in fetchMessages.
          toast("Send failed — saved with a retry button");
          sendingRef.current = false;
          setSending(false);
          fetchMessages(selected);
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
          setReplyText(text);
          toast(body.error || "Send failed");
        }
      } else {
        fetchConversations();
      }
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setReplyText(text);
      toast("Network error — message not sent");
    } finally {
      setSending(false);
    }
  }

  async function handleRetry(messageId: string) {
    if (!selected || retryingId) return;
    setRetryingId(messageId);
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(selected)}/messages/${encodeURIComponent(messageId)}/retry`,
        { method: "POST" }
      );
      if (res.ok) {
        toast("Message sent", "success");
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, status: "sent" } : m))
        );
      } else {
        const body = await res.json().catch(() => ({} as { error?: string }));
        toast(body.error || "Retry failed");
      }
    } catch {
      toast("Network error — retry failed");
    } finally {
      setRetryingId(null);
    }
  }

  async function handleGenerate() {
    if (!selected || generating) return;
    setGenerating(true);
    setGenerateError("");
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(selected)}/generate`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        // Server already sent it — add to messages optimistically
        const sent: ConversationMessage = {
          id: "ai-" + Date.now(),
          sender: "agent",
          text: data.suggestion,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, sent]);
        fetchConversations();
      } else {
        if (data.failed && selected) {
          toast("AI reply generated but send failed — retry from the thread");
          fetchMessages(selected);
        }
        setGenerateError(data.error || "Generation failed");
      }
    } catch {
      setGenerateError("Network error");
      toast("Network error — AI reply failed");
    } finally {
      setGenerating(false);
    }
  }

  async function handleToggleAutoReply() {
    if (!selected) return;
    const next = !autoReply;
    setAutoReply(next);
    await fetch(`/api/conversations/${encodeURIComponent(selected)}/auto-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    fetchConversations();
  }

  async function handleArchive() {
    if (!selected) return;
    await fetch(`/api/conversations/${encodeURIComponent(selected)}/archive`, {
      method: "POST",
    });
    setSelected(null);
    setMessages([]);
    fetchConversations();
  }

  async function handleClearAll() {
    if (!confirm("Clear ALL conversations? This cannot be undone.")) return;
    await fetch("/api/conversations/clear-all", { method: "POST" });
    setSelected(null);
    setMessages([]);
    fetchConversations();
  }

  async function handleDeleteMessage(messageId: string) {
    if (!selected || deletingId) return;
    setDeletingId(messageId);
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(selected)}/messages/${encodeURIComponent(messageId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        fetchMessages(selected);
      }
    } catch {
      fetchMessages(selected);
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => {
    fetchConversations();
    const interval = setInterval(fetchConversations, 10_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (selected) {
      const interval = setInterval(() => fetchMessages(selected), 10_000);
      return () => clearInterval(interval);
    }
  }, [selected]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const filteredConversations = search.trim()
    ? conversations.filter(
        (c) =>
          c.senderUsername.toLowerCase().includes(search.trim().toLowerCase()) ||
          c.lastMessageSnippet.toLowerCase().includes(search.trim().toLowerCase())
      )
    : conversations;

  function formatTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    return d.toLocaleDateString();
  }

  return (
    <div style={{ ...styles.container, ...(fullPage ? styles.containerFull : {}) }}>
      {/* Conversation list */}
      <div style={styles.list}>
        <div style={styles.listHeader}>
          <span>Conversations ({conversations.length})</span>
          {conversations.length > 0 && (
            <button onClick={handleClearAll} style={styles.clearAllBtn}>
              Clear All
            </button>
          )}
        </div>
        {conversations.length > 3 && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            style={styles.searchInput}
          />
        )}
        {filteredConversations.length === 0 ? (
          <div style={styles.empty}>
            {conversations.length === 0 ? "No active conversations" : "No matches"}
          </div>
        ) : (
          filteredConversations.map((c) => (
            <div
              key={c.senderId}
              onClick={() => selectConversation(c.senderId)}
              style={{
                ...styles.convCard,
                ...(selected === c.senderId ? styles.convCardActive : {}),
                ...(c.unread ? styles.convCardUnread : {}),
              }}
            >
              <div style={styles.convTop}>
                <span style={styles.convUser}>
                  @{c.senderUsername}
                  {c.language && <span style={styles.langBadge}>{c.language}</span>}
                  {c.autoReply && <span style={styles.autoReplyBadge}>AI</span>}
                </span>
                <span style={styles.convTime}>{formatTime(c.lastMessageAt)}</span>
              </div>
              <div style={styles.convSnippet}>{c.lastMessageSnippet}</div>
              {c.unread && <span style={styles.unreadDot} />}
            </div>
          ))
        )}
      </div>

      {/* Message view */}
      <div style={styles.messageArea}>
        {!selected ? (
          <div style={styles.noSelection}>Select a conversation</div>
        ) : (
          <>
            <div style={styles.messageHeader}>
              <span style={styles.messageHeaderUser}>
                @{selectedUsername}
                {selectedLanguage && <span style={styles.langBadgeHeader}>{selectedLanguage}</span>}
              </span>
              <div style={styles.headerActions}>
                <button
                  onClick={handleToggleAutoReply}
                  style={{
                    ...styles.autoReplyBtn,
                    ...(autoReply ? styles.autoReplyBtnOn : {}),
                  }}
                >
                  {autoReply ? "Auto-reply ON" : "Auto-reply OFF"}
                </button>
                <button onClick={handleArchive} style={styles.archiveBtn}>
                  Archive
                </button>
              </div>
            </div>
            <div style={styles.messageList}>
              {loadingMessages ? (
                <div style={styles.loadingMessages}>Loading...</div>
              ) : messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    ...styles.bubbleRow,
                    ...(m.sender === "agent" ? styles.bubbleRowAgent : {}),
                  }}
                >
                  <div
                    style={{
                      ...styles.bubble,
                      ...(m.sender === "agent" ? styles.bubbleAgent : styles.bubbleUser),
                    }}
                  >
                    <div style={styles.bubbleText}>{m.text}</div>
                    {m.translation && (
                      <div style={styles.translation}>{m.translation}</div>
                    )}
                    <div style={styles.bubbleTime}>{formatTime(m.timestamp)}</div>
                    {m.status === "failed" && (
                      <div style={styles.failedRow}>
                        <span style={styles.failedBadge}>not sent</span>
                        <button
                          onClick={() => handleRetry(m.id)}
                          disabled={retryingId === m.id}
                          style={styles.retryBtn}
                        >
                          {retryingId === m.id ? "Retrying…" : "Retry"}
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleDeleteMessage(m.id)}
                    style={styles.deleteBtn}
                    title="Delete message"
                  >
                    ×
                  </button>
                </div>
              ))}
              {!loadingMessages && <div ref={messagesEndRef} />}
            </div>
            <div style={styles.replyArea}>
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Type a reply..."
                style={styles.textarea}
                rows={3}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div style={styles.replyButtons}>
                {windowExpired && (
                  <span style={styles.windowExpiredNote}>24h expired — Human Agent tag will be used</span>
                )}
                {generateError && (
                  <span style={styles.generateError}>{generateError}</span>
                )}
                {!windowExpired && (
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    style={styles.generateBtn}
                  >
                    {generating ? "Sending..." : "AI Reply"}
                  </button>
                )}
                <button
                  onClick={handleSend}
                  disabled={sending || !replyText.trim()}
                  style={styles.sendBtn}
                >
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    gap: "0",
    background: "#fff",
    borderRadius: "6px",
    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    height: "520px",
    overflow: "hidden",
  },
  containerFull: {
    height: "100%",
    borderRadius: 0,
    boxShadow: "none",
  },
  list: {
    flex: 1,
    minWidth: 0,
    borderRight: "1px solid #e0e0e0",
    overflowY: "auto",
  },
  listHeader: {
    padding: "0.75rem 1rem",
    fontWeight: 600,
    fontSize: "0.85rem",
    borderBottom: "1px solid #f0f0f0",
    background: "#fafafa",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  clearAllBtn: {
    padding: "0.2rem 0.5rem",
    background: "#f44336",
    color: "#fff",
    border: "none",
    borderRadius: "3px",
    cursor: "pointer",
    fontSize: "0.65rem",
    fontWeight: 600,
  },
  searchInput: {
    width: "calc(100% - 1.5rem)",
    margin: "0.5rem 0.75rem",
    padding: "0.35rem 0.6rem",
    border: "1px solid #ddd",
    borderRadius: "4px",
    fontSize: "0.8rem",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  failedRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    marginTop: "0.35rem",
  },
  failedBadge: {
    fontSize: "0.6rem",
    fontWeight: 700,
    background: "#fff",
    color: "#d32f2f",
    border: "1px solid #d32f2f",
    padding: "1px 5px",
    borderRadius: "3px",
    textTransform: "uppercase" as const,
  },
  retryBtn: {
    padding: "0.15rem 0.6rem",
    background: "#d32f2f",
    color: "#fff",
    border: "none",
    borderRadius: "3px",
    cursor: "pointer",
    fontSize: "0.65rem",
    fontWeight: 700,
  },
  empty: {
    padding: "2rem 1rem",
    textAlign: "center" as const,
    color: "#999",
    fontSize: "0.85rem",
  },
  convCard: {
    padding: "0.6rem 1rem",
    borderBottom: "1px solid #f0f0f0",
    cursor: "pointer",
    position: "relative" as const,
    transition: "background 0.1s",
  },
  convCardActive: {
    background: "#e3f2fd",
  },
  convCardUnread: {
    background: "#fff8e1",
  },
  convTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "2px",
  },
  convUser: {
    fontWeight: 600,
    fontSize: "0.8rem",
    color: "#333",
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  convTime: {
    fontSize: "0.7rem",
    color: "#999",
  },
  convSnippet: {
    fontSize: "0.75rem",
    color: "#666",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  langBadge: {
    fontSize: "0.55rem",
    fontWeight: 700,
    background: "#e0e0e0",
    color: "#555",
    padding: "1px 4px",
    borderRadius: "3px",
  },
  langBadgeHeader: {
    fontSize: "0.65rem",
    fontWeight: 600,
    background: "#e0e0e0",
    color: "#555",
    padding: "1px 5px",
    borderRadius: "3px",
    marginLeft: "6px",
  },
  autoReplyBadge: {
    fontSize: "0.55rem",
    fontWeight: 700,
    background: "#7c4dff",
    color: "#fff",
    padding: "1px 4px",
    borderRadius: "3px",
  },
  unreadDot: {
    position: "absolute" as const,
    right: "8px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#2196f3",
  },
  messageArea: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    minWidth: 0,
  },
  loadingMessages: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#999",
    fontSize: "0.85rem",
  },
  noSelection: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#999",
    fontSize: "0.9rem",
  },
  messageHeader: {
    padding: "0.6rem 1rem",
    borderBottom: "1px solid #f0f0f0",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    background: "#fafafa",
  },
  messageHeaderUser: {
    fontWeight: 600,
    fontSize: "0.9rem",
  },
  headerActions: {
    display: "flex",
    gap: "0.4rem",
    alignItems: "center",
  },
  autoReplyBtn: {
    padding: "0.25rem 0.5rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.7rem",
    fontWeight: 600,
    color: "#999",
  },
  autoReplyBtnOn: {
    background: "#7c4dff",
    color: "#fff",
    border: "1px solid #7c4dff",
  },
  archiveBtn: {
    padding: "0.25rem 0.6rem",
    background: "none",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.75rem",
    color: "#666",
  },
  messageList: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "1rem",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  },
  bubbleRow: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    alignSelf: "flex-start",
  },
  bubbleRowAgent: {
    alignSelf: "flex-end",
    flexDirection: "row-reverse" as const,
  },
  deleteBtn: {
    background: "none",
    border: "none",
    color: "#ccc",
    cursor: "pointer",
    fontSize: "1rem",
    padding: "2px 4px",
    borderRadius: "4px",
    lineHeight: 1,
    opacity: 0.4,
    flexShrink: 0,
  },
  bubble: {
    maxWidth: "75%",
    padding: "0.5rem 0.75rem",
    borderRadius: "12px",
    fontSize: "0.85rem",
    lineHeight: 1.4,
    wordBreak: "break-word" as const,
  },
  bubbleUser: {
    alignSelf: "flex-start",
    background: "#f0f0f0",
    color: "#333",
  },
  bubbleAgent: {
    alignSelf: "flex-end",
    background: "#2196f3",
    color: "#fff",
  },
  bubbleText: {
    whiteSpace: "pre-wrap" as const,
  },
  translation: {
    fontSize: "0.75rem",
    fontStyle: "italic" as const,
    opacity: 0.7,
    marginTop: "3px",
    paddingTop: "3px",
    borderTop: "1px solid rgba(0,0,0,0.1)",
  },
  bubbleTime: {
    fontSize: "0.65rem",
    opacity: 0.7,
    marginTop: "2px",
    textAlign: "right" as const,
  },
  replyArea: {
    padding: "0.75rem",
    borderTop: "1px solid #e0e0e0",
    background: "#fafafa",
  },
  textarea: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #ddd",
    borderRadius: "6px",
    fontSize: "0.85rem",
    resize: "none" as const,
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
  },
  replyButtons: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "0.5rem",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  windowExpiredNote: {
    fontSize: "0.7rem",
    color: "#ff5722",
    fontWeight: 600,
    flex: 1,
  },
  generateError: {
    fontSize: "0.72rem",
    color: "#f44336",
    flex: 1,
  },
  generateBtn: {
    padding: "0.4rem 0.8rem",
    background: "#7c4dff",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
  sendBtn: {
    padding: "0.4rem 1rem",
    background: "#4caf50",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
};
