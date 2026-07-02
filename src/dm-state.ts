import { DurableObject } from "cloudflare:workers";
import type { Env, Conversation, ConversationMessage, ConversationSummary } from "./types";
import type { PendingMessage } from "./services/pending";
import type { BlocklistEntry } from "./services/blocklist";
import type { LogEntry, StatsData } from "./services/stats";
import type { ConsoleLogEntry } from "./services/logger";

const MAX_EVENT_LOG = 50;
const MAX_CONSOLE_LOG = 100;
const MAX_MESSAGES_PER_CONVERSATION = 200;
const SEEN_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_STAT_RETENTION_DAYS = 90;

const STAT_KEYS = [
  "pending",
  "forwarded",
  "skipped:verified",
  "skipped:high_followers",
  "skipped:blocklisted",
  "replied",
  "errors",
];

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Single Durable Object instance ("main") that owns all mutable shared state:
 * pending queue, conversations + index, blocklist, stats, logs, webhook dedup.
 *
 * DO execution is serialized per object, so the read-modify-write patterns
 * that raced on KV are safe here. Also fans out a WebSocket "changed" ping to
 * connected dashboards on every mutation so they refetch immediately.
 *
 * Existing KV data is lazily migrated on first access.
 */
export class DMState extends DurableObject<Env> {
  private migrated = false;

  // ---------- migration ----------

  private async ensureMigrated(): Promise<void> {
    if (this.migrated) return;
    const flag = await this.ctx.storage.get("migrated_v1");
    if (flag) {
      this.migrated = true;
      return;
    }

    const kv = this.env.PROFILE_CACHE;
    try {
      const [pending, index, blocklist, eventLog, consoleLogs] = await Promise.all([
        kv.get("pending_messages"),
        kv.get("conversations_index"),
        kv.get("blocklist"),
        kv.get("event_log"),
        kv.get("console_logs"),
      ]);

      if (pending) await this.ctx.storage.put("pending", JSON.parse(pending));
      if (blocklist) await this.ctx.storage.put("blocklist", JSON.parse(blocklist));
      if (eventLog) await this.ctx.storage.put("event_log", JSON.parse(eventLog));
      if (consoleLogs) await this.ctx.storage.put("console_logs", JSON.parse(consoleLogs));

      if (index) {
        const summaries = JSON.parse(index) as ConversationSummary[];
        await this.ctx.storage.put("index", summaries);
        for (const s of summaries) {
          const conv = await kv.get(`conv:${s.senderId}`);
          if (conv) await this.ctx.storage.put(`conv:${s.senderId}`, JSON.parse(conv));
        }
      }

      const today = todayKey();
      for (const key of STAT_KEYS) {
        const [total, daily] = await Promise.all([
          kv.get(`stats:${key}`),
          kv.get(`stats:${key}:${today}`),
        ]);
        if (total) await this.ctx.storage.put(`stat:${key}`, parseInt(total, 10) || 0);
        if (daily) await this.ctx.storage.put(`stat:${key}:${today}`, parseInt(daily, 10) || 0);
      }
    } catch (err) {
      // Migration is best-effort; never block operation on legacy data
      console.error("DMState migration error:", err);
    }

    await this.ctx.storage.put("migrated_v1", Date.now());
    this.migrated = true;
  }

  // ---------- websocket push ----------

