// Runs MuPDF (WASM) off the main thread: a 580×650 mm page at 300 dpi is a
// ~200 MB pixmap and takes a few seconds to render + PNG-encode.

import * as mupdf from "mupdf";
import { processAi } from "./cutfile-render";

self.onmessage = (e: MessageEvent<{ id: string; bytes: ArrayBuffer }>) => {
  const { id, bytes } = e.data;
  try {
    processAi(mupdf, new Uint8Array(bytes), (out, total) => {
      (self as unknown as Worker).postMessage({ type: "page", id, total, out }, [out.png.buffer]);
    });
    self.postMessage({ type: "done", id });
  } catch (err) {
    self.postMessage({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  }
};

// mupdf loads its WASM via top-level await, so reaching here means ready.
self.postMessage({ type: "ready" });
