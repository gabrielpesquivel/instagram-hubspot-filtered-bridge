// Print Prep: turns a checked/fixed gangsheet .ai into what the print
// room used to make by hand in a second Illustrator session + AidCut:
//   - one PNG per page (300 dpi, transparent, registration marks added)
//   - one AidCut-style .plt per page (a cut box for every magenta cell)
//
// Everything is derived from the .ai itself, so hand edits made in Illustrator
// (moved/added/removed stickers and their magenta cut boxes) carry through.
//
// Reverse-engineered from AidCut output for 30623-30747 (Sep 2026):
//   - Marks: solid black 5 mm discs, centred 5 mm outside the bounding box of
//     the magenta cut boxes (left/right columns, top/bottom rows). When the
//     mark-to-mark height exceeds MAX_SEGMENT_MM the sheet is split into equal
//     segments with an extra pair of marks at each split (the cutter misplaces
//     a segment whose length differs from the first — see planMarks).
//   - PLT: HPGL-ish, 40 units/mm. One "TB26,0,W,H;...PG;" block per segment,
//     bottom segment first. Origin = that segment's bottom-right mark; +X runs
//     up the sheet (feed, bottom comes out first), +Y runs right-to-left.
//     W = segment length, H = mark-to-mark width. Each cell is cut as a
//     rectangle with 8-unit (0.2 mm) looped overcuts at the corners.

import type * as MuPDF from "mupdf";

type Mupdf = typeof MuPDF;

const PT_PER_MM = 72 / 25.4;
const UNITS_PER_MM = 40;
const DPI = 300;
const MARK_OFFSET_MM = 5; // mark centre distance outside the cut-box bbox
const MARK_DIAMETER_MM = 5;
const MAX_SEGMENT_MM = 450; // 460 mm span was split in two, 410 mm was not
const GRID_MM = 25;

/** Cut box in page millimetres, y down from the top of the page. */
export interface CutRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MarkPlan {
  left: number; // mark x centres (mm)
  right: number;
  /** Mark y centres (mm), bottom first — segment i spans ys[i] → ys[i+1]. */
  ys: number[];
}

export interface PageOutput {
  page: number; // 1-based
  boxes: number;
  segments: number;
  png: Uint8Array;
  plt: string;
  widthMm: number;
  heightMm: number;
}

// --- cut boxes -------------------------------------------------------------

function isCutColor(cs: MuPDF.ColorSpace, c: number[]): boolean {
  if (cs.isCMYK()) return c[0] < 0.15 && c[1] > 0.85 && c[2] < 0.15 && c[3] < 0.15;
  if (cs.isRGB()) return c[0] > 0.8 && c[1] < 0.2 && c[2] > 0.3;
  return false;
}

/** Every magenta stroked path on the page, as its bounding box in mm. */
export function extractCutRects(mupdf: Mupdf, page: MuPDF.Page): CutRect[] {
  const rects: CutRect[] = [];
  const seen = new Set<string>();
  const device = new mupdf.Device({
    strokePath(path, _stroke, ctm, colorspace, color) {
      if (!isCutColor(colorspace, color)) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const add = (x: number, y: number) => {
        const px = ctm[0] * x + ctm[2] * y + ctm[4];
        const py = ctm[1] * x + ctm[3] * y + ctm[5];
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      };
      path.walk({
        moveTo: add,
        lineTo: add,
        curveTo: (_a, _b, _c, _d, x, y) => add(x, y),
      });
      if (!isFinite(x0) || x1 - x0 < 1 || y1 - y0 < 1) return;
      const r = { x0: x0 / PT_PER_MM, y0: y0 / PT_PER_MM, x1: x1 / PT_PER_MM, y1: y1 / PT_PER_MM };
      // Illustrator sometimes stacks duplicates — cutting twice tears the film.
      const key = [r.x0, r.y0, r.x1, r.y1].map((v) => v.toFixed(1)).join(",");
      if (seen.has(key)) return;
      seen.add(key);
      rects.push(r);
    },
  });
  page.run(device, mupdf.Matrix.identity);
  device.close();
  return rects;
}

// --- marks -----------------------------------------------------------------

