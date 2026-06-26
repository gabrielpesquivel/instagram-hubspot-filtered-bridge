import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ThemeToggle } from "./ThemeToggle";

interface SheetJob {
  id: number;
  name: string;
  fileName: string;
  status: "queued" | "processing" | "done" | "error";
  detail: string;
  pdfUrl?: string;
  aiUrl?: string;
}

interface GangsheetProps {
  onBack: () => void;
  onLogout: () => void;
}

// Rasterize an SVG with gradients/clipPaths to a PNG via canvas — replaces the
// desktop tool's rsvg-convert (20 px per SVG unit, capped for canvas limits).
async function rasterizeSvg(svgText: string): Promise<ArrayBuffer> {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;

  let w = 0;
  let h = 0;
  const vb = root.getAttribute("viewBox");
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    w = p[2];
    h = p[3];
  }
  if (!w || !h) {
    w = parseFloat((root.getAttribute("width") || "0").replace(/[^\d.]/g, ""));
    h = parseFloat((root.getAttribute("height") || "0").replace(/[^\d.]/g, ""));
  }
  if (!w || !h) return new ArrayBuffer(0);

  const scale = Math.min(20, 4096 / Math.max(w, h));
  root.setAttribute("width", `${w}`);
  root.setAttribute("height", `${h}`);

  const blob = new Blob([new XMLSerializer().serializeToString(root)], {
    type: "image/svg+xml",
  });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return new ArrayBuffer(0);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return png ? await png.arrayBuffer() : new ArrayBuffer(0);
  } catch {
    return new ArrayBuffer(0);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Decode an image URL to an offscreen canvas + its pixel buffer. Returns null on
// any failure (network, decode, no 2D context).
async function decodeToCanvas(
  url: string,
): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } | null> {
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const bmp = await createImageBitmap(await resp.blob());
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bmp.close();
    return null;
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { canvas, ctx, data: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

// Average colour of a wxw patch at (x0,y0), and how much that patch varies
// internally (max per-channel spread). A "uniform" corner has low spread.
function samplePatch(data: ImageData, x0: number, y0: number, w: number) {
  const { width, height, data: px } = data;
  let r = 0, g = 0, b = 0, n = 0;
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (let y = y0; y < Math.min(y0 + w, height); y++) {
    for (let x = x0; x < Math.min(x0 + w, width); x++) {
      const i = (y * width + x) * 4;
      const pr = px[i], pg = px[i + 1], pb = px[i + 2];
      r += pr; g += pg; b += pb; n++;
      rMin = Math.min(rMin, pr); rMax = Math.max(rMax, pr);
      gMin = Math.min(gMin, pg); gMax = Math.max(gMax, pg);
      bMin = Math.min(bMin, pb); bMax = Math.max(bMax, pb);
    }
  }
  if (!n) return null;
  const spread = Math.max(rMax - rMin, gMax - gMin, bMax - bMin);
  return { r: r / n, g: g / n, b: b / n, spread };
}

const colorDist = (
  ar: number, ag: number, ab: number,
  br: number, bg: number, bb: number,
) => Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);

// Is the background a single flat colour? True when all four corner patches are
// internally uniform AND agree with each other. Returns the background colour to
// key out, or null (→ use the neural model instead).
function detectFlatBackground(data: ImageData): { r: number; g: number; b: number } | null {
  const { width, height } = data;
  const w = Math.max(4, Math.floor(Math.min(width, height) * 0.04));
  const corners = [
    samplePatch(data, 0, 0, w),
    samplePatch(data, width - w, 0, w),
    samplePatch(data, 0, height - w, w),
    samplePatch(data, width - w, height - w, w),
  ];
  if (corners.some((c) => c === null)) return null;
  const cs = corners as NonNullable<ReturnType<typeof samplePatch>>[];

  // Each corner must be flat on its own (no photo texture bleeding to the edge).
  if (cs.some((c) => c.spread > 18)) return null;

  // Corners must agree with each other (rules out gradients / vignettes).
  for (let i = 1; i < cs.length; i++) {
    if (colorDist(cs[0].r, cs[0].g, cs[0].b, cs[i].r, cs[i].g, cs[i].b) > 24) return null;
  }
  const n = cs.length;
  return {
    r: cs.reduce((s, c) => s + c.r, 0) / n,
    g: cs.reduce((s, c) => s + c.g, 0) / n,
    b: cs.reduce((s, c) => s + c.b, 0) / n,
  };
}

// Flood-fill from the borders, clearing every background-coloured pixel reachable
// from the edge. Stops at the logo's outline, so enclosed regions (e.g. the white
// inside a white logo ringed by a black outline) are preserved — the exact case
// the neural saliency model gets wrong. TOL is the keying tolerance; SOFT adds a
// feathered alpha ramp just past it so cut edges aren't jagged.
function floodFillBackground(data: ImageData, bg: { r: number; g: number; b: number }): ImageData {
  const { width, height, data: px } = data;
  const TOL = 36;
  const SOFT = 22;
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];

  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    visited[p] = 1;
    const i = p * 4;
    const d = colorDist(px[i], px[i + 1], px[i + 2], bg.r, bg.g, bg.b);
    if (d > TOL + SOFT) return; // foreground — boundary of the fill
    stack.push(p);
    if (d > TOL) {
      // Edge transition: keep the pixel but ramp its alpha down toward the bg.
      px[i + 3] = Math.round(px[i + 3] * ((d - TOL) / SOFT));
    } else {
      px[i + 3] = 0; // solid background
    }
  };

  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  return data;
}

