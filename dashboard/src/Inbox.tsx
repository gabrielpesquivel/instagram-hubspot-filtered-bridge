import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "./toast";
import { showAmendment } from "./amendment";
import { showActions } from "./action";

// ── Unified data model ──────────────────────────────────────────────────────
// Both channels collapse to a single InboxItem for the list; the thread view
// branches on `channel`.

type Channel = "instagram" | "email";
type Filter = "all" | Channel;
// IG threads come from two sources: "store" = webhook-approved conversation in
// the Durable Object; "pull" = live unread from the Graph Conversations API.
type Source = "store" | "pull";

interface InboxItem {
  channel: Channel;
  id: string; // IG: senderId · email: threadId
  source?: Source; // IG only
  conversationId?: string; // IG pull: Graph conversation id for the thread view
  title: string; // IG: @username · email: sender name
  subtitle?: string; // email subject
  snippet: string;
  at: number; // epoch ms for sorting
  atLabel: string;
  unread: boolean;
  autoReply?: boolean;
  language?: string;
  isVerified?: boolean; // IG pull flag
  isVip?: boolean; // IG pull flag (verified or high-follower)
}

type Selected = { channel: Channel; id: string; source?: Source; conversationId?: string };

interface IgPullSummary {
  conversationId: string;
  senderId: string;
  username: string;
  snippet: string;
  updatedTime: string;
  unread: boolean;
  isVerified: boolean;
  followerCount?: number;
  isVip: boolean;
}

interface PendingItem {
  id: string;
  senderUsername: string;
  messageText: string;
  followerCount?: number;
  isVerified?: boolean;
  language?: string;
}

interface IgMessage {
  id: string;
  sender: "user" | "agent";
  text: string;
  translation?: string;
  status?: "sent" | "failed";
  timestamp: string;
}

interface EmailImage {
  id: string;
  messageId: string;
  mimeType: string;
  filename: string;
  attachmentId?: string;
  dataUrl?: string;
  label?: string;
}

interface EmailMessage {
  fromUs: boolean;
  fromName: string;
  text: string;
  date: string;
  images?: EmailImage[];
}

// Build the <img> src for an email image: inline data URL, or the attachment
// endpoint (mime passed through for the response Content-Type).
function emailImageSrc(img: EmailImage): string {
  if (img.dataUrl) return img.dataUrl;
  return `/api/email/attachments/${encodeURIComponent(img.messageId)}/${encodeURIComponent(
    img.attachmentId || ""
  )}?mime=${encodeURIComponent(img.mimeType)}`;
}

interface IgSummary {
  senderId: string;
  senderUsername: string;
  lastMessageSnippet: string;
  lastMessageAt: string;
  unread: boolean;
  autoReply?: boolean;
  language?: string;
}

interface EmailSummary {
  threadId: string;
  fromName: string;
  subject: string;
  date: string;
  snippet: string;
}

interface ShopifyOrder {
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  customerName: string;
  email: string;
  totalPrice: string;
  lineItems: { title: string; variantTitle?: string; quantity: number }[];
  tracking: { company?: string; number?: string; url?: string }[];
  shippingCountry?: string;
}

function ts(d: string): number {
  const t = Date.parse(d);
  return isNaN(t) ? 0 : t;
}

function relTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(ms).toLocaleDateString();
}

// "Jane Doe <jane@x.com>" -> "jane@x.com"; bare address -> itself.
function extractEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

