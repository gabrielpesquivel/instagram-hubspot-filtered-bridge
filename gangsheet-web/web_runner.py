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

# Fixed square cut-box tiers for custom images, chosen by the customer's
# requested print height (mm):
#   <=20mm -> 25x25  (inline with the regular sticker grid)
#   <=40mm -> 50x50  (grouped at the end of the sheet)
#   >40mm  -> 55x55  (grouped at the end; >50mm scaled to fit)
# The image is centered and scaled to fit inside its box leaving this margin per
# side, so it never touches the magenta cut border. 2.5mm makes each tier's max
# height land exactly on the box interior (25-5=20, 55-5=50).
CUSTOM_IMAGE_BOX_MARGIN_MM = 2.5

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
    """Fit each downloaded custom image into a fixed square cut-box chosen by its
    requested print height, centered and scaled to fit with a margin. Tags each
    with image_tier ('small' = inline 25x25, 'large' = 50/55 grouped at end).
    Items whose download failed keep their fallback (yellow order-number) size
    and get no tier, so they stay a grid-sized tag in place."""
    margin = CUSTOM_IMAGE_BOX_MARGIN_MM * config.MM_TO_PTS
    for item in items:
        # Only customer-downloaded artwork (has image_url) gets box tiers;
        # bundled images like the TEST PRINT logo keep their own cell size.
        if item.get('type') != 'image' or not item.get('image_url'):
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

        # Pick the box tier from the requested print height (mm).
        height_mm = item['image_height_pts'] / config.MM_TO_PTS
        if height_mm <= 20:
            box_mm, tier = 25, 'small'
        elif height_mm <= 40:
            box_mm, tier = 50, 'large'
        else:
            box_mm, tier = 55, 'large'   # 41-50mm, and anything over 50mm
        box = box_mm * config.MM_TO_PTS
        inner = box - 2 * margin

        # Center the image at its requested height, scaling down (aspect
        # preserved) only if it would exceed the box interior either way.
        target_h = item['image_height_pts']
        img_w = target_h * (pw / ph)
        scale = min(
            1.0,
            inner / target_h if target_h > inner else 1.0,
            inner / img_w if img_w > inner else 1.0,
        )
        item['image_height_pts'] = target_h * scale
        item['width'] = box
        item['height'] = box
        item['image_tier'] = tier


def render(name):
    """Lay out and render the previously collected items to a PDF."""
    items = _pending.pop(name)

    # Custom-image artwork has now been downloaded to /tmp by the browser; size
    # each item from the real image before layout (downloads that failed keep
    # their yellow fallback size).
    _measure_image_items(items)

    # Small custom images (<=20mm -> 25x25) stay inline in the regular grid, in
    # their original order. Larger ones (50x50 / 55x55) are grouped at the end,
    # tallest first, so they pack into their own rows instead of disrupting the
    # dense sticker grid. The first large image starts a new row, so the switch
    # from the 25x25 grid into the bigger boxes never disturbs the layout above.
    def _is_large_image(it):
        return (it.get('type') == 'image' and it.get('image_tier') == 'large'
                and it.get('image_path') and os.path.exists(it['image_path']))

    rest = [it for it in items if not _is_large_image(it)]
    large = sorted((it for it in items if _is_large_image(it)),
                   key=lambda it: it.get('height', 0), reverse=True)
    if large:
        large[0]['new_row'] = True
    items = rest + large

    layout_mgr = layout.OptimizedLayoutManager()
    placed_items = layout_mgr.place_items(items)

    out_path = f'/tmp/{name}_gangsheet.pdf'
    c = pdf_utils.setup_canvas(out_path, (config.PAGE_WIDTH, config.PAGE_HEIGHT))
    render_failures = gangsheet_main.render_sheet(
        c, placed_items, layout_mgr.num_pages, layout_mgr.page_heights)
    c.save()

    return json.dumps({
        'pdf_path': out_path,
        'width_mm': round(config.PAGE_WIDTH / config.MM_TO_PTS),
        # Tallest page: the full 850 for multi-sheet jobs, the cropped
        # quick-start sheet for single-sheet jobs.
        'height_mm': round(max(layout_mgr.page_heights) / config.MM_TO_PTS),
        'pages': layout_mgr.num_pages,
        # Items whose artwork failed to draw (fluro-yellow tag substituted)
        'render_failures': render_failures,
    })