export function planMarks(rects: CutRect[]): MarkPlan {
  const minX = Math.min(...rects.map((r) => r.x0));
  const maxX = Math.max(...rects.map((r) => r.x1));
  const minY = Math.min(...rects.map((r) => r.y0));
  const maxY = Math.max(...rects.map((r) => r.y1));
  const top = minY - MARK_OFFSET_MM;
  const bottom = maxY + MARK_OFFSET_MM;
  const n = Math.max(1, Math.ceil((bottom - top) / MAX_SEGMENT_MM - 1e-6));
  const ys = [bottom];
  for (let i = 1; i < n; i++) {
    // Even split, snapped up to a row boundary so no cell straddles two
    // segments and the bottom segment is never the shorter one.
    const target = bottom - ((bottom - top) * i) / n;
    ys.push(minY + Math.floor((target - minY) / GRID_MM + 1e-6) * GRID_MM);
  }
  // Segments must all be the same length: 30888-31029 p2 (hand-stretched
  // boxes, 260 mm + 255 mm segments) cut its top segment low while equal
  // splits cut true. Pad the top segment upward into the 150 mm top margin.
  const padded = n > 1 ? ys[n - 1] - (ys[0] - ys[1]) : top;
  ys.push(padded >= MARK_DIAMETER_MM ? Math.min(top, padded) : top);
  return { left: minX - MARK_OFFSET_MM, right: maxX + MARK_OFFSET_MM, ys };
}

// --- plt -------------------------------------------------------------------

function boxCommands(X0: number, X1: number, Y0: number, Y1: number): string {
  const pts: [number, number][] = [
    [X0, Y1 - 8], [X0, Y0 - 8], [X0 + 4, Y0 - 7], [X0 + 7, Y0 - 4], [X0 + 8, Y0],
    [X1 + 8, Y0], [X1 + 7, Y0 + 4], [X1 + 4, Y0 + 7], [X1, Y0 + 8],
    [X1, Y1 + 8], [X1 - 4, Y1 + 7], [X1 - 7, Y1 + 4], [X1 - 8, Y1],
    [X0 - 8, Y1], [X0 - 7, Y1 - 4], [X0 - 4, Y1 - 7], [X0, Y1 - 8], [X0, Y1 - 16],
  ];
  const [sx, sy] = pts[0];
  const [ex, ey] = pts[pts.length - 1];
  return `U${sx},${sy};` + pts.map(([x, y]) => `D${x},${y};`).join("") + `U${ex},${ey};`;
}

export function buildPlt(rects: CutRect[], plan: MarkPlan): string {
  const H = Math.round((plan.right - plan.left) * UNITS_PER_MM);
  const segCount = plan.ys.length - 1;
  let out = "";
  for (let s = 0; s < segCount; s++) {
    const bottom = plan.ys[s];
    const top = plan.ys[s + 1];
    const W = Math.round((bottom - top) * UNITS_PER_MM);
    const mine = rects.filter((r) => {
      const cy = (r.y0 + r.y1) / 2;
      return (s === 0 || cy < bottom) && (s === segCount - 1 || cy >= top);
    });
    // AidCut lands a hair short on the feed axis; truncating matches its output.
    const boxes = mine.map((r) => ({
      X0: Math.trunc((bottom - r.y1) * UNITS_PER_MM - 0.5),
      X1: Math.trunc((bottom - r.y0) * UNITS_PER_MM - 0.5),
      Y0: Math.round((plan.right - r.x1) * UNITS_PER_MM),
      Y1: Math.round((plan.right - r.x0) * UNITS_PER_MM),
    }));
    // Serpentine through 50 mm feed bands to keep knife travel short.
    const band = (b: { X0: number }) => Math.floor(b.X0 / 2000);
    boxes.sort((a, b) => {
      const ba = band(a), bb = band(b);
      if (ba !== bb) return ba - bb;
      if (a.Y0 !== b.Y0) return ba % 2 === 0 ? a.Y0 - b.Y0 : b.Y0 - a.Y0;
      return a.X0 - b.X0;
    });
    out +=
      `TB26,0,${W},${H};CT1;;:H A L0 ECN U U-7,8;D-7,8;D-7,0;U-7,0;` +
      boxes.map((b) => boxCommands(b.X0, b.X1, b.Y0, b.Y1)).join("") +
      `U${W},0;PG;`;
  }
  return out + "@".repeat(21);
}

// --- png -------------------------------------------------------------------

/**
 * Illustrator's PNG export (with "Output All Blacks As Rich Black") turns
 * pure-K ink (C=M=Y=0) into neutral RGB grey, K100 → 0,0,0; every other
 * CMYK colour goes through the normal SWOP → sRGB conversion. So render in
 * the document's CMYK (same transparency blending as Illustrator), convert,
 * then overwrite pure-K pixels. Both pixmaps are premultiplied: for pure K
 * the premultiplied grey is simply alpha − k.
 */
function applyRichBlack(cmyk: Uint8ClampedArray, cmykStride: number, rgb: Uint8ClampedArray, rgbStride: number, w: number, h: number) {
  for (let y = 0; y < h; y++) {
    let ci = y * cmykStride, ri = y * rgbStride;
    for (let x = 0; x < w; x++, ci += 5, ri += 4) {
      const a = cmyk[ci + 4];
      if (a === 0 || cmyk[ci] || cmyk[ci + 1] || cmyk[ci + 2]) continue;
      const g = a - cmyk[ci + 3];
      rgb[ri] = g;
      rgb[ri + 1] = g;
      rgb[ri + 2] = g;
    }
  }
}