  async fetch(request: Request): Promise<Response> {
    // Only used for WebSocket upgrades (auth happens in the worker route)
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  private broadcast(topic: string): void {
    const payload = JSON.stringify({ type: "changed", topic, at: Date.now() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        /* stale socket */
      }
    }
  }

  // ---------- pending queue ----------

  async addPending(msg: Omit<PendingMessage, "id" | "timestamp">): Promise<PendingMessage> {
    await this.ensureMigrated();
    const entry: PendingMessage = {
      ...msg,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
    const list = ((await this.ctx.storage.get("pending")) as PendingMessage[]) || [];
    list.push(entry);
    await this.ctx.storage.put("pending", list);
    this.broadcast("pending");
    return entry;
  }

  async listPending(): Promise<PendingMessage[]> {
    await this.ensureMigrated();
    return ((await this.ctx.storage.get("pending")) as PendingMessage[]) || [];
  }

  async removePending(id: string): Promise<PendingMessage | null> {
    await this.ensureMigrated();
    const list = ((await this.ctx.storage.get("pending")) as PendingMessage[]) || [];
    const idx = list.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const [removed] = list.splice(idx, 1);
    await this.ctx.storage.put("pending", list);
    this.broadcast("pending");
    return removed;
  }

  async removePendingBySender(senderId: string): Promise<PendingMessage[]> {
    await this.ensureMigrated();
    const list = ((await this.ctx.storage.get("pending")) as PendingMessage[]) || [];
    const removed = list.filter((m) => m.senderId === senderId);
    if (removed.length > 0) {
      await this.ctx.storage.put(
        "pending",
        list.filter((m) => m.senderId !== senderId)
      );
      this.broadcast("pending");
    }
    return removed;
  }

  async clearPending(): Promise<number> {
    await this.ensureMigrated();
    const list = ((await this.ctx.storage.get("pending")) as PendingMessage[]) || [];
    await this.ctx.storage.put("pending", []);
    if (list.length > 0) this.broadcast("pending");
    return list.length;
  }

  /** Atomic snapshot-and-clear: callers that process the queue slowly (e.g.
   *  approve-all with per-message translation) must drain first so messages
   *  arriving mid-processing aren't wiped by a later clear. */
  async drainPending(): Promise<PendingMessage[]> {
    await this.ensureMigrated();
    const list = ((await this.ctx.storage.get("pending")) as PendingMessage[]) || [];
    await this.ctx.storage.put("pending", []);
    if (list.length > 0) this.broadcast("pending");
    return list;
  }

  // ---------- conversations ----------

  private async getIndex(): Promise<ConversationSummary[]> {
    return ((await this.ctx.storage.get("index")) as ConversationSummary[]) || [];
  }

  async getConversation(senderId: string): Promise<Conversation | null> {
    await this.ensureMigrated();
    const conv = (await this.ctx.storage.get(`conv:${senderId}`)) as Conversation | undefined;
    if (!conv) return null;
    if (conv.autoReply === undefined) conv.autoReply = false;
    return conv;
  }

  async addMessage(
    senderId: string,
    senderUsername: string,
    text: string,
    sender: "user" | "agent",
    translation?: string,
    status?: "sent" | "failed"
  ): Promise<ConversationMessage> {
    await this.ensureMigrated();
    const now = new Date().toISOString();
    let conv = (await this.ctx.storage.get(`conv:${senderId}`)) as Conversation | undefined;
    if (!conv) {
      conv = {
        senderId,
        senderUsername,
        messages: [],
        autoReply: false,
        createdAt: now,
        updatedAt: now,
      };
    }

    const msg: ConversationMessage = {
      id: crypto.randomUUID(),
      sender,
      text,
      ...(translation ? { translation } : {}),
      ...(status ? { status } : {}),
      timestamp: now,
    };
    conv.messages.push(msg);
    if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
      conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
    }
    conv.updatedAt = now;
    await this.ctx.storage.put(`conv:${senderId}`, conv);

    // Update index in the same serialized execution — no race
    const index = await this.getIndex();
    const existing = index.find((s) => s.senderId === senderId);
    if (existing) {
      existing.lastMessageSnippet = text.slice(0, 80);
      existing.lastMessageAt = now;
      existing.senderUsername = senderUsername;
      if (sender === "user") existing.unread = true;
      if (existing.status === "archived") existing.status = "active";
    } else {
      index.push({
        senderId,
        senderUsername,
        lastMessageSnippet: text.slice(0, 80),
        lastMessageAt: now,
        unread: sender === "user",
        autoReply: false,
        status: "active",
      });
    }
    await this.ctx.storage.put("index", index);
    this.broadcast("conversations");
    return msg;
  }

  async setMessageStatus(
    senderId: string,
    messageId: string,
    status: "sent" | "failed"
  ): Promise<boolean> {
    await this.ensureMigrated();
    const conv = (await this.ctx.storage.get(`conv:${senderId}`)) as Conversation | undefined;
    if (!conv) return false;
    const msg = conv.messages.find((m) => m.id === messageId);
    if (!msg) return false;
    msg.status = status;
    await this.ctx.storage.put(`conv:${senderId}`, conv);
    this.broadcast("conversations");
    return true;
  }

  async deleteMessage(senderId: string, messageId: string): Promise<boolean> {
    await this.ensureMigrated();
    const conv = (await this.ctx.storage.get(`conv:${senderId}`)) as Conversation | undefined;
    if (!conv) return false;
    const idx = conv.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    conv.messages.splice(idx, 1);
    await this.ctx.storage.put(`conv:${senderId}`, conv);
    this.broadcast("conversations");
    return true;
  }

  async listConversations(): Promise<ConversationSummary[]> {
    await this.ensureMigrated();
    const index = await this.getIndex();
    return index
      .filter((s) => s.status === "active")
      .sort(
        (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
      );
  }

  async archiveConversation(senderId: string): Promise<boolean> {
    await this.ensureMigrated();
    const index = await this.getIndex();
    const entry = index.find((s) => s.senderId === senderId);
    if (!entry) return false;
    entry.status = "archived";
    await this.ctx.storage.put("index", index);
    this.broadcast("conversations");
    return true;
  }

  async markConversationRead(senderId: string): Promise<void> {
    await this.ensureMigrated();
    const index = await this.getIndex();
    const entry = index.find((s) => s.senderId === senderId);
    if (entry && entry.unread) {
      entry.unread = false;
      await this.ctx.storage.put("index", index);
      this.broadcast("conversations");
    }
  }

  async setAutoReply(senderId: string, enabled: boolean): Promise<boolean> {
    await this.ensureMigrated();
    const conv = (await this.ctx.storage.get(`conv:${senderId}`)) as Conversation | undefined;
    if (!conv) return false;
    conv.autoReply = enabled;
    await this.ctx.storage.put(`conv:${senderId}`, conv);

    const index = await this.getIndex();
    const entry = index.find((s) => s.senderId === senderId);
    if (entry) {
      entry.autoReply = enabled;
      await this.ctx.storage.put("index", index);
    }
    this.broadcast("conversations");
    return true;
  }

  async setConversationLanguage(senderId: string, language: string): Promise<void> {
    await this.ensureMigrated();
    const conv = (await this.ctx.storage.get(`conv:${senderId}`)) as Conversation | undefined;
    if (!conv) return;
    conv.language = language;
    await this.ctx.storage.put(`conv:${senderId}`, conv);

    const index = await this.getIndex();
    const entry = index.find((s) => s.senderId === senderId);
    if (entry) {
      entry.language = language;
      await this.ctx.storage.put("index", index);
    }
  }

  async clearAllConversations(): Promise<number> {
    await this.ensureMigrated();
    const index = await this.getIndex();
    const active = index.filter((s) => s.status === "active");
    for (const entry of active) {
      await this.ctx.storage.delete(`conv:${entry.senderId}`);
    }
    await this.ctx.storage.put(
      "index",
      index.filter((s) => s.status !== "active")
    );
    this.broadcast("conversations");
    return active.length;
  }

  // ---------- blocklist ----------

  async listBlocklist(): Promise<BlocklistEntry[]> {
    await this.ensureMigrated();
    return ((await this.ctx.storage.get("blocklist")) as BlocklistEntry[]) || [];
  }

  async addBlock(entry: Omit<BlocklistEntry, "blockedAt">): Promise<void> {
    await this.ensureMigrated();
    const list = await this.listBlocklist();
    if (list.some((e) => e.senderId === entry.senderId)) return;
    list.push({ ...entry, blockedAt: new Date().toISOString() });
    await this.ctx.storage.put("blocklist", list);
    this.broadcast("blocklist");
  }

  async removeBlock(senderId: string): Promise<void> {
    await this.ensureMigrated();
    const list = await this.listBlocklist();
    await this.ctx.storage.put(
      "blocklist",
      list.filter((e) => e.senderId !== senderId)
    );
    this.broadcast("blocklist");
  }

  // ---------- stats ----------

  async incrementStat(key: string): Promise<void> {
    await this.ensureMigrated();
    const today = todayKey();
    const totalKey = `stat:${key}`;
    const dailyKey = `stat:${key}:${today}`;
    const values = await this.ctx.storage.get([totalKey, dailyKey]);
    await this.ctx.storage.put(totalKey, ((values.get(totalKey) as number) || 0) + 1);
    await this.ctx.storage.put(dailyKey, ((values.get(dailyKey) as number) || 0) + 1);
    await this.pruneOldDailyStats(today);
    this.broadcast("stats");
  }

  private async pruneOldDailyStats(today: string): Promise<void> {
    const lastPruned = await this.ctx.storage.get("stats_pruned_day");
    if (lastPruned === today) return;
    await this.ctx.storage.put("stats_pruned_day", today);

    const cutoff = new Date(Date.now() - DAILY_STAT_RETENTION_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);
    const all = await this.ctx.storage.list({ prefix: "stat:" });
    const stale: string[] = [];
    for (const key of all.keys()) {
      const parts = key.split(":");
      const day = parts[parts.length - 1];
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) stale.push(key);
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }

  async getAllStats(): Promise<StatsData> {
    await this.ensureMigrated();
    const today = todayKey();
    const keys = STAT_KEYS.flatMap((k) => [`stat:${k}`, `stat:${k}:${today}`]);
    const values = await this.ctx.storage.get(keys);
    const get = (k: string) => (values.get(k) as number) || 0;
    const pair = (k: string) => ({ total: get(`stat:${k}`), today: get(`stat:${k}:${today}`) });
    return {
      pending: pair("pending"),
      forwarded: pair("forwarded"),
      skipped_verified: pair("skipped:verified"),
      skipped_high_followers: pair("skipped:high_followers"),
      skipped_blocklisted: pair("skipped:blocklisted"),
      replied: pair("replied"),
      errors: pair("errors"),
    };
  }

  // ---------- logs ----------

  async appendEventLog(entry: Omit<LogEntry, "timestamp">): Promise<void> {
    await this.ensureMigrated();
    const list = ((await this.ctx.storage.get("event_log")) as LogEntry[]) || [];
    list.push({ ...entry, timestamp: new Date().toISOString() });
    await this.ctx.storage.put("event_log", list.slice(-MAX_EVENT_LOG));
    this.broadcast("logs");
  }

  async getEventLogs(): Promise<LogEntry[]> {
    await this.ensureMigrated();
    return ((await this.ctx.storage.get("event_log")) as LogEntry[]) || [];
  }

  async appendConsoleLog(entry: Omit<ConsoleLogEntry, "timestamp">): Promise<void> {
    await this.ensureMigrated();
    const list = ((await this.ctx.storage.get("console_logs")) as ConsoleLogEntry[]) || [];
    list.push({ ...entry, timestamp: new Date().toISOString() });
    await this.ctx.storage.put("console_logs", list.slice(-MAX_CONSOLE_LOG));
  }

  async getConsoleLogs(): Promise<ConsoleLogEntry[]> {
    await this.ensureMigrated();
    return ((await this.ctx.storage.get("console_logs")) as ConsoleLogEntry[]) || [];
  }

  // ---------- webhook dedup ----------

  /** Atomic check-and-mark. Returns true if this mid was already processed. */
  async checkAndMarkSeen(mid: string): Promise<boolean> {
    await this.ensureMigrated();
    const seen = ((await this.ctx.storage.get("seen_mids")) as Record<string, number>) || {};
    const now = Date.now();
    if (seen[mid] && now - seen[mid] < SEEN_WINDOW_MS) return true;
    // Prune expired entries while we're here
    for (const [key, ts] of Object.entries(seen)) {
      if (now - ts >= SEEN_WINDOW_MS) delete seen[key];
    }
    seen[mid] = now;
    await this.ctx.storage.put("seen_mids", seen);
    return false;
  }
}

/** Worker-side helper: stub for the singleton DMState instance. */
export function getDMState(env: Env) {
  return env.DM_STATE.get(env.DM_STATE.idFromName("main"));
}
