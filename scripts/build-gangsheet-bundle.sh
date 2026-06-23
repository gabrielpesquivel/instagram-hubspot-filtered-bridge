#!/usr/bin/env bash
# Packages the gangsheet generator's Python code + assets into a zip that the
# browser (Pyodide) downloads and unpacks. Source of truth stays in
# ../BootinkGangsheetGenerator — rerun this after changing that project.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEN="${GANGSHEET_SRC:-$ROOT/../BootinkGangsheetGenerator}"
# Lives in dashboard/public so vite copies it into the build output (and
# serves it in dev). Must be built BEFORE build:dashboard.
OUT_DIR="$ROOT/dashboard/public/gangsheet"

if [ ! -f "$GEN/app/main.py" ]; then
  echo "ERROR: gangsheet source not found at $GEN (set GANGSHEET_SRC to override)" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/app/src" "$OUT_DIR"
cp "$GEN/app/main.py" "$STAGE/app/"
cp "$GEN/app/src/"*.py "$STAGE/app/src/"
cp -R "$GEN/assets" "$STAGE/assets"
rm -f "$STAGE/assets/bootinkLogo.ico"
find "$STAGE" -name '.DS_Store' -delete
cp "$ROOT/gangsheet-web/web_runner.py" "$STAGE/"

# The browser has no rsvg-convert, but the desktop exe renders gradient/clipPath
# SVGs by piping them through `rsvg-convert --format=pdf` and embedding the
# result as a vector form XObject. To make the web output byte-identical, we run
# the SAME conversion here at build time and ship a `<file>.svg.pdf` sidecar that
# web_runner.py embeds exactly as the desktop does. Required for color parity.
if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "ERROR: rsvg-convert not found — needed to pre-render gradient/clipPath" >&2
  echo "       SVGs so the web output matches the desktop exe. Install librsvg" >&2
  echo "       (macOS: brew install librsvg; Debian: apt install librsvg2-bin)." >&2
  exit 1
fi
(cd "$STAGE" && python3 -c "
import os, sys, subprocess
sys.path.insert(0, 'app')
from src import pdf_utils
count = 0
for dirpath, _, filenames in os.walk('assets'):
    for name in filenames:
        if not name.lower().endswith('.svg'):
            continue
        svg = os.path.join(dirpath, name)
        if not pdf_utils._is_raster_svg(svg):
            continue  # plain SVGs go through svg2rlg identically on both sides
        r = subprocess.run(['rsvg-convert', '--format=pdf', svg], capture_output=True)
        if r.returncode != 0:
            sys.exit('rsvg-convert failed for %s: %s' % (svg, r.stderr.decode()))
        with open(svg + '.pdf', 'wb') as f:
            f.write(r.stdout)
        count += 1
print('  pre-rendered %d gradient/clipPath SVGs to vector PDF sidecars' % count)
")

# Python zipfile (not the zip CLI): it sets the UTF-8 filename flag, which
# Pyodide's unzip needs for accented filenames like TÜRKIYE.svg.
(cd "$STAGE" && python3 -c "
import os, zipfile
with zipfile.ZipFile('bundle.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for top in ['app', 'assets', 'web_runner.py']:
        if os.path.isfile(top):
            zf.write(top)
            continue
        for dirpath, dirnames, filenames in os.walk(top):
            for name in sorted(filenames):
                zf.write(os.path.join(dirpath, name))
")
mv "$STAGE/bundle.zip" "$OUT_DIR/bundle.zip"

echo "Built $OUT_DIR/bundle.zip ($(du -h "$OUT_DIR/bundle.zip" | cut -f1 | tr -d ' '))"