/** Anti-aliased solid black disc composited over premultiplied RGBA. */
function drawDisc(px: Uint8ClampedArray, w: number, h: number, stride: number, cx: number, cy: number, r: number) {
  const SS = 4;
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    if (y < 0 || y >= h) continue;
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      if (x < 0 || x >= w) continue;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - cx, dy = y + (sy + 0.5) / SS - cy;
          if (dx * dx + dy * dy <= r * r) hits++;
        }
      if (!hits) continue;
      const cov = hits / (SS * SS);
      const i = y * stride + x * 4;
      px[i] *= 1 - cov;
      px[i + 1] *= 1 - cov;
      px[i + 2] *= 1 - cov;
      px[i + 3] = cov * 255 + px[i + 3] * (1 - cov);
    }
  }
}

function renderPng(mupdf: Mupdf, page: MuPDF.Page, plan: MarkPlan): Uint8Array {
  const scale = DPI / 72;
  const cmyk = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceCMYK, true, false);
  let pix: MuPDF.Pixmap;
  try {
    pix = cmyk.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, true);
    applyRichBlack(cmyk.getPixels(), cmyk.getStride(), pix.getPixels(), pix.getStride(), pix.getWidth(), pix.getHeight());
  } finally {
    cmyk.destroy();
  }
  try {
    const px = pix.getPixels();
    const w = pix.getWidth(), h = pix.getHeight(), stride = pix.getStride();
    const toPx = (mm: number) => (mm / 25.4) * DPI;
    const r = toPx(MARK_DIAMETER_MM / 2);
    for (const y of plan.ys) {
      drawDisc(px, w, h, stride, toPx(plan.left), toPx(y), r);
      drawDisc(px, w, h, stride, toPx(plan.right), toPx(y), r);
    }
    pix.setResolution(DPI, DPI);
    return pix.asPNG().slice();
  } finally {
    pix.destroy();
  }
}

// --- driver ----------------------------------------------------------------

/**
 * Process every page of a gangsheet .ai (PDF-compatible). `onPage` fires as
 * each page finishes so the UI can show progress on long files.
 */
export function processAi(
  mupdf: Mupdf,
  bytes: Uint8Array,
  onPage: (out: PageOutput, total: number) => void
): void {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const total = doc.countPages();
    if (total === 0) throw new Error("No pages in file");
    for (let i = 0; i < total; i++) {
      const page = doc.loadPage(i);
      try {
        const rects = extractCutRects(mupdf, page);
        if (!rects.length) {
          throw new Error(
            `Page ${i + 1} has no magenta cut boxes — is this a gangsheet .ai (saved with "Create PDF Compatible File" on)?`
          );
        }
        const plan = planMarks(rects);
        const [bx0, by0, bx1, by1] = page.getBounds();
        onPage(
          {
            page: i + 1,
            boxes: rects.length,
            segments: plan.ys.length - 1,
            png: renderPng(mupdf, page, plan),
            plt: buildPlt(rects, plan),
            widthMm: (bx1 - bx0) / PT_PER_MM,
            heightMm: (by1 - by0) / PT_PER_MM,
          },
          total
        );
      } finally {
        page.destroy();
      }
    }
  } finally {
    doc.destroy();
  }
}

// --- file names ------------------------------------------------------------

/** "30623-30747 - 2-02.png" — matches the Illustrator artboard export names. */
export function pngName(base: string, page: number): string {
  return `${base} - ${page}-${String(page).padStart(2, "0")}.png`;
}

/** Order range in a gangsheet file name ("30623-30747 fixed.ai"), if any. */
export function orderRangeInName(base: string): { start: string; end: string } | null {
  const m = base.match(/(\d{3,})\s*-\s*(\d{3,})/);
  return m ? { start: m[1], end: m[2] } : null;
}

/**
 * "30650.plt" — the order number printed top-left of that page (its header
 * "#<order>"), looked up from the gangsheet render via /api/gangsheet/
 * page-orders. The cutter ignores long file names, so nothing else goes in.
 * Without a lookup, page 1 is the range start from the file name and later
 * pages fall back to "<start>-p<n>.plt".
 */
export function pltName(base: string, page: number, pageOrders?: (string | null)[]): string {
  const known = pageOrders?.[page - 1];
  if (known) return `${known}.plt`;
  const start = orderRangeInName(base)?.start ?? base.match(/^(\d+)/)?.[1];
  if (!start) return `page-${page}.plt`;
  return page === 1 ? `${start}.plt` : `${start}-p${page}.plt`;
}