const canvasToPng = (canvas: HTMLCanvasElement): Promise<ArrayBuffer> =>
  new Promise((resolve) =>
    canvas.toBlob(
      (b) => (b ? b.arrayBuffer().then(resolve) : resolve(new ArrayBuffer(0))),
      "image/png",
    ),
  );

// Fetch a customer-uploaded image and return PNG bytes for Pyodide/Pillow.
// When removeBg is set, pick the right strategy per image:
//   • flat solid background (logos, clipart) → corner-seeded flood-fill chroma
//     key. Reliable even with no colour contrast (white-on-white) because it
//     keys the actual background colour and stops at the artwork's outline.
//   • busy / gradient / photographic background → @imgly neural model (downloads
//     a WASM model on first use, then cached).
// Without removeBg, just re-encode through a canvas so webp/jpg/jpeg all reach
// Pillow as PNG. Any failure returns an empty buffer, and the Python side falls
// back to the yellow order-number tag.
async function fetchImageAsPng(url: string, removeBg: boolean): Promise<ArrayBuffer> {
  try {
    if (removeBg) {
      const decoded = await decodeToCanvas(url);
      if (decoded) {
        const bg = detectFlatBackground(decoded.data);
        if (bg) {
          decoded.ctx.putImageData(floodFillBackground(decoded.data, bg), 0, 0);
          return await canvasToPng(decoded.canvas);
        }
      }
      // Non-uniform background (or decode failed): defer to the neural model.
      const { removeBackground } = await import("@imgly/background-removal");
      const blob = await removeBackground(url);
      return await blob.arrayBuffer();
    }
    const decoded = await decodeToCanvas(url);
    if (!decoded) return new ArrayBuffer(0);
    return await canvasToPng(decoded.canvas);
  } catch {
    return new ArrayBuffer(0);
  }
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
}

let nextJobId = 1;

