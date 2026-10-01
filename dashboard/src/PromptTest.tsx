import { useEffect, useRef, useState } from "react";

/**
 * Prompt test bench (Settings → AI guidelines → "Test prompt"). Runs the fixed
 * support scenarios — and optionally the latest real unread emails — through the
 * live prompt on two models side by side, so a prompt/model change can be
 * checked for regressions first. Read-only on the server: nothing is sent.
 */

interface Scenario {
  id: string;
  name: string;
  channel: "email" | "instagram";
  messages: { sender: "user" | "agent"; text: string }[];
  expect: string;
}

// One row of the results: a scenario or a real thread.
interface Case {
  key: string;
  name: string;
  sub: string; // "Expect: …" for scenarios, sender + snippet for threads
  channel: string;
  customer: string;
  body: { scenarioId: string } | { threadId: string };
}

interface RunResult {
  suggestion?: string;
  actions?: string[];
  ms?: number;
  error?: string;
}

type Slot = "A" | "B";
const CONCURRENCY = 4;
const THREAD_COUNT = 5;

/** Drafts wrap facts pulled from Shopify in ⟦ ⟧ — drop the markers, show green. */
function MarkedText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(⟦[^⟧]*⟧)/).map((seg, i) =>
        seg.startsWith("⟦") && seg.endsWith("⟧") ? (
          <span key={i} style={{ color: "#15803d", fontWeight: 600 }}>
            {seg.slice(1, -1)}
          </span>
        ) : (
          <span key={i}>{seg}</span>
        )
      )}
    </>
  );
}

