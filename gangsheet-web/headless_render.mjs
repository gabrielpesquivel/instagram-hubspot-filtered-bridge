// Headless replica of dashboard/src/gangsheet.worker.ts — runs the SAME Pyodide
// pipeline (same pinned versions) outside the browser so we can diff the web
// PDF's colors against the desktop exe's PDF. No raster path is exercised
// because no bundled asset uses gradients/clipPaths/images.
import { loadPyodide } from "pyodide";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const csvPath = process.argv[2];
const name = process.argv[3] || "Test";
const outPdf = process.argv[4] || `/tmp/${name}_web.pdf`;

async function main() {
  const pyodide = await loadPyodide();

  console.log("loadPackage…");
  await pyodide.loadPackage([
    "pandas", "numpy", "matplotlib", "shapely", "Pillow", "lxml", "micropip",
  ]);

  console.log("micropip install (reportlab==4.4.4, svglib, …)…");
  const micropip = pyodide.pyimport("micropip");
  await micropip.install(["reportlab==4.4.4", "pdfrw", "tinycss2", "cssselect2", "webencodings"]);
  await micropip.install.callKwargs(["svglib"], { deps: false });

  // Print the resolved versions — this is the crux of the comparison.
  console.log("--- web environment versions ---");
  console.log(pyodide.runPython(`
import importlib.metadata as m
out=[]
for p in ["reportlab","svglib","tinycss2","cssselect2","webencodings","lxml","Pillow","pdfrw"]:
    try: out.append(f"{p}=={m.version(p)}")
    except Exception as e: out.append(f"{p}=?({e})")
"\\n".join(out)
`));

  console.log("unpack bundle.zip…");
  const bundle = fs.readFileSync(path.join(ROOT, "dashboard/public/gangsheet/bundle.zip"));
  pyodide.FS.mkdirTree("/gangsheet");
  // unpackArchive needs an ArrayBuffer, not a Node Buffer
  const ab = bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength);
  pyodide.unpackArchive(ab, "zip", { extractDir: "/gangsheet" });

  pyodide.setStdout({ batched: (s) => console.log("[py]", s) });
  pyodide.setStderr({ batched: (s) => console.log("[py-err]", s) });

  await pyodide.runPythonAsync("import sys; sys.path.insert(0,'/gangsheet'); import web_runner");

  const csv = fs.readFileSync(csvPath);
  pyodide.FS.writeFile("/tmp/in.csv", new Uint8Array(csv));

  const collect = JSON.parse(pyodide.runPython(`web_runner.collect('/tmp/in.csv', ${JSON.stringify(name)})`));
  console.log("collect:", collect);
  if (collect.raster_svgs.length) {
    console.log("WARNING raster_svgs (would need canvas):", collect.raster_svgs);
  }

  const render = JSON.parse(pyodide.runPython(`web_runner.render(${JSON.stringify(name)})`));
  const pdf = pyodide.FS.readFile(render.pdf_path);
  fs.writeFileSync(outPdf, Buffer.from(pdf));
  console.log("wrote", outPdf, render);
}

main().catch((e) => { console.error(e); process.exit(1); });