// The AI wraps Shopify-derived facts in ⟦ ⟧ (Feature 3). Strip the markers for
// the plain text we send; render them as green spans inside the editable box.
function stripGreenMarkers(s: string): string {
  return s.replace(/⟦|⟧/g, "");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Turn a ⟦…⟧-marked draft into HTML for the contentEditable box: order facts in
// green, everything else plain. Newlines are preserved by the box's pre-wrap.
function buildEditorHtml(marked: string): string {
  return marked
    .split(/(⟦[^⟧]*⟧)/)
    .map((seg) =>
      seg.startsWith("⟦") && seg.endsWith("⟧")
        ? `<span style="color:#15803d;font-weight:600">${escapeHtml(seg.slice(1, -1))}</span>`
        : escapeHtml(seg)
    )
    .join("");
}

export function Inbox() {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const [igConvos, setIgConvos] = useState<IgSummary[]>([]);
  const [igUnread, setIgUnread] = useState<IgPullSummary[]>([]);
  const [emailThreads, setEmailThreads] = useState<EmailSummary[]>([]);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [emailConnected, setEmailConnected] = useState<boolean | null>(null);
  const [emailAddress, setEmailAddress] = useState<string>("");

  const [selected, setSelected] = useState<Selected | null>(null);
  const [igMessages, setIgMessages] = useState<IgMessage[]>([]);
  const [emailMessages, setEmailMessages] = useState<EmailMessage[]>([]);
  const [threadSubject, setThreadSubject] = useState("");
  const [threadTitle, setThreadTitle] = useState("");
  const [threadLang, setThreadLang] = useState("");

  // Shopify order lookup (Feature 1 — agent-driven, in the thread pane)
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [orderQuery, setOrderQuery] = useState("");
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [orderResults, setOrderResults] = useState<ShopifyOrder[]>([]);
  const [autoReply, setAutoReply] = useState(false);
  const [windowExpired, setWindowExpired] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);

  const [draft, setDraft] = useState("");
  // The raw Auto Draft for the current thread (if used) — sent alongside the
  // reply so the backend can learn from any edits the agent made.
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [busyPending, setBusyPending] = useState<string | null>(null);

  // Inline image labelling: which image (by `${messageId}:${id}`) is being
  // edited, and its draft text. Labels are sent to the AI on Auto Draft.
  const [labelEditing, setLabelEditing] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");

  const endRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // The reply box is a contentEditable div (so Shopify facts can render green).
  // It's uncontrolled — we write to its DOM only on programmatic changes (AI
  // draft, clear) and read innerText back into `draft` on input, so typing
  // never resets the cursor. Pass marked text to show green, plain to clear.
  function setEditorContent(text: string, marked = false) {
    if (editorRef.current) {
      editorRef.current.innerHTML = marked ? buildEditorHtml(text) : escapeHtml(text);
    }
    setDraft(stripGreenMarkers(text));
  }

  // ── Data fetching ─────────────────────────────────────────────────────────
  const fetchIg = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      if (res.ok) setIgConvos(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch("/api/pending");
      if (res.ok) setPending(await res.json());
    } catch { /* ignore */ }
  }, []);

  const fetchIgUnread = useCallback(async () => {
    try {
      const res = await fetch("/api/instagram/unread");
      if (res.ok) {
        const data = await res.json();
        // `stale` = the Graph pull transiently failed; keep the current list
        // rather than blanking it (caused threads to disappear then reappear).
        if (!data.stale) setIgUnread(data.threads || []);
      }
    } catch { /* ignore — IG may be disconnected */ }
  }, []);

  const fetchEmail = useCallback(async () => {
    try {
      const res = await fetch("/api/email/threads");
      if (res.ok) {
        const data = await res.json();
        setEmailThreads(
          (data.threads || []).map((t: any) => ({
            threadId: t.threadId,
            fromName: t.fromName,
            subject: t.subject,
            date: t.date,
            snippet: t.snippet,
          }))
        );
      }
    } catch { /* ignore */ }
  }, []);

  // Initial load + email connection probe
  useEffect(() => {
    fetchIg();
    fetchPending();
    fetchIgUnread();
    fetch("/api/email/connection")
      .then((r) => r.json())
      .then((c) => {
        setEmailConnected(!!c.connected);
        setEmailAddress(c.email || "");
        if (c.connected) fetchEmail();
      })
      .catch(() => setEmailConnected(false));
  }, [fetchIg, fetchPending, fetchEmail, fetchIgUnread]);

  // Live IG updates via the DMState WebSocket; slow poll for email (no push).
  useEffect(() => {
    let ws: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type !== "changed") return;
        if (msg.topic === "pending") fetchPending();
        if (msg.topic === "conversations") {
          fetchIg();
          const sel = selectedRef.current;
          if (sel?.channel === "instagram" && sel.source !== "pull") loadThread(sel, true);
        }
      };
      ws.onopen = () => {
        pingTimer = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25_000);
      };
      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (!closed) reconnectTimer = setTimeout(connect, 3000);
      };
    }
    connect();

    // No webhook push for the live IG unread list or email — poll both.
    const pollTimer = setInterval(() => {
      fetchIgUnread();
      if (emailConnected) fetchEmail();
    }, 30_000);

    return () => {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(pollTimer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailConnected]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [igMessages, emailMessages]);

  // ── Thread loading ──────────────────────────────────────────────────────
  async function loadThread(sel: Selected, silent = false) {
    if (!silent) setLoadingThread(true);
    try {
      if (sel.channel === "instagram" && sel.source === "pull") {
        // Live thread straight from the Graph API (no stored conversation yet).
        const res = await fetch(`/api/instagram/threads/${encodeURIComponent(sel.conversationId || "")}`);
        if (res.ok) {
          const data = await res.json();
          setIgMessages(
            (data.messages || []).map((m: { fromUs: boolean; text: string; date: string }, i: number) => ({
              id: "ig-" + i,
              sender: m.fromUs ? "agent" : "user",
              text: m.text,
              timestamp: m.date,
            }))
          );
          setThreadTitle("@" + (data.username || sel.id));
          setThreadLang("");
          setAutoReply(false);
          setWindowExpired(false);
          setThreadSubject("");
        }
      } else if (sel.channel === "instagram") {
        const res = await fetch(`/api/conversations/${encodeURIComponent(sel.id)}`);
        if (res.ok) {
          const data = await res.json();
          setIgMessages(data.messages || []);
          setThreadTitle("@" + data.senderUsername);
          setThreadLang(data.language ?? "");
          setAutoReply(data.autoReply ?? false);
          setWindowExpired(data.windowExpired ?? false);
          setThreadSubject("");
        }
      } else {
        const res = await fetch(`/api/email/threads/${encodeURIComponent(sel.id)}`);
        if (res.ok) {
          const data = await res.json();
          setEmailMessages(data.messages || []);
          setThreadSubject(data.subject || "");
          const lastCustomer = [...(data.messages || [])].reverse().find((m: EmailMessage) => !m.fromUs);
          setThreadTitle(lastCustomer?.fromName || emailThreads.find((t) => t.threadId === sel.id)?.fromName || "Email");
          // Prefill the Shopify lookup with the customer's email address, and on
          // the initial open auto-show their recent orders (Feature 2). Skip on
          // silent poll refreshes so we don't re-fetch on every tick.
          const custEmail = extractEmail(data.replyTo || "");
          setOrderQuery(custEmail);
          if (!silent && custEmail.includes("@")) {
            setOrdersOpen(true);
            lookupOrders(custEmail);
          }
          setThreadLang("");
          setAutoReply(false);
          setWindowExpired(false);
        }
      }
    } catch { /* ignore */ }
    finally {
      if (!silent) setLoadingThread(false);
    }
  }

  function selectItem(item: InboxItem) {
    const sel: Selected = {
      channel: item.channel,
      id: item.id,
      source: item.source,
      conversationId: item.conversationId,
    };
    setSelected(sel);
    setIgMessages([]);
    setEmailMessages([]);
    setEditorContent("");
    setAiSuggestion(null);
    // Reset the order panel. The query is prefilled with the customer email
    // once the email thread loads (see loadThread); IG threads stay blank.
    setOrdersOpen(false);
    setOrderResults([]);
    setOrderError("");
    setOrderQuery("");
    loadThread(sel);
  }

  // Treat a query with an "@" as an email lookup, otherwise an order number.
  // Accepts an explicit query (Feature 2 auto-lookup passes the customer email
  // before the orderQuery state has committed); falls back to the input value.
  async function lookupOrders(queryArg?: string) {
    const q = (queryArg ?? orderQuery).trim();
    if (!q || orderLoading) return;
    setOrderLoading(true);
    setOrderError("");
    setOrderResults([]);
    try {
      const url = q.includes("@")
        ? `/api/shopify/orders?email=${encodeURIComponent(q)}`
        : `/api/shopify/order?name=${encodeURIComponent(q)}`;
      const res = await fetch(url);
      if (res.status === 404) {
        setOrderError("No order found.");
      } else if (!res.ok) {
        setOrderError("Lookup failed.");
      } else {
        const data = await res.json();
        const orders: ShopifyOrder[] = data.orders || (data.order ? [data.order] : []);
        if (!orders.length) setOrderError("No orders found.");
        setOrderResults(orders);
      }
    } catch {
      setOrderError("Network error.");
    } finally {
      setOrderLoading(false);
    }
  }

  // ── Composer actions ────────────────────────────────────────────────────
  async function handleAiDraft() {
    if (!selected || drafting) return;
    setDrafting(true);
    try {
      // IG has two suggest paths: stored conversations key off senderId; live
      // "pull" threads (no stored conversation yet) draft from the Graph thread
      // history via its conversationId.
      const url =
        selected.channel === "instagram"
          ? selected.source === "pull"
            ? `/api/instagram/threads/${encodeURIComponent(selected.conversationId || "")}/suggest`
            : `/api/conversations/${encodeURIComponent(selected.id)}/suggest`
          : `/api/email/threads/${encodeURIComponent(selected.id)}/suggest`;
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.suggestion) {
        const raw: string = data.suggestion;
        // Render green when the AI cited live order data (⟦…⟧), else plain.
        setEditorContent(raw, raw.includes("⟦"));
        setAiSuggestion(stripGreenMarkers(raw));
        if (data.actions?.length) showActions(data.actions);
      } else {
        toast(data.error || "Auto Draft failed");
      }
    } catch {
      toast("Network error — AI draft failed");
    } finally {
      setDrafting(false);
    }
  }

  async function handleSend() {
    if (!selected || !draft.trim() || sending) return;
    const text = draft.trim();
    setSending(true);

    const learnFrom = aiSuggestion;
    setAiSuggestion(null);

    if (selected.channel === "instagram") {
      const optimistic: IgMessage = {
        id: "temp-" + Date.now(),
        sender: "agent",
        text,
        timestamp: new Date().toISOString(),
      };
      setIgMessages((p) => [...p, optimistic]);
      setEditorContent("");
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(selected.id)}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, aiSuggestion: learnFrom || undefined }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (body.failed) {
            toast("Send failed — saved with a retry button");
            loadThread(selected, true);
          } else {
            setIgMessages((p) => p.filter((m) => m.id !== optimistic.id));
            setEditorContent(text);
            toast(body.error || "Send failed");
          }
        } else {
          const ok = await res.json().catch(() => ({}));
          if (ok.amendment) showAmendment(ok.amendment);
          fetchIg();
        }
      } catch {
        setIgMessages((p) => p.filter((m) => m.id !== optimistic.id));
        setEditorContent(text);
        toast("Network error — message not sent");
      } finally {
        setSending(false);
      }
    } else {
      try {
        const res = await fetch(`/api/email/threads/${encodeURIComponent(selected.id)}/reply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, aiSuggestion: learnFrom || undefined }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
          toast("Email sent", "success");
          setEditorContent("");
          setEmailMessages((p) => [
            ...p,
            { fromUs: true, fromName: "You", text, date: new Date().toISOString() },
          ]);
          // Sent threads drop out of the unread queue.
          setEmailThreads((p) => p.filter((t) => t.threadId !== selected.id));
          if (body.amendment) showAmendment(body.amendment);
        } else {
          toast(body.error || "Email send failed");
        }
      } catch {
        toast("Network error — email not sent");
      } finally {
        setSending(false);
      }
    }
  }

  async function handleRetry(messageId: string) {
    if (!selected || retryingId) return;
    setRetryingId(messageId);
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(selected.id)}/messages/${encodeURIComponent(messageId)}/retry`,
        { method: "POST" }
      );
      if (res.ok) {
        toast("Message sent", "success");
        setIgMessages((p) => p.map((m) => (m.id === messageId ? { ...m, status: "sent" } : m)));
      } else {
        const body = await res.json().catch(() => ({}));
        toast(body.error || "Retry failed");
      }
    } catch {
      toast("Network error — retry failed");
    } finally {
      setRetryingId(null);
    }
  }

  async function handleToggleAuto() {
    if (!selected || selected.channel !== "instagram") return;
    const next = !autoReply;
    setAutoReply(next);
    await fetch(`/api/conversations/${encodeURIComponent(selected.id)}/auto-reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    fetchIg();
  }

  async function handleArchive() {
    if (!selected) return;
    if (selected.channel === "instagram") {
      const senderId = selected.id;
      // Mark done so the live pull hides it until the customer messages again…
      fetch("/api/instagram/done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId }),
      }).catch(() => {});
      // …and archive the stored conversation (no-op if a pull thread was never
      // replied to, so it never created one).
      fetch(`/api/conversations/${encodeURIComponent(senderId)}/archive`, { method: "POST" }).catch(() => {});
      setIgUnread((p) => p.filter((u) => u.senderId !== senderId));
      setIgConvos((p) => p.filter((c) => c.senderId !== senderId));
    } else {
      // Email: mark the Gmail thread read so it leaves the unread queue for good
      // (without this it dropped locally but came back on the next poll/refresh).
      const threadId = selected.id;
      fetch(`/api/email/threads/${encodeURIComponent(threadId)}/done`, { method: "POST" }).catch(() => {});
      setEmailThreads((p) => p.filter((t) => t.threadId !== threadId));
    }
    setSelected(null);
  }

  // Save (or clear) an agent's description for one email image, optimistically.
  async function saveImageLabel(img: EmailImage, label: string) {
    if (!selected || selected.channel !== "email") return;
    const threadId = selected.id;
    const trimmed = label.trim();
    setLabelEditing(null);
    setEmailMessages((prev) =>
      prev.map((m) => ({
        ...m,
        images: m.images?.map((g) =>
          g.messageId === img.messageId && g.id === img.id ? { ...g, label: trimmed } : g
        ),
      }))
    );
    try {
      await fetch(`/api/email/threads/${encodeURIComponent(threadId)}/image-label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: img.messageId, imageId: img.id, label: trimmed }),
      });
    } catch {
      toast("Failed to save label");
    }
  }

  // ── Pending approvals ────────────────────────────────────────────────────
  async function pendingAction(id: string, action: "approve" | "reject" | "dismiss") {
    if (busyPending) return;
    setBusyPending(id);
    try {
      await fetch(`/api/pending/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setPending((p) => p.filter((x) => x.id !== id));
      if (action === "approve") fetchIg();
    } catch {
      toast("Action failed");
    } finally {
      setBusyPending(null);
    }
  }

  // ── Build the merged list ────────────────────────────────────────────────
  const items: InboxItem[] = [];
  const storeSenderIds = new Set(igConvos.map((c) => c.senderId));
  for (const c of igConvos) {
    items.push({
      channel: "instagram",
      id: c.senderId,
      source: "store",
      title: "@" + c.senderUsername,
      snippet: c.lastMessageSnippet,
      at: ts(c.lastMessageAt),
      atLabel: relTime(ts(c.lastMessageAt)),
      unread: c.unread,
      autoReply: c.autoReply,
      language: c.language,
    });
  }
  // Live unread DMs pulled from the Graph API — skip any the store already has.
  for (const u of igUnread) {
    if (storeSenderIds.has(u.senderId)) continue;
    items.push({
      channel: "instagram",
      id: u.senderId,
      source: "pull",
      conversationId: u.conversationId,
      title: "@" + u.username,
      snippet: u.snippet,
      at: ts(u.updatedTime),
      atLabel: relTime(ts(u.updatedTime)),
      unread: u.unread,
      isVerified: u.isVerified,
      isVip: u.isVip,
    });
  }
  for (const t of emailThreads) {
    items.push({
      channel: "email",
      id: t.threadId,
      title: t.fromName || "(unknown sender)",
      subtitle: t.subject,
      snippet: t.snippet,
      at: ts(t.date),
      atLabel: relTime(ts(t.date)),
      unread: true, // email list is unread-only
    });
  }

  // Only surface conversations active in the last 48 hours.
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const recent = items.filter((i) => i.at >= cutoff);

  const q = search.trim().toLowerCase();
  const visible = recent
    .filter((i) => filter === "all" || i.channel === filter)
    .filter(
      (i) =>
        !q ||
        i.title.toLowerCase().includes(q) ||
        i.snippet.toLowerCase().includes(q) ||
        (i.subtitle || "").toLowerCase().includes(q)
    )
    .sort((a, b) => b.at - a.at);

  const showApproval = (filter === "all" || filter === "instagram") && pending.length > 0;
  const igCount = recent.filter((i) => i.channel === "instagram").length;
  const emailCount = recent.filter((i) => i.channel === "email").length;

  const composerDisabled = windowExpired && selected?.channel === "instagram";

  return (
    <div style={styles.root}>
      {/* ── Sidebar ── */}
      <aside style={styles.sidebar}>
        <div style={styles.filters}>
          {([
            ["all", "All", igCount + emailCount],
            ["instagram", "Instagram", igCount],
            ["email", "Email", emailCount],
          ] as [Filter, string, number][]).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              style={{ ...styles.filterPill, ...(filter === key ? styles.filterPillActive : {}) }}
            >
              {label}
              {count > 0 && (
                <span style={{ ...styles.pillCount, ...(filter === key ? styles.pillCountActive : {}) }}>
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search conversations…"
          style={styles.search}
        />

        <div style={styles.list}>
          {showApproval && (
            <>
              <div style={styles.sectionLabel}>Needs approval</div>
              {pending.map((p) => (
                <div key={p.id} style={styles.approvalCard}>
                  <div style={styles.approvalTop}>
                    <span style={styles.approvalUser}>@{p.senderUsername}</span>
                    <span style={styles.chBadgeIg}>IG</span>
                  </div>
                  {(p.followerCount != null || p.isVerified) && (
                    <div style={styles.approvalMeta}>
                      {p.isVerified && "✔ verified · "}
                      {p.followerCount != null && `${p.followerCount.toLocaleString()} followers`}
                    </div>
                  )}
                  <div style={styles.approvalText}>{p.messageText}</div>
                  <div style={styles.approvalBtns}>
                    <button
                      style={styles.approveBtn}
                      disabled={busyPending === p.id}
                      onClick={() => pendingAction(p.id, "approve")}
                    >
                      Approve
                    </button>
                    <button
                      style={styles.dismissBtn}
                      disabled={busyPending === p.id}
                      onClick={() => pendingAction(p.id, "dismiss")}
                    >
                      Dismiss
                    </button>
                    <button
                      style={styles.rejectBtn}
                      disabled={busyPending === p.id}
                      onClick={() => pendingAction(p.id, "reject")}
                      title="Reject & block sender"
                    >
                      Block
                    </button>
                  </div>
                </div>
              ))}
              {visible.length > 0 && <div style={styles.sectionLabel}>Conversations</div>}
            </>
          )}

          {visible.length === 0 && !showApproval ? (
            <div style={styles.empty}>
              {filter === "email" && emailConnected === false
                ? "Gmail not connected"
                : "Nothing here"}
            </div>
          ) : (
            visible.map((i) => {
              const active = selected?.channel === i.channel && selected.id === i.id;
              return (
                <button
                  key={i.channel + i.id}
                  onClick={() => selectItem(i)}
                  style={{
                    ...styles.itemCard,
                    ...(active ? styles.itemCardActive : {}),
                    ...(i.unread && !active ? styles.itemCardUnread : {}),
                  }}
                >
                  <div style={styles.itemTop}>
                    <span style={styles.itemTitle}>
                      <span style={i.channel === "instagram" ? styles.chDotIg : styles.chDotEmail} />
                      {i.title}
                    </span>
                    <span style={styles.itemTime}>{i.atLabel}</span>
                  </div>
                  {i.subtitle && <div style={styles.itemSubject}>{i.subtitle}</div>}
                  <div style={styles.itemSnippet}>{i.snippet}</div>
                  <div style={styles.itemBadges}>
                    {i.isVerified && <span style={styles.vipBadge}>✔ verified</span>}
                    {i.isVip && !i.isVerified && <span style={styles.vipBadge}>VIP</span>}
                    {i.language && <span style={styles.langBadge}>{i.language}</span>}
                    {i.autoReply && <span style={styles.aiBadge}>AI auto</span>}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Thread ── */}
      <main style={styles.thread}>
        {!selected ? (
          <div style={styles.noSel}>
            <div style={styles.noSelInner}>
              <div style={styles.noSelTitle}>Select a conversation</div>
              <div style={styles.noSelSub}>Instagram DMs and emails, all in one place.</div>
            </div>
          </div>
        ) : (
          <>
            <header style={styles.threadHeader}>
              <div style={{ minWidth: 0 }}>
                <div style={styles.threadTitle}>
                  <span style={selected.channel === "instagram" ? styles.chDotIg : styles.chDotEmail} />
                  {threadTitle}
                  {threadLang && <span style={styles.langBadge}>{threadLang}</span>}
                </div>
                {threadSubject && <div style={styles.threadSubject}>{threadSubject}</div>}
              </div>
              <div style={styles.threadActions}>
                {selected.channel === "instagram" && (
                  <button
                    onClick={handleToggleAuto}
                    style={{ ...styles.autoBtn, ...(autoReply ? styles.autoBtnOn : {}) }}
                  >
                    {autoReply ? "AI auto ON" : "AI auto OFF"}
                  </button>
                )}
                <button
                  onClick={() => setOrdersOpen((o) => !o)}
                  style={{ ...styles.autoBtn, ...(ordersOpen ? styles.autoBtnOn : {}) }}
                >
                  🛍 Orders
                </button>
                <button onClick={handleArchive} style={styles.doneBtn}>
                  ✓ Done
                </button>
              </div>
            </header>

            {ordersOpen && (
              <div style={styles.ordersPanel}>
                <div style={styles.ordersInputRow}>
                  <input
                    style={styles.ordersInput}
                    placeholder="Order # or email"
                    value={orderQuery}
                    onChange={(e) => setOrderQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && lookupOrders()}
                  />
                  <button
                    onClick={() => lookupOrders()}
                    disabled={orderLoading || !orderQuery.trim()}
                    style={styles.ordersBtn}
                  >
                    {orderLoading ? "…" : "Look up"}
                  </button>
                </div>
                {orderError && <div style={styles.ordersError}>{orderError}</div>}
                {orderResults.map((o) => (
                  <div key={o.name} style={styles.orderCard}>
                    <div style={styles.orderTop}>
                      <span style={styles.orderName}>{o.name}</span>
                      <span style={styles.orderStatus}>
                        {o.fulfillmentStatus} · {o.financialStatus}
                      </span>
                    </div>
                    <div style={styles.orderMeta}>
                      {o.customerName}
                      {o.totalPrice ? ` · ${o.totalPrice}` : ""}
                      {o.shippingCountry ? ` · ${o.shippingCountry}` : ""}
                      {o.createdAt ? ` · ${new Date(o.createdAt).toLocaleDateString()}` : ""}
                    </div>
                    {o.lineItems.length > 0 && (
                      <div style={styles.orderItems}>
                        {o.lineItems.map((li, i) => (
                          <div key={i}>
                            {li.quantity}× {li.title}
                            {li.variantTitle ? ` — ${li.variantTitle}` : ""}
                          </div>
                        ))}
                      </div>
                    )}
                    {o.tracking.length > 0 && (
                      <div style={styles.orderTracking}>
                        {o.tracking.map((t, i) => (
                          <div key={i}>
                            {t.company ? `${t.company}: ` : "Tracking: "}
                            {t.url ? (
                              <a href={t.url} target="_blank" rel="noreferrer" style={styles.trackLink}>
                                {t.number || "track"}
                              </a>
                            ) : (
                              t.number || ""
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div style={styles.messages}>
              {loadingThread ? (
                <div style={styles.loading}>Loading…</div>
              ) : selected.channel === "instagram" ? (
                igMessages.map((m) => (
                  <div
                    key={m.id}
                    style={{ ...styles.row, ...(m.sender === "agent" ? styles.rowEnd : {}) }}
                  >
                    <div
                      style={{
                        ...styles.bubble,
                        ...(m.sender === "agent" ? styles.bubbleUs : styles.bubbleThem),
                      }}
                    >
                      <div style={styles.bubbleText}>{m.text}</div>
                      {m.translation && <div style={styles.translation}>{m.translation}</div>}
                      <div style={styles.bubbleTime}>{relTime(ts(m.timestamp))}</div>
                      {m.status === "failed" && (
                        <div style={styles.failedRow}>
                          <span style={styles.failedBadge}>not sent</span>
                          <button
                            onClick={() => handleRetry(m.id)}
                            disabled={retryingId === m.id}
                            style={styles.retryBtn}
                          >
                            {retryingId === m.id ? "…" : "Retry"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                emailMessages.map((m, idx) => (
                  <div key={idx} style={{ ...styles.row, ...(m.fromUs ? styles.rowEnd : {}) }}>
                    <div
                      style={{
                        ...styles.emailBubble,
                        ...(m.fromUs ? styles.bubbleUs : styles.bubbleThem),
                      }}
                    >
                      <div style={styles.emailFrom}>{m.fromUs ? "You" : m.fromName}</div>
                      {m.text && <div style={styles.bubbleText}>{m.text}</div>}
                      {m.images && m.images.length > 0 && (
                        <div style={styles.emailImages}>
                          {m.images.map((img, ii) => {
                            const key = `${img.messageId}:${img.id}`;
                            const editing = labelEditing === key;
                            return (
                              <div key={ii} style={styles.emailImageWrap}>
                                <a href={emailImageSrc(img)} target="_blank" rel="noreferrer" title={img.filename}>
                                  <img src={emailImageSrc(img)} alt={img.filename} style={styles.emailImage} />
                                </a>
                                {/* Labels only on customer images — that's what the AI considers. */}
                                {!m.fromUs &&
                                  (editing ? (
                                    <input
                                      autoFocus
                                      value={labelDraft}
                                      placeholder="Describe this image…"
                                      onChange={(e) => setLabelDraft(e.target.value)}
                                      onBlur={() => saveImageLabel(img, labelDraft)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") saveImageLabel(img, labelDraft);
                                        if (e.key === "Escape") setLabelEditing(null);
                                      }}
                                      style={styles.imgLabelInput}
                                    />
                                  ) : (
                                    <button
                                      onClick={() => {
                                        setLabelEditing(key);
                                        setLabelDraft(img.label || "");
                                      }}
                                      style={img.label ? styles.imgLabelText : styles.imgLabelAdd}
                                      title="Describe this image for the AI"
                                    >
                                      {img.label ? `🏷 ${img.label}` : "+ Label"}
                                    </button>
                                  ))}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div style={styles.bubbleTime}>{relTime(ts(m.date))}</div>
                    </div>
                  </div>
                ))
              )}
              {!loadingThread && <div ref={endRef} />}
            </div>

            <div style={styles.composer}>
              {composerDisabled && (
                <div style={styles.windowNote}>
                  24h window expired — manual reply only (Human Agent tag).
                </div>
              )}
              <div
                ref={editorRef}
                className="ce-editor"
                contentEditable
                suppressContentEditableWarning
                data-placeholder={selected.channel === "email" ? "Write a reply…" : "Type a message…"}
                onInput={(e) => setDraft(e.currentTarget.innerText)}
                style={{
                  ...styles.textarea,
                  minHeight: selected.channel === "email" ? "7.5rem" : "4.5rem",
                  whiteSpace: "pre-wrap",
                  overflowY: "auto",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && selected.channel === "instagram") {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div style={styles.composerBtns}>
                <button
                  onClick={handleAiDraft}
                  disabled={drafting || composerDisabled}
                  style={styles.aiDraftBtn}
                >
                  {drafting ? "Drafting…" : "Auto Draft"}
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending || !draft.trim()}
                  style={styles.sendBtn}
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
// Neutrals come from the theme tokens in theme.css (var(--…)); accent colors
// (channel pink/blue, action green/red/purple) stay fixed across themes.
const BORDER = "var(--border)";
const IG = "#d6249f";
const EMAIL = "#1a73e8";

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", height: "100%", background: "var(--surface)", minHeight: 0 },

  sidebar: {
    width: "340px",
    flexShrink: 0,
    borderRight: `1px solid ${BORDER}`,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  filters: { display: "flex", gap: "0.3rem", padding: "0.75rem 0.75rem 0.5rem", flexWrap: "wrap" },
  filterPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    padding: "0.3rem 0.7rem",
    border: `1px solid ${BORDER}`,
    background: "var(--surface)",
    borderRadius: "999px",
    fontSize: "0.78rem",
    fontWeight: 600,
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  filterPillActive: { background: "var(--text)", color: "var(--bg)", borderColor: "var(--text)" },
  pillCount: {
    fontSize: "0.68rem",
    fontWeight: 700,
    background: "var(--surface-3)",
    color: "var(--text-muted)",
    borderRadius: "999px",
    padding: "0 0.4rem",
    minWidth: "1.1rem",
    textAlign: "center",
  },
  pillCountActive: { background: "rgba(127,127,127,0.35)", color: "inherit" },

  search: {
    margin: "0 0.75rem 0.5rem",
    padding: "0.5rem 0.75rem",
    border: `1px solid ${BORDER}`,
    background: "var(--surface)",
    color: "var(--text)",
    borderRadius: "8px",
    fontSize: "0.85rem",
    outline: "none",
  },

  list: { flex: 1, overflowY: "auto", padding: "0 0.5rem 1rem", minHeight: 0 },
  sectionLabel: {
    fontSize: "0.68rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--text-faint)",
    padding: "0.6rem 0.5rem 0.3rem",
  },
  empty: { padding: "2.5rem 1rem", textAlign: "center", color: "var(--text-faint)", fontSize: "0.85rem" },

  // Approval cards
  approvalCard: {
    border: `1px solid var(--border-strong)`,
    background: "var(--surface-2)",
    borderRadius: "10px",
    padding: "0.6rem 0.7rem",
    margin: "0.25rem 0.25rem 0.5rem",
  },
  approvalTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  approvalUser: { fontWeight: 700, fontSize: "0.85rem", color: "var(--text)" },
  approvalMeta: { fontSize: "0.7rem", color: "#c08a3f", marginTop: "2px" },
  approvalText: {
    fontSize: "0.8rem",
    color: "var(--text-muted)",
    margin: "0.4rem 0 0.5rem",
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  approvalBtns: { display: "flex", gap: "0.35rem" },
  approveBtn: {
    flex: 1, padding: "0.35rem", background: "#16a34a", color: "#fff", border: "none",
    borderRadius: "6px", fontSize: "0.75rem", fontWeight: 700, cursor: "pointer",
  },
  dismissBtn: {
    flex: 1, padding: "0.35rem", background: "var(--surface)", color: "var(--text-muted)", border: `1px solid ${BORDER}`,
    borderRadius: "6px", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer",
  },
  rejectBtn: {
    padding: "0.35rem 0.6rem", background: "var(--surface)", color: "#e05555", border: "1px solid #b5535355",
    borderRadius: "6px", fontSize: "0.75rem", fontWeight: 600, cursor: "pointer",
  },

  // Conversation items
  itemCard: {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "none",
    border: "none",
    borderRadius: "10px",
    padding: "0.6rem 0.7rem",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  itemCardActive: { background: "var(--surface-3)" },
  itemCardUnread: { background: "var(--surface-2)" },
  itemTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" },
  itemTitle: {
    display: "flex", alignItems: "center", gap: "0.4rem",
    fontWeight: 700, fontSize: "0.85rem", color: "var(--text)",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  itemTime: { fontSize: "0.7rem", color: "var(--text-faint)", flexShrink: 0 },
  itemSubject: { fontSize: "0.78rem", fontWeight: 600, color: "var(--text)", marginTop: "1px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  itemSnippet: {
    fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "1px",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  itemBadges: { display: "flex", gap: "0.3rem", marginTop: "0.3rem" },

  chDotIg: { width: "8px", height: "8px", borderRadius: "50%", background: IG, flexShrink: 0 },
  chDotEmail: { width: "8px", height: "8px", borderRadius: "50%", background: EMAIL, flexShrink: 0 },
  chBadgeIg: { fontSize: "0.6rem", fontWeight: 700, color: "#fff", background: IG, padding: "1px 5px", borderRadius: "4px" },

  vipBadge: { fontSize: "0.6rem", fontWeight: 700, background: "#fde68a", color: "#92400e", padding: "1px 5px", borderRadius: "4px" },
  langBadge: { fontSize: "0.6rem", fontWeight: 700, background: "var(--surface-3)", color: "var(--text-muted)", padding: "1px 5px", borderRadius: "4px" },
  aiBadge: { fontSize: "0.6rem", fontWeight: 700, background: "#5e35b1", color: "#fff", padding: "1px 5px", borderRadius: "4px" },

  // Shopify orders panel
  ordersPanel: { padding: "0.75rem 1.25rem", borderBottom: `1px solid ${BORDER}`, background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: "0.5rem" },
  ordersInputRow: { display: "flex", gap: "0.5rem" },
  ordersInput: { flex: 1, padding: "0.4rem 0.6rem", border: `1px solid ${BORDER}`, borderRadius: "6px", background: "var(--surface)", color: "var(--text)", fontSize: "0.85rem" },
  ordersBtn: { padding: "0.4rem 0.9rem", border: "none", borderRadius: "6px", background: "#5b21b6", color: "#fff", fontWeight: 700, fontSize: "0.8rem", cursor: "pointer" },
  ordersError: { fontSize: "0.8rem", color: "var(--text-muted)" },
  orderCard: { border: `1px solid ${BORDER}`, borderRadius: "8px", padding: "0.6rem 0.75rem", background: "var(--surface)", display: "flex", flexDirection: "column", gap: "0.25rem" },
  orderTop: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" },
  orderName: { fontWeight: 700, fontSize: "0.9rem", color: "var(--text)" },
  orderStatus: { fontSize: "0.7rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" },
  orderMeta: { fontSize: "0.78rem", color: "var(--text-muted)" },
  orderItems: { fontSize: "0.78rem", color: "var(--text)", display: "flex", flexDirection: "column", gap: "0.1rem" },
  orderTracking: { fontSize: "0.78rem", color: "var(--text)" },
  trackLink: { color: "#5b21b6", fontWeight: 600 },

  // Thread pane
  thread: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  noSel: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  noSelInner: { textAlign: "center" },
  noSelTitle: { fontSize: "1rem", fontWeight: 600, color: "var(--text-muted)" },
  noSelSub: { fontSize: "0.85rem", color: "var(--text-faint)", marginTop: "0.3rem" },

  threadHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem",
    padding: "0.75rem 1.25rem", borderBottom: `1px solid ${BORDER}`,
  },
  threadTitle: { display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700, fontSize: "0.95rem", color: "var(--text)" },
  threadSubject: { fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  threadActions: { display: "flex", gap: "0.4rem", flexShrink: 0 },
  autoBtn: {
    padding: "0.3rem 0.7rem", background: "var(--surface)", border: `1px solid ${BORDER}`, borderRadius: "7px",
    fontSize: "0.72rem", fontWeight: 700, color: "var(--text-muted)", cursor: "pointer",
  },
  autoBtnOn: { background: "#5e35b1", color: "#fff", borderColor: "#5e35b1" },
  archiveBtn: {
    padding: "0.3rem 0.8rem", background: "var(--surface)", border: `1px solid ${BORDER}`, borderRadius: "7px",
    fontSize: "0.72rem", fontWeight: 600, color: "var(--text-muted)", cursor: "pointer",
  },
  doneBtn: {
    padding: "0.3rem 0.85rem", background: "#16a34a", border: "1px solid #16a34a", borderRadius: "7px",
    fontSize: "0.72rem", fontWeight: 700, color: "#fff", cursor: "pointer",
  },

  messages: { flex: 1, overflowY: "auto", padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.5rem", minHeight: 0, background: "var(--surface-2)" },
  loading: { margin: "auto", color: "var(--text-faint)", fontSize: "0.85rem" },
  row: { display: "flex", maxWidth: "78%", alignSelf: "flex-start" },
  rowEnd: { alignSelf: "flex-end" },
  bubble: { padding: "0.5rem 0.8rem", borderRadius: "14px", fontSize: "0.88rem", lineHeight: 1.45, wordBreak: "break-word" },
  emailBubble: { padding: "0.7rem 0.9rem", borderRadius: "14px", fontSize: "0.88rem", lineHeight: 1.5, wordBreak: "break-word", maxWidth: "100%" },
  bubbleThem: { background: "var(--surface)", color: "var(--text)", border: `1px solid ${BORDER}` },
  bubbleUs: { background: "#2563eb", color: "#fff" },
  bubbleText: { whiteSpace: "pre-wrap" },
  emailFrom: { fontSize: "0.68rem", fontWeight: 700, opacity: 0.65, marginBottom: "0.2rem" },
  emailImages: { display: "flex", flexWrap: "wrap", gap: "0.6rem", marginTop: "0.4rem" },
  emailImageWrap: { display: "flex", flexDirection: "column", gap: "0.25rem", maxWidth: "160px" },
  emailImage: {
    maxWidth: "160px", maxHeight: "160px", borderRadius: "8px",
    border: "1px solid rgba(127,127,127,0.3)", objectFit: "cover", display: "block", cursor: "zoom-in",
  },
  imgLabelAdd: {
    background: "none", border: "1px dashed rgba(127,127,127,0.5)", borderRadius: "6px",
    color: "var(--text-faint)", fontSize: "0.68rem", fontWeight: 600, padding: "0.2rem 0.4rem",
    cursor: "pointer", fontFamily: "inherit", textAlign: "center",
  },
  imgLabelText: {
    background: "rgba(127,127,127,0.12)", border: "none", borderRadius: "6px",
    color: "var(--text)", fontSize: "0.68rem", fontWeight: 600, padding: "0.2rem 0.4rem",
    cursor: "pointer", fontFamily: "inherit", textAlign: "left", wordBreak: "break-word",
  },
  imgLabelInput: {
    width: "160px", boxSizing: "border-box", padding: "0.25rem 0.4rem",
    border: "1px solid var(--border-strong)", borderRadius: "6px",
    background: "var(--surface)", color: "var(--text)", fontSize: "0.7rem", outline: "none",
  },
  translation: { fontSize: "0.78rem", fontStyle: "italic", opacity: 0.7, marginTop: "3px", paddingTop: "3px", borderTop: "1px solid rgba(127,127,127,0.25)" },
  bubbleTime: { fontSize: "0.62rem", opacity: 0.6, marginTop: "3px", textAlign: "right" },
  failedRow: { display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.35rem" },
  failedBadge: { fontSize: "0.6rem", fontWeight: 700, background: "var(--surface)", color: "#d32f2f", border: "1px solid #d32f2f", padding: "1px 5px", borderRadius: "3px", textTransform: "uppercase" },
  retryBtn: { padding: "0.15rem 0.6rem", background: "#d32f2f", color: "#fff", border: "none", borderRadius: "3px", cursor: "pointer", fontSize: "0.65rem", fontWeight: 700 },

  composer: { borderTop: `1px solid ${BORDER}`, padding: "0.75rem 1rem", background: "var(--surface)" },
  windowNote: { fontSize: "0.72rem", color: "#e65100", fontWeight: 600, marginBottom: "0.5rem" },
  textarea: {
    width: "100%", padding: "0.6rem 0.75rem", border: `1px solid ${BORDER}`, borderRadius: "10px",
    background: "var(--surface)", color: "var(--text)",
    fontSize: "0.88rem", resize: "none", outline: "none", fontFamily: "inherit", boxSizing: "border-box", lineHeight: 1.45,
  },
  composerBtns: { display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "0.5rem" },
  aiDraftBtn: {
    padding: "0.45rem 0.9rem", background: "var(--surface)", color: "#7e57c2", border: "1px solid #7e57c266",
    borderRadius: "8px", fontSize: "0.8rem", fontWeight: 700, cursor: "pointer",
  },
  sendBtn: {
    padding: "0.45rem 1.3rem", background: "#2563eb", color: "#fff", border: "none",
    borderRadius: "8px", fontSize: "0.8rem", fontWeight: 700, cursor: "pointer",
  },
};
