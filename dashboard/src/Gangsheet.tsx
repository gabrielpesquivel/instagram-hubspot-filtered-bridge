import { useEffect, useRef, useState, type CSSProperties } from "react";
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

// Ask the worker (fal.ai / BRIA RMBG-2.0, SOTA) to cut the background. Best on
// the hard cases the local model fails: fine lines, low contrast, busy/weird
// backgrounds. Returns PNG bytes, or null if the endpoint is unconfigured (503)
// or errors — caller then falls back to the local @imgly model.
async function removeBgViaServer(url: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch("/api/remove-bg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    return buf.byteLength ? buf : null;
  } catch {
    return null;
  }
}

// Fetch a customer-uploaded image and return PNG bytes for Pyodide/Pillow.
// When removeBg is set, pick the right strategy per image:
//   • flat solid background (logos, clipart) → corner-seeded flood-fill chroma
//     key. Reliable even with no colour contrast (white-on-white) because it
//     keys the actual background colour and stops at the artwork's outline.
//   • busy / gradient / photographic / low-contrast background → SOTA model on
//     the worker (fal.ai / BRIA). Falls back to the local @imgly neural model
//     if the server endpoint is unconfigured or errors.
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
      // Non-uniform background (or decode failed): try the SOTA server model
      // first, then fall back to the local neural model if it's unavailable.
      const server = await removeBgViaServer(url);
      if (server) return server;
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

// Headless auto-generation: the daily cron opens this page via Browser
// Rendering with ?autogen=<AEST date> (see src/handlers/gangsheet-autorender.ts
// in the worker). The page renders that day's stored Shopify pull through the
// normal pipeline, uploads the sheet to R2 as
// gangsheets/<date>/<orderStart>-<orderEnd>.ai (instead of downloading), and
// reports completion through window.__gangsheetAutoResult, which the puppeteer
// driver polls.
const autoGenDate = new URLSearchParams(window.location.search).get("autogen");

function reportAuto(result: {
  ok: boolean;
  uploaded?: string;
  skipped?: string;
  error?: string;
  items?: number;
  errors?: number;
}) {
  (window as unknown as { __gangsheetAutoResult?: unknown }).__gangsheetAutoResult = result;
}

