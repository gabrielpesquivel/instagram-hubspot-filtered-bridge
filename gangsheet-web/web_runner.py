"""Browser entry point for the gangsheet generator (runs inside Pyodide).

Reuses the desktop tool's code untouched (app/main.py + app/src/*). The only
difference vs desktop: there is no rsvg-convert binary in the browser, so the
page pre-rasterizes gradient/clipPath SVGs with the canvas API and writes a
sidecar `<file>.svg.png` that the hook below picks up.
"""

import json
import os
import sys

os.environ.setdefault('MPLBACKEND', 'Agg')

sys.path.insert(0, '/gangsheet/app')

import pandas as pd
from PIL import Image

from src import config, layout, pdf_utils
import main as gangsheet_main

_orig_rasterize_svg = pdf_utils._rasterize_svg


def _rasterize_svg(svg_path):
    sidecar = svg_path + '.png'
    if os.path.exists(sidecar):
        return Image.open(sidecar)
    return _orig_rasterize_svg(svg_path)


pdf_utils._rasterize_svg = _rasterize_svg

# Pyodide ships an older GEOS that can hit "TopologyException: found non-noded
# intersection" during unary_union on glyph outlines — and in WASM that aborts
# the interpreter instead of raising, so it can't be caught. Snapping inputs to
# a 1e-6 pt grid (≈0.35 nanometers — far below any visible threshold) re-nodes
# the geometry first, which makes the union robust. Desktop output unaffected.
import shapely
from shapely.ops import unary_union as _unary_union
from src import geometry


def _safe_unary_union(geoms):
    if isinstance(geoms, (list, tuple)):
        geoms = [shapely.set_precision(g, 1e-6, mode='valid_output') for g in geoms]
    else:
        geoms = shapely.set_precision(geoms, 1e-6, mode='valid_output')
    return _unary_union(geoms)


geometry.unary_union = _safe_unary_union
gangsheet_main.unary_union = _safe_unary_union

# Items collected per sheet name, waiting for render()
_pending = {}


def collect(csv_path, name):
    """Parse a CSV and collect items. Returns JSON with stats and the list of
    SVGs that need rasterizing in the browser before render() is called."""
    df = pd.read_csv(csv_path, encoding='utf-8-sig')
    items = gangsheet_main.collect_items_from_csv(df)
    _pending[name] = items

    raster = set()
    for item in items:
        path = item.get('flag_path') or item.get('symbol_path')
        if path and not os.path.exists(path + '.png') and pdf_utils._is_raster_svg(path):
            raster.add(path)

    return json.dumps({
        'count': len(items),
        'errors': sum(1 for i in items if i.get('is_error')),
        'raster_svgs': sorted(raster),
    })


def render(name):
    """Lay out and render the previously collected items to a PDF."""
    items = _pending.pop(name)

    layout_mgr = layout.OptimizedLayoutManager()
    placed_items = layout_mgr.place_items(items)
    sheet_height = layout_mgr.total_height

    out_path = f'/tmp/{name}_gangsheet.pdf'
    c = pdf_utils.setup_canvas(out_path, (config.PAGE_WIDTH, sheet_height))
    for x, y, page, item in placed_items:
        gangsheet_main.render_item(c, x, y, item, draw_cutting_border=True)
    c.save()

    return json.dumps({
        'pdf_path': out_path,
        'width_mm': round(config.PAGE_WIDTH / config.MM_TO_PTS),
        'height_mm': round(sheet_height / config.MM_TO_PTS),
    })
