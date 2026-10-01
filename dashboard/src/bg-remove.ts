// Pixel-level helpers for background-removing customer "Custom Image" uploads
// (used by fetchImageAsPng in Gangsheet.tsx). Pure functions over RGBA buffers
// so they can be tested outside the browser.
//
// Failure modes these guard against — all "logo loses parts it shouldn't":
//   • Upload already transparent: transparent pixels are usually RGB 0,0,0, so
//     the old corner check saw a "flat black background" and flood-filled away
//     every black outline/text touching the edge. → alreadyTransparent().
//   • Flood-fill leaking: the old fill kept spreading through anything within
//     tolerance+feather (~58 RGB) of the background, eating light-grey/cream
//     parts of a logo on white. → tolerance from the background's own noise,
//     feather pixels only ramp alpha and never spread the fill.
//   • A logo touching a corner disqualified the flat-background path and sent
//     a plain logo to the neural model. → judge the whole border ring.
//   • Neural models (BRIA / imgly) cut out enclosed parts of a logo they don't
//     think are "the subject" (white fills inside lettering, inner text).
//     → restoreEnclosed(): removed islands fully surrounded by kept artwork
//     come back unless they look like the background.

export interface Img {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, not premultiplied
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

const dist = (px: Uint8ClampedArray, i: number, c: RGB) =>
  Math.sqrt((px[i] - c.r) ** 2 + (px[i + 1] - c.g) ** 2 + (px[i + 2] - c.b) ** 2);

/** Indices (pixel, not byte) of the outer `ring`-pixel border. */
function borderPixels(width: number, height: number, ring = 2): number[] {
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    const edgeRow = y < ring || y >= height - ring;
    for (let x = 0; x < width; x++) {
      if (edgeRow || x < ring || x >= width - ring) out.push(y * width + x);
    }
  }
  return out;
}

/** True when most of the border is already transparent — the upload is a
 * cut-out PNG and needs no background removal at all. */
export function alreadyTransparent(img: Img): boolean {
  const border = borderPixels(img.width, img.height);
  let clear = 0;
  for (const p of border) if (img.data[p * 4 + 3] < 128) clear++;
  return clear / border.length >= 0.6;
}

/**
 * Is the background one flat colour? Looks at the whole 2 px border ring: the
 * most common colour must cover ≥ 80% of it (so a logo touching an edge or a
 * corner is fine, but photos/gradients fail). Returns that colour and a keying
 * tolerance scaled to its noise (clean PNG ≈ 14, noisy JPEG up to 30), or null
 * → use the neural model.
 */