export function PromptTest({ onClose }: { onClose: () => void }) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelA, setModelA] = useState("");
  const [modelB, setModelB] = useState("");
  const [withThreads, setWithThreads] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [cases, setCases] = useState<Case[]>([]);
  const [results, setResults] = useState<Record<string, RunResult>>({});
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  // Bumped on close/re-run so a stale run stops writing into state.
  const runIdRef = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/ai/eval/scenarios");
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        const list: string[] = d.models || [];
        const saved: string = d.savedModel || list[0] || "";
        setScenarios(d.scenarios || []);
        setModels(list);
        setModelA(saved);
        setModelB(list.find((m) => m !== saved) || saved);
      } catch (e) {
        setLoadError(`Couldn't load scenarios — ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      runIdRef.current++;
    };
  }, []);

  // Escape closes the modal only — capture it before the drawer's handler does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  async function loadThreadCases(): Promise<Case[]> {
    // Same list endpoint the Inbox uses; newest first.
    const res = await fetch("/api/email/threads");
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    const threads: any[] = (d.threads || []).slice();
    threads.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    return threads.slice(0, THREAD_COUNT).map((t) => ({
      key: `thread:${t.threadId}`,
      name: t.subject || "(no subject)",
      sub: t.snippet || "",
      channel: "email (live)",
      customer: t.fromName || t.from || "",
      body: { threadId: t.threadId },
    }));
  }

  async function run() {
    if (!modelA || !modelB || running) return;
    const runId = ++runIdRef.current;
    const live = () => runIdRef.current === runId;

    let list: Case[] = scenarios.map((s) => ({
      key: `sc:${s.id}`,
      name: s.name,
      sub: `Expect: ${s.expect}`,
      channel: s.channel,
      customer: s.messages.filter((m) => m.sender === "user").map((m) => m.text).join("\n"),
      body: { scenarioId: s.id },
    }));
    const initial: Record<string, RunResult> = {};
    if (withThreads) {
      try {
        list = [...list, ...(await loadThreadCases())];
      } catch (e) {
        initial["threads"] = { error: `Unread emails not loaded — ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!live()) return;
    }

    const jobs: { c: Case; slot: Slot; model: string }[] = [];
    for (const c of list) {
      jobs.push({ c, slot: "A", model: modelA });
      jobs.push({ c, slot: "B", model: modelB });
    }
    setCases(list);
    setResults(initial);
    setDone(0);
    setTotal(jobs.length);
    setRunning(true);

    let next = 0;
    const worker = async () => {
      while (next < jobs.length && live()) {
        const job = jobs[next++];
        let r: RunResult;
        try {
          const res = await fetch("/api/ai/eval/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...job.c.body, model: job.model }),
          });
          const d = await res.json().catch(() => ({}));
          r = res.ok ? d : { error: d.error || `HTTP ${res.status}`, ms: d.ms };
        } catch (e) {
          r = { error: `Network error — ${e instanceof Error ? e.message : String(e)}` };
        }
        if (!live()) return;
        setResults((p) => ({ ...p, [`${job.c.key}:${job.slot}`]: r }));
        setDone((n) => n + 1);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (live()) setRunning(false);
  }

  function renderResult(c: Case, slot: Slot, model: string) {
    const r = results[`${c.key}:${slot}`];
    return (
      <div style={styles.draft}>
        <div style={styles.draftHead}>
          <span style={styles.slotTag}>{slot}</span>
          <span style={styles.modelName}>{model}</span>
          {r?.ms != null && <span style={styles.ms}>{(r.ms / 1000).toFixed(1)}s</span>}
        </div>
        {!r ? (
          <div style={styles.muted}>{running ? "Waiting…" : "—"}</div>
        ) : r.error ? (
          <div style={styles.error}>{r.error}</div>
        ) : (
          <>
            <div style={styles.draftText}>
              <MarkedText text={r.suggestion || ""} />
            </div>
            {r.actions && r.actions.length > 0 && (
              <div style={styles.actions}>
                {r.actions.map((a, i) => (
                  <span key={i} style={styles.actionChip}>⚡ {a}</span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header style={styles.header}>
          <span style={styles.title}>Test prompt</span>
          <button style={styles.x} onClick={onClose} title="Close">×</button>
        </header>

        <div style={styles.controls}>
          <p style={styles.hint}>
            Runs {scenarios.length || "the"} fixed scenarios through the live prompt (base + active
            guidelines) on two models. Nothing is sent or saved; order lookups are read-only.
          </p>
          {loadError && <div style={styles.error}>{loadError}</div>}
          <div style={styles.controlRow}>
            <label style={styles.field}>
              <span style={styles.fieldLabel}>Model A</span>
              <select value={modelA} onChange={(e) => setModelA(e.target.value)} style={styles.select} disabled={running}>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label style={styles.field}>
              <span style={styles.fieldLabel}>Model B</span>
              <select value={modelB} onChange={(e) => setModelB(e.target.value)} style={styles.select} disabled={running}>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label style={styles.check}>
              <input
                type="checkbox"
                checked={withThreads}
                onChange={(e) => setWithThreads(e.target.checked)}
                disabled={running}
              />
              Include {THREAD_COUNT} latest unread emails
            </label>
            <button
              style={{ ...styles.runBtn, ...(running || !modelA ? styles.runBtnOff : {}) }}
              onClick={run}
              disabled={running || !modelA}
            >
              {running ? `Running ${done}/${total}…` : "Run"}
            </button>
          </div>
          {total > 0 && (
            <div style={styles.progress}>
              <div style={{ ...styles.progressBar, width: `${(done / total) * 100}%` }} />
            </div>
          )}
        </div>

        <div style={styles.results}>
          {results["threads"]?.error && <div style={styles.error}>{results["threads"].error}</div>}
          {cases.map((c) => (
            <div key={c.key} style={styles.card}>
              <div style={styles.cardHead}>
                <span style={styles.cardName}>{c.name}</span>
                <span style={styles.channel}>{c.channel}</span>
              </div>
              <div style={styles.customer}>{c.customer}</div>
              <div style={styles.expect}>{c.sub}</div>
              <div style={styles.pair}>
                {renderResult(c, "A", modelA)}
                {renderResult(c, "B", modelB)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1200,
    display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem",
  },
  modal: {
    background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)",
    borderRadius: "14px", width: "min(1100px, 96vw)", height: "90vh", display: "flex",
    flexDirection: "column", boxShadow: "0 12px 40px rgba(0,0,0,0.35)", overflow: "hidden",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "0.8rem 1rem", borderBottom: "1px solid var(--border)", flexShrink: 0,
  },
  title: { fontSize: "1.05rem", fontWeight: 700 },
  x: {
    background: "none", border: "none", fontSize: "1.5rem", lineHeight: 1,
    color: "var(--text-muted)", cursor: "pointer", padding: "0.2rem 0.5rem",
  },
  controls: { padding: "0.8rem 1rem", borderBottom: "1px solid var(--border)", flexShrink: 0 },
  hint: { fontSize: "0.75rem", color: "var(--text-muted)", margin: "0 0 0.6rem", lineHeight: 1.4 },
  controlRow: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "0.75rem" },
  field: { display: "flex", flexDirection: "column", gap: "0.25rem" },
  fieldLabel: { fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)" },
  select: {
    padding: "0.4rem 0.6rem", border: "1px solid var(--border)", background: "var(--surface)",
    color: "var(--text)", borderRadius: "7px", fontSize: "0.82rem",
  },
  check: { display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", paddingBottom: "0.4rem", cursor: "pointer" },
  runBtn: {
    padding: "0.45rem 1.3rem", background: "#111", color: "#fff", border: "none",
    borderRadius: "7px", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer", marginLeft: "auto",
  },
  runBtnOff: { opacity: 0.6, cursor: "default" },
  progress: { height: "4px", background: "var(--border)", borderRadius: "2px", marginTop: "0.7rem", overflow: "hidden" },
  progressBar: { height: "100%", background: "#16a34a", transition: "width 0.2s" },
  results: { flex: 1, overflowY: "auto", padding: "0.8rem 1rem 2rem" },
  card: { border: "1px solid var(--border)", borderRadius: "10px", padding: "0.75rem", marginBottom: "0.75rem" },
  cardHead: { display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" },
  cardName: { fontSize: "0.9rem", fontWeight: 700 },
  channel: {
    fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em",
    color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: "4px", padding: "0.05rem 0.35rem",
  },
  customer: { fontSize: "0.8rem", fontStyle: "italic", color: "var(--text-muted)", whiteSpace: "pre-wrap", marginBottom: "0.25rem" },
  expect: { fontSize: "0.78rem", color: "var(--text)", marginBottom: "0.6rem", lineHeight: 1.4 },
  // auto-fit stacks the two drafts once the card is too narrow for both.
  pair: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "0.6rem" },
  draft: { border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.7rem", background: "var(--surface-2)", minWidth: 0 },
  draftHead: { display: "flex", alignItems: "center", gap: "0.45rem", marginBottom: "0.4rem" },
  slotTag: {
    fontSize: "0.65rem", fontWeight: 800, background: "var(--text)", color: "var(--surface)",
    borderRadius: "4px", padding: "0.05rem 0.35rem",
  },
  modelName: { fontSize: "0.75rem", fontWeight: 600, color: "var(--text-muted)" },
  ms: { fontSize: "0.72rem", color: "var(--text-muted)", marginLeft: "auto" },
  draftText: { fontSize: "0.82rem", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  actions: { display: "flex", flexWrap: "wrap", gap: "0.3rem", marginTop: "0.5rem" },
  actionChip: {
    fontSize: "0.7rem", fontWeight: 600, color: "#b45309", border: "1px solid #f59e0b66",
    borderRadius: "5px", padding: "0.1rem 0.4rem",
  },
  muted: { fontSize: "0.8rem", color: "var(--text-muted)" },
  error: { fontSize: "0.8rem", color: "#d32f2f", whiteSpace: "pre-wrap", wordBreak: "break-word" },
};
