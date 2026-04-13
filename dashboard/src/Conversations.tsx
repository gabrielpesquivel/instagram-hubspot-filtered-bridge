import { useState, useEffect, useRef } from "react";

interface ConversationSummary {
  senderId: string;
  senderUsername: string;
  lastMessageSnippet: string;
  lastMessageAt: string;
  unread: boolean;
  status: string;
}

interface ConversationMessage {
  id: string;
  sender: "user" | "agent";
  text: string;
  timestamp: string;
}

interface ConversationFull {
  senderId: string;
  senderUsername: string;
  messages: ConversationMessage[];
}

export function Conversations() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [selectedUsername, setSelectedUsername] = useState("");
  const [replyText, setReplyText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  async function fetchConversations() {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) setConversations(await res.json());
    } catch { /* ignore */ }
  }

  async function fetchMessages(senderId: string) {
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(senderId)}`);
      if (res.ok) {
        const data: ConversationFull = await res.json();
        setMessages(data.messages);
        setSelectedUsername(data.senderUsername);
      }
    } catch { /* ignore */ }
  }

  function selectConversation(senderId: string) {
    setSelected(senderId);
    setReplyText("");
    fetchMessages(senderId);
  }

  async function handleSend() {
    if (!selected || !replyText.trim() || sending) return;
    setSending(true);
    const text = replyText.trim();

    // Optimistic UI
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
        // Revert optimistic
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        setReplyText(text);
      } else {
        fetchConversations();
      }
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setReplyText(text);
    } finally {
      setSending(false);
    }
  }

  async function handleGenerate() {
    if (!selected || generating) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(selected)}/generate`, {
        method: "POST",
      });
      if (res.ok) {
        const data = await res.json();
        setReplyText(data.suggestion || "");
      }
    } catch { /* ignore */ }
    finally {
      setGenerating(false);
    }
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
    <div style={styles.container}>
      {/* Conversation list */}
      <div style={styles.list}>
        <div style={styles.listHeader}>Conversations ({conversations.length})</div>
        {conversations.length === 0 ? (
          <div style={styles.empty}>No active conversations</div>
        ) : (
          conversations.map((c) => (
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
                <span style={styles.convUser}>@{c.senderUsername}</span>
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
              <span style={styles.messageHeaderUser}>@{selectedUsername}</span>
              <button onClick={handleArchive} style={styles.archiveBtn}>
                Archive
              </button>
            </div>
            <div style={styles.messageList}>
              {messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    ...styles.bubble,
                    ...(m.sender === "agent" ? styles.bubbleAgent : styles.bubbleUser),
                  }}
                >
                  <div style={styles.bubbleText}>{m.text}</div>
                  <div style={styles.bubbleTime}>{formatTime(m.timestamp)}</div>
                </div>
              ))}
              <div ref={messagesEndRef} />
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
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  style={styles.generateBtn}
                >
                  {generating ? "Generating..." : "AI Reply"}
                </button>
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
  list: {
    width: "260px",
    borderRight: "1px solid #e0e0e0",
    overflowY: "auto",
    flexShrink: 0,
  },
  listHeader: {
    padding: "0.75rem 1rem",
    fontWeight: 600,
    fontSize: "0.85rem",
    borderBottom: "1px solid #f0f0f0",
    background: "#fafafa",
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