// First and last order numbers in a pulled CSV (Number column) — the auto
// upload is named <start>-<end>.ai.
function orderRange(csv: string): { start: number; end: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const line of csv.split("\n").slice(1)) {
    const m = line.match(/^"?(\d+)/);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return Number.isFinite(min) ? { start: min, end: max } : null;
}

let nextJobId = 1;

// ISO timestamp → the local-time string a datetime-local input expects.
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const pullBtnStyle: CSSProperties = {
  padding: "0.45rem 0.9rem",
  borderRadius: 6,
  border: "1px solid #2e7d32",
  background: "#2e7d32",
  color: "#fff",
  cursor: "pointer",
  fontSize: "0.85rem",
  whiteSpace: "nowrap",
};

const dateInputStyle: CSSProperties = {
  padding: "0.25rem 0.4rem",
  borderRadius: 4,
  border: "1px solid var(--border, #ccc)",
  background: "var(--bg, #fff)",
  color: "inherit",
  fontSize: "0.85rem",
};

export function Gangsheet({ onBack, onLogout }: GangsheetProps) {
  const workerRef = useRef<Worker | null>(null);
  const queueRef = useRef<{ job: SheetJob; csv: ArrayBuffer }[]>([]);
  const busyRef = useRef(false);
  // Auto-generation (?autogen=<date>): the running auto job's name, and a
  // one-shot latch so the job is only enqueued once.
  const autoJobNameRef = useRef<string | null>(null);
  const autoStartedRef = useRef(false);

  const [runtimeStatus, setRuntimeStatus] = useState("Starting…");
  const [ready, setReady] = useState(false);
  const [jobs, setJobs] = useState<SheetJob[]>([]);
  const [logs, setLogs] = useState<string[]>([]);

  // Shopify order pull (replaces the manual Matrixify CSV export). `daily` is
  // the cron-stored 9am snapshot; the manual pull fetches an arbitrary range.
  const [daily, setDaily] = useState<{
    date: string;
    orders: number;
    items: number;
    csv: string;
    pulledAt: string;
  } | null>(null);
  const [pulling, setPulling] = useState(false);
  // Default the range pickers to the 9am-to-9am window (yesterday 9:00 → today
  // 9:00 local) so the time part starts at 09:00 rather than whenever the page
  // was opened.
  const nineAm = (daysAgo: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
  };
  const [pullFrom, setPullFrom] = useState(() => nineAm(1));
  const [pullTo, setPullTo] = useState(() => nineAm(0));
  const [pullOrderFrom, setPullOrderFrom] = useState("");
  const [pullOrderTo, setPullOrderTo] = useState("");
  // The pair the user typed in last is what the shared Pull button uses; the
  // other pair is auto-filled from /api/gangsheet/preview as an indicator.
  const [pullSource, setPullSource] = useState<"time" | "orders">("time");
  const syncTimer = useRef<number | null>(null);
  const syncSeq = useRef(0);

  // Debounced two-way sync: editing the time window looks up the first/last
  // order numbers inside it; editing the order numbers looks up their creation
  // times. A sequence counter drops stale responses from superseded edits.
  function scheduleSync(run: (seq: number) => Promise<void>) {
    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
    const seq = ++syncSeq.current;
    syncTimer.current = window.setTimeout(() => {
      run(seq).catch(() => { /* preview is best-effort */ });
    }, 600);
  }

  function onTimeEdited(from: string, to: string) {
    setPullFrom(from);
    setPullTo(to);
    setPullSource("time");
    if (!from || !to) return;
    scheduleSync(async (seq) => {
      const params = new URLSearchParams({
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      });
      const res = await fetch(`/api/gangsheet/preview?${params.toString()}`);
      if (seq !== syncSeq.current) return;
      if (!res.ok) {
        setPullOrderFrom("");
        setPullOrderTo("");
        return;
      }
      const data = await res.json();
      if (seq !== syncSeq.current) return;
      setPullOrderFrom(`#${data.fromOrder}`);
      setPullOrderTo(`#${data.toOrder}`);
    });
  }

  function onOrdersEdited(from: string, to: string) {
    setPullOrderFrom(from);
    setPullOrderTo(to);
    setPullSource("orders");
    const lo = Number(from.replace(/^#/, "").trim());
    const hi = Number(to.replace(/^#/, "").trim());
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo <= 0 || hi <= 0) return;
    scheduleSync(async (seq) => {
      const params = new URLSearchParams({ fromOrder: String(lo), toOrder: String(hi) });
      const res = await fetch(`/api/gangsheet/preview?${params.toString()}`);
      if (seq !== syncSeq.current) return;
      if (!res.ok) return;
      const data = await res.json();
      if (seq !== syncSeq.current) return;
      setPullFrom(isoToLocalInput(data.from));
      setPullTo(isoToLocalInput(data.to));
    });
  }

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
          // Auto mode: upload the sheet to R2 as the day's .ai instead of
          // downloading, then hand the result to the puppeteer driver.
          if (autoJobNameRef.current && msg.name === autoJobNameRef.current) {
            const fileName = `${msg.name}.ai`;
            try {
              const resp = await fetch(
                `/api/files?date=${autoGenDate}&name=${encodeURIComponent(fileName)}`,
                {
                  method: "PUT",
                  headers: { "Content-Type": "application/postscript" },
                  body: new Blob([msg.pdf], { type: "application/postscript" }),
                }
              );
              reportAuto(
                resp.ok
                  ? { ok: true, uploaded: fileName, items: msg.count, errors: msg.errors }
                  : { ok: false, error: `Upload failed: HTTP ${resp.status}` }
              );
            } catch (e) {
              reportAuto({ ok: false, error: `Upload failed: ${e}` });
            }
            setJobs((prev) =>
              prev.map((j) =>
                j.name === msg.name && j.status === "processing"
                  ? { ...j, status: "done", detail: `Uploaded ${fileName}` }
                  : j
              )
            );
            busyRef.current = false;
            pumpQueue();
            break;
          }
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
            if (autoJobNameRef.current && msg.name === autoJobNameRef.current) {
              reportAuto({ ok: false, error: msg.text });
            }
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
            if (autoGenDate) reportAuto({ ok: false, error: `Runtime error: ${msg.text}` });
            setRuntimeStatus(`Error: ${msg.text}`);
          }
          break;
      }
    };

    worker.postMessage({ type: "init" });
    return () => worker.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch(autoGenDate ? `/api/gangsheet/daily?date=${autoGenDate}` : "/api/gangsheet/daily")
      .then(async (r) => {
        if (r.ok) setDaily(await r.json());
        else if (autoGenDate) reportAuto({ ok: true, skipped: "no stored pull for date" });
      })
      .catch(() => {
        // no stored pull — banner just doesn't show
        if (autoGenDate) reportAuto({ ok: false, error: "daily pull fetch failed" });
      });
  }, []);

  // Auto mode: once the runtime is ready and the day's pull is loaded, run it
  // through the normal queue exactly like the "Generate sheet" button, named
  // <orderStart>-<orderEnd>. The done/error handlers above upload and report.
  useEffect(() => {
    if (!autoGenDate || !ready || !daily || autoStartedRef.current) return;
    autoStartedRef.current = true;
    if (!daily.items) {
      reportAuto({ ok: true, skipped: "no printable items" });
      return;
    }
    const range = orderRange(daily.csv);
    if (!range) {
      reportAuto({ ok: true, skipped: "no order numbers in pull" });
      return;
    }
    const name = `${range.start}-${range.end}`;
    autoJobNameRef.current = name;
    enqueueCsv(name, daily.csv, `Auto daily ${daily.date}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, daily]);

  /** Queue a CSV that arrived as text (Shopify pull) instead of a dropped file. */
  function enqueueCsv(name: string, csvText: string, fileName: string) {
    const clean = name.replace(/[^A-Za-z0-9._-]/g, "_") || "sheet";
    const job: SheetJob = {
      id: nextJobId++,
      name: clean,
      fileName,
      status: "queued",
      detail: "Waiting…",
    };
    const csv = new TextEncoder().encode(csvText).buffer as ArrayBuffer;
    setJobs((prev) => [...prev, job]);
    queueRef.current.push({ job, csv });
    pumpQueue();
  }

  async function handlePull() {
    if (pulling) return;
    setPulling(true);
    try {
      // datetime-local values are local time — toISOString converts to the UTC
      // the Shopify query expects. Range is [from, to).
      const params = new URLSearchParams();
      if (pullFrom) params.set("from", new Date(pullFrom).toISOString());
      if (pullTo) params.set("to", new Date(pullTo).toISOString());
      const res = await fetch(`/api/gangsheet/orders?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setLogs((prev) => [...prev, `Shopify pull failed: ${data.error || res.status}`]);
        return;
      }
      if (!data.items) {
        setLogs((prev) => [...prev, `Shopify pull: ${data.orders} orders, no printable items in range`]);
        return;
      }
      // Name the sheet by the order-number range in the pull (matching the
      // auto-daily and order-range pulls) rather than the picked times.
      const range = orderRange(data.csv);
      const label = range
        ? `Orders_${range.start}-${range.end}`
        : pullFrom || pullTo
          ? `Orders_${pullFrom || "start"}_${pullTo || "now"}`
          : "Orders_last24h";
      enqueueCsv(label, data.csv, `Shopify pull — ${data.orders} orders, ${data.items} items`);
    } catch {
      setLogs((prev) => [...prev, "Shopify pull failed: network error"]);
    } finally {
      setPulling(false);
    }
  }

  async function handlePullOrderRange() {
    if (pulling || !pullOrderFrom || !pullOrderTo) return;
    setPulling(true);
    try {
      const params = new URLSearchParams({
        fromOrder: pullOrderFrom.replace(/^#/, "").trim(),
        toOrder: pullOrderTo.replace(/^#/, "").trim(),
      });
      const res = await fetch(`/api/gangsheet/orders?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setLogs((prev) => [...prev, `Shopify pull failed: ${data.error || res.status}`]);
        return;
      }
      if (!data.items) {
        setLogs((prev) => [...prev, `Shopify pull: ${data.orders} orders, no printable items in #${data.fromOrder}–#${data.toOrder}`]);
        return;
      }
      enqueueCsv(
        `Orders_${data.fromOrder}-${data.toOrder}`,
        data.csv,
        `Shopify pull — orders #${data.fromOrder}–#${data.toOrder}: ${data.orders} orders, ${data.items} items`
      );
    } catch {
      setLogs((prev) => [...prev, "Shopify pull failed: network error"]);
    } finally {
      setPulling(false);
    }
  }

  // Fill the order-number fields for the default 9am→9am window on load, so
  // both pairs match before any edits.
  useEffect(() => {
    onTimeEdited(pullFrom, pullTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared Pull button: the last-edited pair is authoritative.
  const ordersValid =
    Number.isInteger(Number(pullOrderFrom.replace(/^#/, "").trim())) &&
    Number(pullOrderFrom.replace(/^#/, "").trim()) > 0 &&
    Number.isInteger(Number(pullOrderTo.replace(/^#/, "").trim())) &&
    Number(pullOrderTo.replace(/^#/, "").trim()) > 0;

  function handleSharedPull() {
    if (pullSource === "orders" && ordersValid) return handlePullOrderRange();
    return handlePull();
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
        <style>{"@keyframes gs-spin { to { transform: rotate(360deg); } }"}</style>

        {/* Functional area: blurred with a centered loading animation until the
            Python runtime is ready. */}
        <div style={{ position: "relative" }}>
          <div
            style={{
              filter: ready ? "none" : "blur(4px)",
              pointerEvents: ready ? "auto" : "none",
              transition: "filter 0.4s ease",
            }}
            aria-hidden={!ready}
          >
            <div style={styles.jobList}>
              {daily && (
                <div style={styles.jobRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.jobName}>Today's Shopify orders — {daily.date}</div>
                    <div style={styles.jobDetail}>
                      {daily.orders} orders, {daily.items} line items (pulled{" "}
                      {new Date(daily.pulledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})
                    </div>
                  </div>
                  <button
                    disabled={!ready || daily.items === 0}
                    onClick={() => enqueueCsv(`Orders_${daily.date}`, daily.csv, `Daily orders ${daily.date}`)}
                    style={{ ...pullBtnStyle, opacity: ready && daily.items > 0 ? 1 : 0.5 }}
                  >
                    Generate sheet
                  </button>
                </div>
              )}
              <div style={{ ...styles.jobRow, alignItems: "stretch", flexDirection: "column" as const, gap: "0.75rem" }}>
                <div style={styles.jobName}>Pull orders from Shopify</div>
                <div style={styles.pullColumns}>
                  <div
                    style={{
                      ...styles.pullCol,
                      ...(pullSource === "time" ? styles.pullColActive : {}),
                    }}
                  >
                    <div style={styles.pullColTitle}>Time range</div>
                    <label style={styles.pullField}>
                      <span style={styles.pullFieldLabel}>From</span>
                      <input
                        type="datetime-local"
                        value={pullFrom}
                        onChange={(e) => onTimeEdited(e.target.value, pullTo)}
                        style={dateInputStyle}
                      />
                    </label>
                    <label style={styles.pullField}>
                      <span style={styles.pullFieldLabel}>To</span>
                      <input
                        type="datetime-local"
                        value={pullTo}
                        onChange={(e) => onTimeEdited(pullFrom, e.target.value)}
                        style={dateInputStyle}
                      />
                    </label>
                  </div>
                  <div
                    style={{
                      ...styles.pullCol,
                      ...(pullSource === "orders" ? styles.pullColActive : {}),
                    }}
                  >
                    <div style={styles.pullColTitle}>Order numbers</div>
                    <label style={styles.pullField}>
                      <span style={styles.pullFieldLabel}>From</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="#12500"
                        value={pullOrderFrom}
                        onChange={(e) => onOrdersEdited(e.target.value, pullOrderTo)}
                        style={{ ...dateInputStyle, width: "6.5rem" }}
                      />
                    </label>
                    <label style={styles.pullField}>
                      <span style={styles.pullFieldLabel}>To</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="#12560"
                        value={pullOrderTo}
                        onChange={(e) => onOrdersEdited(pullOrderFrom, e.target.value)}
                        style={{ ...dateInputStyle, width: "6.5rem" }}
                      />
                    </label>
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <button
                    disabled={pulling || !ready || (pullSource === "orders" && !ordersValid)}
                    onClick={handleSharedPull}
                    style={{
                      ...pullBtnStyle,
                      opacity: pulling || !ready || (pullSource === "orders" && !ordersValid) ? 0.5 : 1,
                    }}
                  >
                    {pulling ? "Pulling…" : "Pull orders"}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {!ready && (
            <div style={styles.loadingOverlay}>
              <span style={styles.loadingSpinner} />
              <span style={styles.loadingText}>{runtimeStatus}</span>
            </div>
          )}
        </div>

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
  loadingOverlay: {
    position: "absolute" as const,
    inset: 0,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "0.75rem",
    zIndex: 10,
  },
  loadingSpinner: {
    width: "42px",
    height: "42px",
    borderRadius: "50%",
    border: "4px solid var(--border)",
    borderTopColor: "#2e7d32",
    animation: "gs-spin 0.9s linear infinite",
  },
  loadingText: {
    fontSize: "0.9rem",
    fontWeight: 600,
    color: "var(--text)",
    background: "var(--surface)",
    padding: "0.35rem 0.9rem",
    borderRadius: "999px",
    boxShadow: "0 2px 8px var(--shadow)",
  },
  pullColumns: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "0.75rem",
  },
  pullCol: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
    padding: "0.6rem 0.75rem",
    border: "1px solid var(--border)",
    borderRadius: "8px",
  },
  pullColActive: {
    borderColor: "#2e7d32",
    boxShadow: "0 0 0 1px #2e7d32 inset",
  },
  pullColTitle: {
    fontSize: "0.75rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    color: "var(--text-muted)",
  },
  pullField: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  pullFieldLabel: {
    fontSize: "0.8rem",
    color: "var(--text-muted)",
    width: "2.4rem",
    flexShrink: 0,
  },
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