export function Gangsheet({ onBack, onLogout }: GangsheetProps) {
  const workerRef = useRef<Worker | null>(null);
  const queueRef = useRef<{ job: SheetJob; csv: ArrayBuffer }[]>([]);
  const busyRef = useRef(false);

  const [runtimeStatus, setRuntimeStatus] = useState("Starting…");
  const [ready, setReady] = useState(false);
  const [jobs, setJobs] = useState<SheetJob[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  function updateJob(id: number, patch: Partial<SheetJob>) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }

  function removeJob(id: number) {
    queueRef.current = queueRef.current.filter((q) => q.job.id !== id);
    setJobs((prev) => {
      const job = prev.find((j) => j.id === id);
      if (job?.pdfUrl) URL.revokeObjectURL(job.pdfUrl);
      if (job?.aiUrl) URL.revokeObjectURL(job.aiUrl);
      return prev.filter((j) => j.id !== id);
    });
  }

  function pumpQueue() {
    if (busyRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    busyRef.current = true;
    updateJob(next.job.id, { status: "processing", detail: "Generating…" });
    workerRef.current?.postMessage(
      { type: "generate", name: next.job.name, csv: next.csv },
      [next.csv]
    );
  }

  useEffect(() => {
    const worker = new Worker(new URL("./gangsheet.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = async (e: MessageEvent) => {
      const msg = e.data;
      switch (msg.type) {
        case "status":
          setRuntimeStatus(msg.text);
          break;
        case "ready":
          setReady(true);
          setRuntimeStatus("Ready");
          break;
        case "log":
          setLogs((prev) => [...prev.slice(-199), msg.text]);
          break;
        case "need-raster": {
          const pngs = [];
          for (const { path, svgText } of msg.svgs) {
            pngs.push({ path, png: await rasterizeSvg(svgText) });
          }
          worker.postMessage(
            { type: "raster-done", pngs },
            pngs.map((p) => p.png)
          );
          break;
        }
        case "need-images": {
          const images = [];
          for (const { path, url, remove_bg } of msg.images) {
            images.push({ path, png: await fetchImageAsPng(url, remove_bg) });
          }
          worker.postMessage(
            { type: "images-done", images },
            images.map((i) => i.png)
          );
          break;
        }
        case "done": {
          const pdfBlobUrl = URL.createObjectURL(
            new Blob([msg.pdf], { type: "application/pdf" })
          );
          const aiBlobUrl = URL.createObjectURL(
            new Blob([msg.pdf], { type: "application/postscript" })
          );
          setJobs((prev) =>
            prev.map((j) =>
              j.name === msg.name && j.status === "processing"
                ? {
                    ...j,
                    status: "done",
                    detail: `${msg.count} items${msg.errors ? ` (${msg.errors} errors in yellow)` : ""} — ${msg.widthMm} × ${msg.heightMm} mm`,
                    pdfUrl: pdfBlobUrl,
                    aiUrl: aiBlobUrl,
                  }
                : j
            )
          );
          triggerDownload(pdfBlobUrl, `${msg.name}_gangsheet.pdf`);
          triggerDownload(aiBlobUrl, `${msg.name}_gangsheet.ai`);
          busyRef.current = false;
          pumpQueue();
          break;
        }
        case "error":
          if (msg.name) {
            setJobs((prev) =>
              prev.map((j) =>
                j.name === msg.name && (j.status === "processing" || j.status === "queued")
                  ? { ...j, status: "error", detail: msg.text }
                  : j
              )
            );
            busyRef.current = false;
            pumpQueue();
          } else {
            setRuntimeStatus(`Error: ${msg.text}`);
          }
          break;
      }
    };

    worker.postMessage({ type: "init" });
    return () => worker.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith(".csv")) continue;
      const name =
        file.name.replace(/\.csv$/i, "").replace(/[^A-Za-z0-9._-]/g, "_") || "sheet";
      const job: SheetJob = {
        id: nextJobId++,
        name,
        fileName: file.name,
        status: "queued",
        detail: "Waiting…",
      };
      const csv = await file.arrayBuffer();
      setJobs((prev) => [...prev, job]);
      queueRef.current.push({ job, csv });
    }
    pumpQueue();
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  function handleBrowse(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) addFiles(e.target.files);
    e.target.value = "";
  }

  return (
    <div style={styles.wrapper}>
      <header style={styles.topBar}>
        <div style={styles.topBarInner}>
          <button onClick={onBack} style={styles.backBtn}>
            ← Tools
          </button>
          <img src="/logo.png" alt="BootInk" style={styles.topBarLogo} />
          <span style={styles.topBarTitle}>Gangsheet Generator</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <ThemeToggle />
            <button onClick={onLogout} style={styles.logoutBtn}>
              Log out
            </button>
          </div>
        </div>
      </header>

      <div style={styles.page}>
        <div style={styles.statusRow}>
          <span
            style={{
              ...styles.statusDot,
              background: ready ? "#2e7d32" : "#f9a825",
            }}
          />
          <span style={styles.statusText}>{runtimeStatus}</span>
        </div>

        <label
          style={{
            ...styles.dropZone,
            ...(dragOver ? styles.dropZoneActive : {}),
            opacity: ready ? 1 : 0.6,
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <input
            type="file"
            accept=".csv"
            multiple
            onChange={handleBrowse}
            style={{ display: "none" }}
          />
          <p style={styles.dropTitle}>Drop Shopify order CSV files here</p>
          <p style={styles.dropSub}>or click to browse — runs entirely in your browser</p>
        </label>

        {jobs.length > 0 && (
          <div style={styles.jobList}>
            {jobs.map((job) => (
              <div key={job.id} style={styles.jobRow}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.jobName}>{job.fileName}</div>
                  <div
                    style={{
                      ...styles.jobDetail,
                      color: job.status === "error" ? "#d32f2f" : "#666",
                    }}
                  >
                    {job.status === "queued" && "Queued…"}
                    {job.status === "processing" && "Generating… (first run loads ~60 MB of Python runtime)"}
                    {(job.status === "done" || job.status === "error") && job.detail}
                  </div>
                </div>
                {job.status === "processing" && <span style={styles.spinner}>⏳</span>}
                {job.status === "done" && (
                  <div style={styles.jobLinks}>
                    <a href={job.pdfUrl} download={`${job.name}_gangsheet.pdf`} style={styles.dlLink}>
                      PDF
                    </a>
                    <a href={job.aiUrl} download={`${job.name}_gangsheet.ai`} style={styles.dlLink}>
                      AI
                    </a>
                  </div>
                )}
                {job.status !== "processing" && (
                  <button
                    onClick={() => removeJob(job.id)}
                    style={styles.removeBtn}
                    title="Remove from list"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {logs.length > 0 && (
          <details style={styles.logBox}>
            <summary style={styles.logSummary}>Engine log ({logs.length})</summary>
            <pre style={styles.logPre}>{logs.join("\n")}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    minHeight: "100vh",
    background: "var(--bg)",
    color: "var(--text)",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  topBar: {
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    padding: "0 1rem",
    position: "sticky" as const,
    top: 0,
    zIndex: 100,
    boxShadow: "0 1px 3px var(--shadow)",
  },
  topBarInner: {
    maxWidth: "900px",
    margin: "0 auto",
    display: "flex",
    alignItems: "center",
    position: "relative" as const,
    height: "56px",
    gap: "0.75rem",
  },
  topBarLogo: { height: "32px", width: "auto" },
  topBarTitle: {
    position: "absolute" as const,
    left: "50%",
    transform: "translateX(-50%)",
    fontSize: "1.1rem",
    fontWeight: 600,
    color: "var(--text)",
    whiteSpace: "nowrap" as const,
  },
  backBtn: {
    padding: "0.4rem 1rem",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "var(--text-muted)",
  },
  logoutBtn: {
    marginLeft: "auto",
    padding: "0.4rem 1rem",
    background: "none",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "0.8rem",
    color: "var(--text-muted)",
  },
  page: {
    maxWidth: "900px",
    margin: "0 auto",
    padding: "1.5rem 1rem",
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginBottom: "1rem",
  },
  statusDot: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: 0,
  },
  statusText: { fontSize: "0.85rem", color: "var(--text-muted)" },
  dropZone: {
    display: "block",
    border: "2px dashed #bbb",
    borderRadius: "8px",
    background: "var(--surface)",
    padding: "3rem 1rem",
    textAlign: "center" as const,
    cursor: "pointer",
    transition: "border-color 0.15s, background 0.15s",
  },
  dropZoneActive: {
    borderColor: "#333",
    background: "var(--surface-2)",
  },
  dropTitle: { margin: 0, fontSize: "1.05rem", fontWeight: 600, color: "var(--text)" },
  dropSub: { margin: "0.5rem 0 0", fontSize: "0.85rem", color: "var(--text-muted)" },
  jobList: {
    marginTop: "1.25rem",
    background: "var(--surface)",
    borderRadius: "8px",
    boxShadow: "0 2px 8px var(--shadow)",
    overflow: "hidden",
  },
  jobRow: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.85rem 1rem",
    borderBottom: "1px solid #f0f0f0",
  },
  jobName: {
    fontSize: "0.95rem",
    fontWeight: 600,
    color: "var(--text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  jobDetail: { fontSize: "0.8rem", marginTop: "0.15rem" },
  jobLinks: { display: "flex", gap: "0.5rem" },
  dlLink: {
    padding: "0.35rem 0.9rem",
    background: "#333",
    color: "#fff",
    borderRadius: "4px",
    fontSize: "0.8rem",
    textDecoration: "none",
  },
  spinner: { fontSize: "1.1rem" },
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
  logBox: {
    marginTop: "1.25rem",
    background: "var(--surface)",
    borderRadius: "8px",
    boxShadow: "0 2px 8px var(--shadow)",
    padding: "0.75rem 1rem",
  },
  logSummary: {
    cursor: "pointer",
    fontSize: "0.85rem",
    color: "var(--text-muted)",
    fontWeight: 600,
  },
  logPre: {
    margin: "0.75rem 0 0",
    fontSize: "0.75rem",
    color: "var(--text)",
    maxHeight: "240px",
    overflow: "auto",
    whiteSpace: "pre-wrap" as const,
  },
};
