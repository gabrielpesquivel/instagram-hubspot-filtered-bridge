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
