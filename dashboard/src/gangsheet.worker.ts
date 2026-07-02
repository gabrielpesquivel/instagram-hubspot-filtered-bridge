// Runs the gangsheet generator's Python code via Pyodide, off the main thread.
//
// Protocol (main -> worker):
//   { type: "init" }
//   { type: "generate", name: string, csv: ArrayBuffer }
//   { type: "raster-done", pngs: { path: string; png: ArrayBuffer }[] }
//   { type: "images-done", images: { path: string; png: ArrayBuffer }[] }
//
// Protocol (worker -> main):
//   { type: "status", text }            // runtime loading progress
//   { type: "ready" }
//   { type: "log", text }               // python stdout/stderr
//   { type: "need-raster", svgs: { path, svgText }[] }  // canvas rasterization request
//   { type: "need-images", images: { path, url, remove_bg }[] }  // download custom artwork
//   { type: "done", name, pdf, count, errors, widthMm, heightMm }
//   { type: "error", name?, text }

// 0.28.x ships lxml 6 (svglib 1.6 requires lxml>=6.0.0 and has no older wheel)
const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";

let pyodide: any = null;
let initPromise: Promise<void> | null = null;
let rasterResolve: ((pngs: { path: string; png: ArrayBuffer }[]) => void) | null = null;
let imagesResolve: ((images: { path: string; png: ArrayBuffer }[]) => void) | null = null;

function post(msg: unknown, transfer: Transferable[] = []) {
  (self as any).postMessage(msg, transfer);
}

async function init() {
  post({ type: "status", text: "Downloading Python runtime…" });
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_BASE}pyodide.mjs`);
  pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });

  post({ type: "status", text: "Loading packages (pandas, shapely, matplotlib)…" });
  await pyodide.loadPackage(["pandas", "numpy", "matplotlib", "shapely", "Pillow", "lxml", "micropip"]);

  post({ type: "status", text: "Installing PDF packages (reportlab, svglib)…" });
  const micropip = pyodide.pyimport("micropip");
  // reportlab pinned to 4.4.x — 4.5+ requires freetype-py (no wasm wheel).
  // svglib installed with deps=false: its rlpycairo dep needs cairo/freetype
  // (no wasm wheels), but svg2rlg + renderPDF never touch that backend.
  // svglib's real runtime deps are installed explicitly.
  await micropip.install(["reportlab==4.4.4", "pdfrw", "tinycss2", "cssselect2", "webencodings"]);
  await micropip.install.callKwargs(["svglib"], { deps: false });
  micropip.destroy();

  post({ type: "status", text: "Downloading gangsheet engine + assets…" });
  const resp = await fetch("/gangsheet/bundle.zip");
  if (!resp.ok) throw new Error(`Failed to fetch /gangsheet/bundle.zip (HTTP ${resp.status})`);
  const bundle = await resp.arrayBuffer();
  pyodide.FS.mkdirTree("/gangsheet");
  pyodide.unpackArchive(bundle, "zip", { extractDir: "/gangsheet" });

  pyodide.setStdout({ batched: (s: string) => post({ type: "log", text: s }) });
  pyodide.setStderr({ batched: (s: string) => post({ type: "log", text: s }) });

  post({ type: "status", text: "Starting gangsheet engine…" });
  await pyodide.runPythonAsync("import sys; sys.path.insert(0, '/gangsheet'); import web_runner");
  post({ type: "ready" });
}

async function ensureInit() {
  if (!initPromise) {
    initPromise = init().catch((err) => {
      initPromise = null; // allow retry on next message
      throw err;
    });
  }
  await initPromise;
}

async function generate(name: string, csv: ArrayBuffer) {
  pyodide.FS.writeFile("/tmp/upload.csv", new Uint8Array(csv));
  const collect = JSON.parse(
    pyodide.runPython(`web_runner.collect('/tmp/upload.csv', ${JSON.stringify(name)})`)
  );

  if (collect.raster_svgs.length > 0) {
    // These SVGs use gradients/clipPaths; the desktop tool rasterizes them with
    // rsvg-convert. In the browser the main thread does it with a canvas.
    const svgs = collect.raster_svgs.map((path: string) => ({
      path,
      svgText: new TextDecoder().decode(pyodide.FS.readFile(path)),
    }));
    const pngs = await new Promise<{ path: string; png: ArrayBuffer }[]>((resolve) => {
      rasterResolve = resolve;
      post({ type: "need-raster", svgs });
    });
    for (const { path, png } of pngs) {
      if (png.byteLength > 0) pyodide.FS.writeFile(path + ".png", new Uint8Array(png));
    }
  }

  if (collect.images && collect.images.length > 0) {
    // Customer-uploaded artwork. The main thread downloads each URL (CORS-open
    // CDNs) and, when remove_bg is set, strips the background, then hands back
    // PNG bytes. A failed download yields an empty buffer -> the Python side
    // falls back to the yellow order-number tag for that item.
    const images = await new Promise<{ path: string; png: ArrayBuffer }[]>((resolve) => {
      imagesResolve = resolve;
      post({ type: "need-images", images: collect.images });
    });
    for (const { path, png } of images) {
      if (png.byteLength > 0) pyodide.FS.writeFile(path, new Uint8Array(png));
    }
  }

  const render = JSON.parse(pyodide.runPython(`web_runner.render(${JSON.stringify(name)})`));
  const pdf: Uint8Array = pyodide.FS.readFile(render.pdf_path);
  pyodide.FS.unlink(render.pdf_path);

  post(
    {
      type: "done",
      name,
      pdf: pdf.buffer,
      count: collect.count,
      // Collect-time errors + items whose artwork failed at render time —
      // both end up as fluro-yellow tags on the sheet.
      errors: collect.errors + (render.render_failures || 0),
      widthMm: render.width_mm,
      heightMm: render.height_mm,
    },
    [pdf.buffer]
  );
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      await ensureInit();
    } else if (msg.type === "generate") {
      await ensureInit();
      await generate(msg.name, msg.csv);
    } else if (msg.type === "raster-done") {
      rasterResolve?.(msg.pngs);
      rasterResolve = null;
    } else if (msg.type === "images-done") {
      imagesResolve?.(msg.images);
      imagesResolve = null;
    }
  } catch (err: any) {
    post({ type: "error", name: msg?.name, text: err?.message || String(err) });
  }
};