export function detectFlatBackground(img: Img): { bg: RGB; tol: number } | null {
  const { width, height, data: px } = img;
  const border = borderPixels(width, height);
  const counts = new Map<number, number>();
  for (const p of border) {
    const i = p * 4;
    const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let modeKey = 0, modeN = 0;
  for (const [k, n] of counts) if (n > modeN) { modeKey = k; modeN = n; }
  const seed = {
    r: ((modeKey >> 8) << 4) + 8,
    g: (((modeKey >> 4) & 15) << 4) + 8,
    b: ((modeKey & 15) << 4) + 8,
  };

  let r = 0, g = 0, b = 0, n = 0;
  for (const p of border) {
    const i = p * 4;
    if (dist(px, i, seed) <= 28) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
  }
  if (n / border.length < 0.8) return null;
  const bg = { r: r / n, g: g / n, b: b / n };

  let noise = 0;
  for (const p of border) {
    const d = dist(px, p * 4, bg);
    if (d <= 28) noise += d;
  }
  noise /= n;
  return { bg, tol: Math.min(30, Math.max(14, noise * 3 + 10)) };
}

/**
 * Flood-fill from the border, clearing background-coloured pixels reachable
 * from the edge. Enclosed regions (white inside a black-outlined logo) are
 * never reached. Pixels just past `tol` get a feathered alpha so edges aren't
 * jagged, but the fill only crosses them while the colour keeps moving away
 * from the background (a real anti-aliased edge) — it can't wander into a
 * pale part of the artwork.
 */
export function floodFillBackground(img: Img, bg: RGB, tol: number): void {
  const { width, height, data: px } = img;
  const SOFT = 22;
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const fromD: number[] = [];

  const visit = (x: number, y: number, prevD: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    const i = p * 4;
    const d = dist(px, i, bg);
    if (d <= tol) {
      visited[p] = 1;
      px[i + 3] = 0;
      stack.push(p);
      fromD.push(d);
    } else if (d <= tol + SOFT && d > prevD) {
      visited[p] = 1;
      px[i + 3] = Math.round(px[i + 3] * ((d - tol) / SOFT));
      stack.push(p);
      fromD.push(d);
    }
  };

  for (let x = 0; x < width; x++) { visit(x, 0, -1); visit(x, height - 1, -1); }
  for (let y = 0; y < height; y++) { visit(0, y, -1); visit(width - 1, y, -1); }
  while (stack.length) {
    const p = stack.pop()!;
    const d = fromD.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    // From a fully cleared pixel any feather neighbour qualifies; from a
    // feather pixel only ones further from the background do.
    const prev = d <= tol ? -1 : d;
    visit(x + 1, y, prev); visit(x - 1, y, prev); visit(x, y + 1, prev); visit(x, y - 1, prev);
  }
}

/**
 * Undo a neural model removing parts *inside* the artwork. `cut` is the model
 * output, `orig` the upload (same size). Every removed island not connected to
 * the image border is put back from the original, unless most of its pixels
 * share colours with the background the model removed around the outside —
 * those are genuine holes (e.g. the counter of an "O"). Mutates `cut`.
 */
export function restoreEnclosed(orig: Img, cut: Img): number {
  const { width, height } = cut;
  if (orig.width !== width || orig.height !== height) return 0;
  const op = orig.data, cp = cut.data;
  const N = width * height;
  const removed = new Uint8Array(N);
  for (let p = 0; p < N; p++) removed[p] = cp[p * 4 + 3] < 128 ? 1 : 0;

  // Label removed regions; 0 = kept, 1 = outer background, 2+ = enclosed.
  const label = new Int32Array(N);
  const stack = new Int32Array(N);
  const fill = (start: number, id: number): number[] => {
    const members: number[] = [];
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    while (sp) {
      const p = stack[--sp];
      members.push(p);
      const x = p % width, y = (p - x) / width;
      if (x > 0 && removed[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < width - 1 && removed[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && removed[p - width] && !label[p - width]) { label[p - width] = id; stack[sp++] = p - width; }
      if (y < height - 1 && removed[p + width] && !label[p + width]) { label[p + width] = id; stack[sp++] = p + width; }
    }
    return members;
  };

  // Outer background: everything removed that touches the border.
  const outer: number[] = [];
  for (const p of borderPixels(width, height, 1)) {
    if (removed[p] && !label[p]) for (const q of fill(p, 1)) outer.push(q);
  }
  if (!outer.length) return 0;

  // Background palette: 3-bit-per-channel buckets the outer background uses.
  const key = (i: number) => ((op[i] >> 5) << 6) | ((op[i + 1] >> 5) << 3) | (op[i + 2] >> 5);
  const counts = new Uint32Array(512);
  for (const p of outer) counts[key(p * 4)]++;
  const minCount = Math.max(1, outer.length * 0.002);
  const isBg = (i: number) => {
    const r = op[i] >> 5, g = op[i + 1] >> 5, b = op[i + 2] >> 5;
    for (let dr = -1; dr <= 1; dr++)
      for (let dg = -1; dg <= 1; dg++)
        for (let db = -1; db <= 1; db++) {
          const R = r + dr, G = g + dg, B = b + db;
          if (R < 0 || G < 0 || B < 0 || R > 7 || G > 7 || B > 7) continue;
          if (counts[(R << 6) | (G << 3) | B] >= minCount) return true;
        }
    return false;
  };

  let restored = 0;
  let id = 2;
  for (let p = 0; p < N; p++) {
    if (!removed[p] || label[p]) continue;
    const island = fill(p, id++);
    let bgLike = 0;
    for (const q of island) if (isBg(q * 4)) bgLike++;
    if (bgLike / island.length >= 0.5) continue; // a real hole
    for (const q of island) {
      const i = q * 4;
      cp[i] = op[i]; cp[i + 1] = op[i + 1]; cp[i + 2] = op[i + 2]; cp[i + 3] = op[i + 3];
    }
    restored += island.length;
  }
  return restored;
}
