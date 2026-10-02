import { useEffect, useRef, useState } from "react";
import type { PageOutput } from "./cutfile-render";
import { orderRangeInName, pltName, pngName } from "./cutfile-render";
import { makeZip } from "./zip";

// Print Prep — drop the checked/fixed gangsheet .ai (after the manual
// Illustrator pass) and get back, per page, the registration-marked PNG for
// PrintManager and the AidCut-style .plt for the cutter. Processing is local
// (MuPDF WASM in a worker); nothing is uploaded.

interface SheetPage {
  page: number;
  boxes: number;
  segments: number;
  widthMm: number;
  heightMm: number;
  png: Uint8Array;
  pngName: string;
  pngUrl: string;
  plt: Uint8Array;
  pltName: string;
  pltUrl: string;
}

interface Job {
  id: string;
  fileName: string;
  base: string;
  status: "queued" | "processing" | "done" | "error";
  total: number;
  pages: SheetPage[];
  /** Order each page starts at, from the gangsheet render (see pltName). */
  pageOrders?: (string | null)[];
  /** No render record for this file — .plt names fall back to range + page. */
  ordersMissing?: boolean;
  error?: string;
  zipUrl?: string;
}

// Which order each page of this sheet starts at, recorded by the gangsheet
// page when it rendered the sheet (keyed by the order range in the name).
async function lookupPageOrders(base: string): Promise<(string | null)[] | null> {
  try {
    const res = await fetch(`/api/gangsheet/page-orders?name=${encodeURIComponent(base)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { pages?: (string | null)[] };
    return Array.isArray(data.pages) ? data.pages : null;
  } catch {
    return null;
  }
}

export function CutFiles() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const queueRef = useRef<{ id: string; file: File }[]>([]);
  const busyRef = useRef(false);
  const currentRef = useRef<string | null>(null);
  const readyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;

  const updateJob = (id: string, fn: (j: Job) => Job) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? fn(j) : j)));

  async function pump() {
    if (busyRef.current || !readyRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    busyRef.current = true;
    currentRef.current = next.id;
    updateJob(next.id, (j) => ({ ...j, status: "processing" }));
    const base = next.file.name.replace(/\.(ai|pdf)$/i, "");
    const [bytes, pageOrders] = await Promise.all([next.file.arrayBuffer(), lookupPageOrders(base)]);
    updateJob(next.id, (j) => ({
      ...j,
      pageOrders: pageOrders ?? undefined,
      ordersMissing: !pageOrders && !!orderRangeInName(base),
    }));
    workerRef.current?.postMessage({ id: next.id, bytes }, [bytes]);
  }

  useEffect(() => {
    const worker = new Worker(new URL("./cutfiles.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === "ready") {
        readyRef.current = true;
        setReady(true);
        pump();
        return;
      }
      if (msg.type === "page") {
        const out = msg.out as PageOutput;
        updateJob(msg.id, (j) => {
          const plt = new TextEncoder().encode(out.plt);
          const page: SheetPage = {
            page: out.page,
            boxes: out.boxes,
            segments: out.segments,
            widthMm: out.widthMm,
            heightMm: out.heightMm,
            png: out.png,
            pngName: pngName(j.base, out.page),
            pngUrl: URL.createObjectURL(new Blob([out.png as BlobPart], { type: "image/png" })),
            plt,
            pltName: pltName(j.base, out.page, j.pageOrders),
            pltUrl: URL.createObjectURL(new Blob([plt as BlobPart], { type: "application/octet-stream" })),
          };
          return { ...j, total: msg.total, pages: [...j.pages, page] };
        });
        return;
      }
      if (msg.type === "done" || msg.type === "error") {
        updateJob(msg.id, (j) => {
          if (msg.type === "error") return { ...j, status: "error", error: msg.message };
          const zip = makeZip(
            j.pages.flatMap((p) => [
              { name: p.pngName, data: p.png },
              { name: p.pltName, data: p.plt },
            ])
          );
          return { ...j, status: "done", zipUrl: URL.createObjectURL(zip) };
        });
        busyRef.current = false;
        pump();
      }
    };
    worker.onerror = (e) => {
      // Uncaught worker failure (e.g. WASM out of memory): fail the in-flight
      // job and move on so the rest of the queue still runs.
      console.error("cutfiles worker error", e);
      const id = currentRef.current;
      if (id) updateJob(id, (j) => ({ ...j, status: "error", error: e.message || "Processing crashed" }));
      busyRef.current = false;
      pump();
    };
    return () => {
      worker.terminate();
      for (const j of jobsRef.current) revokeJob(j);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function revokeJob(j: Job) {
    for (const p of j.pages) {
      URL.revokeObjectURL(p.pngUrl);
      URL.revokeObjectURL(p.pltUrl);
    }
    if (j.zipUrl) URL.revokeObjectURL(j.zipUrl);
  }

  function addFiles(files: FileList | File[]) {
    const accepted = Array.from(files).filter((f) => /\.(ai|pdf)$/i.test(f.name));
    const rejected = Array.from(files).filter((f) => !/\.(ai|pdf)$/i.test(f.name));
    const newJobs: Job[] = accepted.map((file) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      queueRef.current.push({ id, file });
      return {
        id,
        fileName: file.name,
        base: file.name.replace(/\.(ai|pdf)$/i, ""),
        status: "queued",
        total: 0,
        pages: [],
      };
    });
    const errJobs: Job[] = rejected.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fileName: file.name,
      base: file.name,
      status: "error",
      total: 0,
      pages: [],
      error: "Not an .ai or .pdf file",
    }));
    setJobs((prev) => [...newJobs, ...errJobs, ...prev]);
    pump();
  }

  function removeJob(id: string) {
    const j = jobs.find((x) => x.id === id);
    if (j) revokeJob(j);
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
    setJobs((prev) => prev.filter((x) => x.id !== id));
  }

  return (
    <div style={styles.page}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        style={{ ...styles.dropZone, ...(dragging ? styles.dropZoneActive : {}) }}
      >
        <svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ color: dragging ? "#2e7d32" : "var(--text-faint)" }}>
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
        </svg>
        <div style={styles.dropTitle}>Drop fixed gangsheet .ai files here</div>
        <div style={styles.dropSub}>
          or click to choose — you get a PNG with registration marks + a .plt cut file for every page
        </div>
        {!ready && <div style={styles.dropSub}>Loading PDF engine…</div>}
        <input
          ref={inputRef}
          type="file"
          accept=".ai,.pdf"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {jobs.length > 0 && (
        <div style={styles.jobList}>
          {jobs.map((job) => (
            <div key={job.id} style={styles.job}>
              <div style={styles.jobHead}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.jobName}>{job.fileName}</div>
                  <div style={{ ...styles.jobDetail, color: job.status === "error" ? "#d32f2f" : "var(--text-muted)" }}>
                    {job.status === "queued" && "Queued…"}
                    {job.status === "processing" &&
                      (job.total
                        ? `Rendering page ${Math.min(job.pages.length + 1, job.total)} of ${job.total}…`
                        : "Reading file…")}
                    {job.status === "done" &&
                      `${job.pages.length} page${job.pages.length === 1 ? "" : "s"} · ${job.pages.reduce((n, p) => n + p.boxes, 0)} cut boxes`}
                    {job.status === "error" && job.error}
                  </div>
                  {job.ordersMissing && job.status !== "error" && (
                    <div style={styles.warn}>
                      No render record for this sheet, so pages after the first can't be matched to their order number
                      — .plt files are named by range + page instead. Sheets rendered in the Gangsheet tool from now on are
                      recorded automatically.
                    </div>
                  )}
                </div>
                {job.status === "processing" && <span style={styles.spinner} />}
                {job.status === "done" && job.zipUrl && (
                  <a href={job.zipUrl} download={`${job.base} - print prep.zip`} style={styles.dlPrimary}>
                    Download all
                  </a>
                )}
                {job.status !== "processing" && (
                  <button onClick={() => removeJob(job.id)} style={styles.removeBtn} title="Remove from list">
                    ✕
                  </button>
                )}
              </div>

              {job.pages.map((p) => (
                <div key={p.page} style={styles.pageRow}>
                  <div style={styles.pageNum}>{p.page}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.pageMeta}>
                      <span style={styles.pltLabel}>{p.pltName}</span>
                      {" · "}
                      {Math.round(p.widthMm)}×{Math.round(p.heightMm)} mm · {p.boxes} cut boxes
                      {p.segments > 1 && ` · ${p.segments} cut segments`}
                    </div>
                  </div>
                  <a href={p.pngUrl} download={p.pngName} style={styles.dlLink} title={p.pngName}>
                    PNG
                  </a>
                  <a href={p.pltUrl} download={p.pltName} style={styles.dlLink} title={p.pltName}>
                    PLT
                  </a>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <style>{"@keyframes cf-spin { to { transform: rotate(360deg); } }"}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: "900px",
    margin: "0 auto",
    padding: "1.5rem 1rem",
    color: "var(--text)",
  },
  dropZone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.4rem",
    padding: "2.5rem 1rem",
    background: "var(--surface)",
    border: "2px dashed var(--border)",
    borderRadius: "10px",
    cursor: "pointer",
    textAlign: "center",
    transition: "border-color 0.15s ease, background 0.15s ease",
  },
  dropZoneActive: {
    borderColor: "#2e7d32",
    background: "rgba(46, 125, 50, 0.06)",
  },
  dropTitle: { fontSize: "1rem", fontWeight: 600, marginTop: "0.35rem" },
  dropSub: { fontSize: "0.82rem", color: "var(--text-muted)" },
  jobList: {
    marginTop: "1.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  job: {
    background: "var(--surface)",
    borderRadius: "8px",
    boxShadow: "0 2px 8px var(--shadow)",
    overflow: "hidden",
  },
  jobHead: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.85rem 1rem",
  },
  jobName: {
    fontSize: "0.95rem",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  jobDetail: { fontSize: "0.8rem", marginTop: "0.15rem" },
  pageRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.6rem",
    padding: "0.55rem 1rem",
    borderTop: "1px solid var(--border)",
  },
  pageNum: {
    width: "24px",
    height: "24px",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    background: "var(--bg)",
    fontSize: "0.75rem",
    fontWeight: 700,
    color: "var(--text-muted)",
  },
  pageMeta: { fontSize: "0.85rem" },
  pltLabel: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "var(--text)",
    fontWeight: 600,
  },
  warn: {
    marginTop: "0.35rem",
    fontSize: "0.8rem",
    color: "#b26a00",
    lineHeight: 1.4,
  },
  dlLink: {
    padding: "0.3rem 0.8rem",
    background: "#333",
    color: "#fff",
    borderRadius: "4px",
    fontSize: "0.78rem",
    textDecoration: "none",
  },
  dlPrimary: {
    padding: "0.4rem 1rem",
    background: "#2e7d32",
    color: "#fff",
    borderRadius: "4px",
    fontSize: "0.82rem",
    fontWeight: 600,
    textDecoration: "none",
    whiteSpace: "nowrap",
  },
  spinner: {
    width: "20px",
    height: "20px",
    flexShrink: 0,
    borderRadius: "50%",
    border: "3px solid var(--border)",
    borderTopColor: "#2e7d32",
    animation: "cf-spin 0.9s linear infinite",
  },
  removeBtn: {
    flexShrink: 0,
    width: "26px",
    height: "26px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: "50%",
    cursor: "pointer",
    fontSize: "0.75rem",
    color: "var(--text-faint)",
    lineHeight: 1,
  },
};
