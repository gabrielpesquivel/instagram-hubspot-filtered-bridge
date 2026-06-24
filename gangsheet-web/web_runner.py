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

from pdfrw import PdfReader
from pdfrw.buildxobj import pagexobj
from pdfrw.toreportlab import makerl

_orig_rasterize_svg = pdf_utils._rasterize_svg


def _rasterize_svg(svg_path):
    sidecar = svg_path + '.png'
    if os.path.exists(sidecar):
        return Image.open(sidecar)
    return _orig_rasterize_svg(svg_path)


pdf_utils._rasterize_svg = _rasterize_svg


def _draw_svg_via_pdf(c, svg_path, x, y, target_width, target_height):
    """Embed the build-time rsvg-convert PDF sidecar exactly as the desktop tool
    does (same rsvg bytes, same pdfrw form XObject), so the browser output is
    byte-identical to the exe for gradient/clipPath SVGs. No rsvg-convert binary
    is needed at runtime — the conversion happened in build-gangsheet-bundle.sh."""
    sidecar = svg_path + '.pdf'
    if not os.path.exists(sidecar):
        return False
    with open(sidecar, 'rb') as f:
        reader = PdfReader(fdata=f.read())
    page = reader.pages[0]
    xobj = pagexobj(page)
    rl_obj = makerl(c, xobj)

    orig_w = float(xobj.BBox[2]) - float(xobj.BBox[0])
    orig_h = float(xobj.BBox[3]) - float(xobj.BBox[1])
    if orig_w == 0 or orig_h == 0:
        return False

    c.saveState()
    c.translate(x, y)
    c.scale(target_width / orig_w, target_height / orig_h)
    c.doForm(rl_obj)
    c.restoreState()
    return True


pdf_utils._draw_svg_via_pdf = _draw_svg_via_pdf

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

# Border around each custom image, per side (mm), baked into its cut cell so the
# images sit as far apart as the regular grid decals. Bump to spread them more.
CUSTOM_IMAGE_PAD_MM = 7.5

# Items collected per sheet name, waiting for render()
_pending = {}


def collect(csv_path, name):
    """Parse a CSV and collect items. Returns JSON with stats, the list of SVGs
    that need rasterizing, and the list of customer-uploaded images that need
    downloading in the browser before render() is called."""
    df = pd.read_csv(csv_path, encoding='utf-8-sig')
    items = gangsheet_main.collect_items_from_csv(df)
    _pending[name] = items

    # Gradient/clipPath SVGs are now embedded from build-time rsvg PDF sidecars
    # (see _draw_svg_via_pdf above), matching the desktop exe exactly. Only fall
    # back to browser-canvas rasterization if a sidecar is somehow missing.
    raster = set()
    for item in items:
        path = item.get('flag_path') or item.get('symbol_path')
        if (path and not os.path.exists(path + '.pdf')
                and not os.path.exists(path + '.png')
                and pdf_utils._is_raster_svg(path)):
            raster.add(path)

    # Customer-uploaded "Custom Image" artwork: hand the URLs (and remove-bg flag)
    # to the main thread, which fetches + optionally background-removes them and
    # writes a PNG to each item's image_path before render(). Browser-only, no
    # Shopify API: the URL is already in the order's line-item properties.
    images = []
    for idx, item in enumerate(items):
        if item.get('type') == 'image' and item.get('image_url'):
            path = f'/tmp/custom_{name}_{idx}.png'
            item['image_path'] = path
            images.append({
                'path': path,
                'url': item['image_url'],
                'remove_bg': bool(item.get('image_remove_bg')),
            })

    return json.dumps({
        'count': len(items),
        'errors': sum(1 for i in items if i.get('is_error')),
        'raster_svgs': sorted(raster),
        'images': images,
    })


def _measure_image_items(items):
    """Size downloaded image items from their real aspect ratio, scaling height
    down if an image would exceed the usable sheet width. Items whose download
    failed keep their fallback (yellow order-number) size."""
    usable = config.PAGE_WIDTH - 2 * config.MARGIN
    # Border baked into each image's cut cell, per side. Matches the breathing
    # room the grid decals have (a 10mm symbol in a 25mm cell = 7.5mm/side), so
    # adjacent custom images get the same ~15mm gap and are easy to weed/cut.
    pad = CUSTOM_IMAGE_PAD_MM * config.MM_TO_PTS
    for item in items:
        if item.get('type') != 'image':
            continue
        path = item.get('image_path')
        if not path or not os.path.exists(path):
            continue
        try:
            with Image.open(path) as im:
                pw, ph = im.size
        except Exception:
            continue
        if not ph:
            continue
        target_h = item['image_height_pts']
        img_w = target_h * (pw / ph)
        max_w = usable - 2 * pad
        if img_w > max_w:
            target_h *= max_w / img_w
            img_w = max_w
            item['image_height_pts'] = target_h
        item['width'] = img_w + 2 * pad
        item['height'] = target_h + 2 * pad


def render(name):
    """Lay out and render the previously collected items to a PDF."""
    items = _pending.pop(name)

    # Custom-image artwork has now been downloaded to /tmp by the browser; size
    # each item from the real image before layout (downloads that failed keep
    # their yellow fallback size).
    _measure_image_items(items)

    # Custom images are much larger than stickers, so group them all at the end
    # (tallest first) — they pack into their own rows instead of disrupting the
    # dense sticker grid. Only successfully-downloaded images are moved; a failed
    # one stays a grid-sized yellow tag in place.
    def _is_image(it):
        return (it.get('type') == 'image' and it.get('image_path')
                and os.path.exists(it['image_path']))

    rest = [it for it in items if not _is_image(it)]
    imgs = sorted((it for it in items if _is_image(it)),
                  key=lambda it: it.get('height', 0), reverse=True)
    items = rest + imgs

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
