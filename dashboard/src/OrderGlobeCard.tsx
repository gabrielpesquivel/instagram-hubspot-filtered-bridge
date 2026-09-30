import { Component, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { GlobeInstance } from "globe.gl";
import { HIDDEN_CITY_TAGS, NOTABLE_PLACES, hasOrderNear, nearestCity } from "./globeCities";

// Home-page hero above the site monitor: every order ever placed on a spinning
// globe as a flat green hexagon heatmap (hottest where orders cluster), live
// shipments as amber arcs streaming out of Canberra, and ripples on the last 24h of orders. Data from /api/orders/globe
// (see worker handlers/order-globe.ts); globe.gl/three is lazy-loaded so the
// rest of the home page doesn't wait on it.

interface GeoPoint { lat: number; lng: number; n: number; cc: string }
interface Shipment {
  o: string; lat: number; lng: number; cc: string; city: string; carrier: string;
  shippedAt: string; status: "label" | "in_transit" | "out_for_delivery" | "delayed" | "issue";
  eta: string | null; approx: boolean;
}
interface GlobeData {
  origin: { lat: number; lng: number; name: string };
  agg: {
    total: number; located: number; points: GeoPoint[];
    byCountry: Record<string, number>; byMonth: Record<string, number>; byDay: Record<string, number>;
    recent: { lat: number; lng: number; t: number; cc: string }[];
    firstOrderAt: string | null; syncedAt: string;
  } | null;
  transit: {
    refreshedAt: string; shipments: Shipment[];
    deliveryDays: Record<string, { n: number; avg: number }>; awaitingDispatch: number | null;
  } | null;
  backfill: { status: string; startedAt: string; error?: string } | null;
  allOrdersScope: boolean | null;
  syncError: { at: string; errors: string[] } | null;
  today: string;
}

// Card chrome colours are CSS variables (theme.css, --og-*) so they follow the
// light/dark toggle. WebGL can't read CSS vars, so the globe gets its own
// per-theme palette (GLOBE_THEME) and re-colours when the theme flips.
const C = {
  amber: "var(--og-amber)",
  accent: "var(--og-accent)", // Live-status green (SiteStatusCard) — all coloured text/numbers
  text: "var(--og-text)",
  muted: "var(--og-muted)",
  faint: "var(--og-faint)",
  line: "var(--og-line)",
};

const STATUS: Record<Shipment["status"], { label: string; key: "label" | "transit" | "ofd" | "late" }> = {
  label: { label: "Label made", key: "label" },
  in_transit: { label: "In transit", key: "transit" },
  out_for_delivery: { label: "Out for delivery", key: "ofd" },
  delayed: { label: "Delayed", key: "late" },
  issue: { label: "Delivery issue", key: "late" },
};

type ThemeName = "light" | "dark";
interface GlobePalette {
  texture: string | null; // night photo in dark; plain sphere + halftone land in light
  bump: string | null;
  sphere: string; // sphere colour when untextured
  land: string | null; // halftone land dot colour (light only)
  atmosphere: string;
  atmosphereAlt: number;
  arc: string[]; // gradient along each arc, depot → destination
  recentRing: [number, number, number];
  depotRing: [number, number, number];
  hex: [number, number, number][]; // flat hex heatmap colour stops, cold → hot
}
const GLOBE_THEME: Record<ThemeName, GlobePalette> = {
  dark: {
    texture: "/globe/earth-night.jpg",
    bump: "/globe/earth-topology.png",
    sphere: "#ffffff",
    land: null,
    atmosphere: "#ff3fa8",
    atmosphereAlt: 0.16,
    arc: ["#ea580c", "#fb923c", "#facc15", "#4ade80"],
    recentRing: [102, 187, 106],
    depotRing: [255, 181, 71],
    hex: [[18, 56, 24], [46, 125, 50], [102, 187, 106], [200, 245, 200]],
  },
  light: {
    texture: null,
    bump: null,
    sphere: "#f4f6fa",
    land: "#c4cad6",
    atmosphere: "#a9b8d6",
    atmosphereAlt: 0.12,
    arc: ["#c2410c", "#f97316", "#eab308", "#16a34a"],
    recentRing: [46, 125, 50],
    depotRing: [232, 113, 10],
    hex: [[200, 230, 201], [129, 199, 132], [46, 125, 50], [20, 80, 26]],
  },
};

function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Tracks the app's <html data-theme> attribute (set by theme.ts). */
function useThemeName(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(currentTheme);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(currentTheme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

// Perf budget: each arc is its own animated mesh, each ripple a ring layer.
const MAX_ARCS = 150;
const MAX_RINGS = 40;
const MAX_PIXEL_RATIO = 1.5; // retina at 2× costs ~78% more fill for little gain

const TOP_CITY_TAGS = 8;

// Scripted globe tour (lat/lng of each stop) and zoom limits.
const TOUR = [
  { lat: -27, lng: 140 }, // Australia
  { lat: 50, lng: 0 }, // UK
  { lat: 38, lng: -97 }, // US
];
const TOUR_TRAVEL_MS = 6000;
const TOUR_HOLD_MS = 4000;
const DEFAULT_ALTITUDE = 2.25;
const MIN_ALTITUDE = 0.5;
const MAX_ALTITUDE = 3.5;

/** Multiply the camera distance by `factor` (<1 zooms in), clamped. */
function zoomBy(g: GlobeInstance, factor: number, ms = 400): void {
  const pov = g.pointOfView();
  const altitude = Math.min(MAX_ALTITUDE, Math.max(MIN_ALTITUDE, pov.altitude * factor));
  g.pointOfView({ lat: pov.lat, lng: pov.lng, altitude }, ms);
}

interface CityTag { tag: string; lat: number; lng: number; kind: "depot" | "top" | "notable"; name?: string }

/** Canberra + the cities with the most all-time orders + notable far-flung
 *  places we've delivered to (grid cells snapped to
 *  the nearest known city, summed per city). */
function cityTags(points: GeoPoint[], origin: { lat: number; lng: number }): CityTag[] {
  const totals = new Map<string, { lat: number; lng: number; n: number }>();
  for (const p of points) {
    const c = nearestCity(p.lat, p.lng);
    if (!c || c.tag === "CBR" || HIDDEN_CITY_TAGS.has(c.tag)) continue;
    const t = totals.get(c.tag);
    if (t) t.n += p.n;
    else totals.set(c.tag, { lat: c.lat, lng: c.lng, n: p.n });
  }
  const top = [...totals.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, TOP_CITY_TAGS)
    .map(([tag, c]): CityTag => ({ tag, lat: c.lat, lng: c.lng, kind: "top" }));
  const taken = new Set(top.map((t) => t.tag));
  const notable = NOTABLE_PLACES
    .filter(([tag, , lat, lng, km, cc]) => !taken.has(tag) && hasOrderNear(points, lat, lng, km, cc))
    .map(([tag, name, lat, lng]): CityTag => ({ tag, name, lat, lng, kind: "notable" }));
  return [{ tag: "CBR", name: "Canberra — dispatch", lat: origin.lat, lng: origin.lng, kind: "depot" }, ...top, ...notable];
}

/** Arcs to draw: live movement (out for delivery / delayed / issues) first,
 *  then an even spread across the rest so every destination still shows. */
function pickArcs(ships: Shipment[]): Shipment[] {
  if (ships.length <= MAX_ARCS) return ships;
  const hot = ships.filter((s) => s.status === "out_for_delivery" || s.status === "delayed" || s.status === "issue");
  const rest = ships.filter((s) => !hot.includes(s));
  const room = Math.max(0, MAX_ARCS - hot.length);
  const step = rest.length / room;
  const spread = Array.from({ length: room }, (_, i) => rest[Math.floor(i * step)]);
  return [...hot.slice(0, MAX_ARCS), ...spread].slice(0, MAX_ARCS);
}
const regionNames = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; }
})();
const countryName = (cc: string) => (cc && cc !== "??" ? regionNames?.of(cc) || cc : "Unknown");
const flag = (cc: string) =>
  /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "🏳️";
const fmt = (n: number) => n.toLocaleString("en-AU");
const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400_000));
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

// Hex heatmap colour: interpolate the palette's stops at t ∈ [0, 1].
function heatColor(stops: [number, number, number][], t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}

// The globe is decoration on top of real work: if WebGL or the data blows up,
// drop the card rather than blanking the whole home page.
class GlobeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("[OrderGlobe] crashed:", error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function OrderGlobeCard() {
  return (
    <GlobeBoundary>
      <OrderGlobe />
    </GlobeBoundary>
  );
}

function OrderGlobe() {
  const [data, setData] = useState<GlobeData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  useEffect(() => {
    let closed = false;
    const load = () =>
      fetch("/api/orders/globe")
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          const d = (await r.json()) as GlobeData;
          if (!closed) { setData(d); setLoadError(false); }
        })
        .catch(() => { if (!closed) setLoadError(true); });
    load();
    const timer = setInterval(load, 5 * 60_000);
    return () => { closed = true; clearInterval(timer); };
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/orders/globe/refresh", { method: "POST" });
      const r = await fetch("/api/orders/globe");
      if (r.ok) setData(await r.json());
    } finally {
      setRefreshing(false);
    }
  };

  const rebuild = async () => {
    setRebuilding(true);
    try {
      await fetch("/api/orders/globe/backfill", { method: "POST" });
      const r = await fetch("/api/orders/globe");
      if (r.ok) setData(await r.json());
    } finally {
      setRebuilding(false);
    }
  };

  const stats = useMemo(() => (data ? computeStats(data) : null), [data]);
  const building = data && !data.agg && data.backfill?.status !== "FAILED";

  return (
    <section className="order-globe" style={styles.card} aria-label="Orders view">
      <div className="order-globe-globe" style={styles.globeWrap}>
        <GlobeCanvas data={data} />
        <div style={styles.globeHead}>
          <div style={styles.bigNum}>{stats ? fmt(stats.total) : "—"}</div>
          <div style={styles.sub}>
            {stats?.since ? `orders since ${stats.since}` : building ? "Building order history…" : "orders all-time"}
          </div>
        </div>
        <Legend />
      </div>

      <div className="order-globe-side" style={styles.side}>
        <div style={styles.kpis}>
          <Kpi label="Countries" value={stats ? fmt(stats.countries) : "—"} />
          <Kpi label="International" value={stats ? `${stats.intlPct}%` : "—"} />
          <Kpi label="In transit" value={stats ? fmt(stats.inTransit) : "—"} accent={C.accent} />
          <Kpi label="To dispatch" value={data?.transit?.awaitingDispatch != null ? fmt(data.transit.awaitingDispatch) : "—"} />
        </div>
        <div style={styles.periods}>
          <span><b style={styles.periodNum}>{stats ? fmt(stats.today) : "—"}</b> today</span>
          <span><b style={styles.periodNum}>{stats ? fmt(stats.week) : "—"}</b> this week</span>
          <span><b style={styles.periodNum}>{stats ? fmt(stats.month) : "—"}</b> this month</span>
        </div>

        <div style={styles.blockTitle}>
          <span>Top destinations</span>
          <span style={styles.colHint}>orders · in transit</span>
        </div>
        <div style={styles.topList}>
          {(stats?.top || []).map((c) => (
            <div key={c.cc} style={styles.topRow}>
              <span style={styles.topName}>
                <span aria-hidden="true">{flag(c.cc)}</span> {countryName(c.cc)}
              </span>
              <span style={styles.topBarTrack}>
                <span style={{ ...styles.topBar, width: `${Math.max(2, c.pct)}%` }} />
              </span>
              <span style={styles.topNums}>
                {fmt(c.n)}
                <span style={{ color: C.accent }}> · {c.transit}</span>
              </span>
            </div>
          ))}
          {stats && stats.top.length === 0 && <div style={styles.empty}>No orders yet.</div>}
        </div>

        <div style={styles.blockTitle}>
          <span>Records</span>
          <span style={styles.colHint}>
            {data?.agg ? `updated ${timeAgo(data.agg.syncedAt)}` : ""}
            <button style={styles.refreshBtn} onClick={refresh} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </span>
        </div>
        <Records records={stats?.records || null} />
      </div>

      <MonthStrip byMonth={data?.agg?.byMonth || {}} current={data?.today.slice(0, 7) || ""} />

      {data && <Notice data={data} rebuilding={rebuilding} onRebuild={rebuild} />}
      {loadError && !data && (
        <div style={styles.notice} role="status">Couldn't load order data. Retrying in 5 minutes.</div>
      )}
    </section>
  );
}

function computeStats(d: GlobeData) {
  const agg = d.agg;
  const ships = d.transit?.shipments || [];
  const total = agg?.total || 0;
  const byCountry = agg?.byCountry || {};
  const transitBy: Record<string, number> = {};
  for (const s of ships) transitBy[s.cc] = (transitBy[s.cc] || 0) + 1;
  const top = Object.entries(byCountry)
    .filter(([cc]) => cc !== "??")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([cc, n]) => ({
      cc, n, pct: total ? (n / total) * 100 : 0,
      transit: transitBy[cc] || 0,
    }));
  // Scale bars against the leader so the top row reads as full.
  const lead = top[0]?.n || 1;
  for (const t of top) t.pct = (t.n / lead) * 100;

  let week = 0;
  const today = new Date(d.today + "T00:00:00Z");
  for (let i = 0; i < 7; i++) {
    const key = new Date(today.getTime() - i * 86400_000).toISOString().slice(0, 10);
    week += agg?.byDay[key] || 0;
  }
  const au = byCountry.AU || 0;
  const records = agg ? computeRecords(agg.byDay, agg.byMonth) : null;

  return {
    total,
    since: agg?.firstOrderAt
      ? new Date(agg.firstOrderAt).toLocaleDateString("en-AU", { month: "short", year: "numeric" })
      : null,
    countries: Object.keys(byCountry).filter((c) => c !== "??").length,
    intlPct: total ? Math.round(((total - au) / total) * 100) : 0,
    inTransit: ships.filter((s) => s.status !== "label").length,
    today: agg?.byDay[d.today] || 0,
    week,
    month: agg?.byMonth[d.today.slice(0, 7)] || 0,
    top,
    records,
  };
}

function timeAgo(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// ── Globe ───────────────────────────────────────────────────────────────────

function GlobeCanvas({ data }: { data: GlobeData | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeInstance | null>(null);
  const [ready, setReady] = useState(false);
  const theme = useThemeName();
  const [land, setLand] = useState<object[] | null>(null);

  // Create once; globe.gl + three are ~600kb so they load in their own chunk.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let ro: ResizeObserver | null = null;
    let io: IntersectionObserver | null = null;
    let tourTimer = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    import("globe.gl").then(({ default: Globe }) => {
      if (disposed) return;
      const g = new Globe(host, { animateIn: !reduced, rendererConfig: { antialias: true, alpha: true } })
        .backgroundColor("rgba(0,0,0,0)")
        .showAtmosphere(true)
        .width(host.clientWidth)
        .height(host.clientHeight)
        .pointOfView({ ...TOUR[0], altitude: DEFAULT_ALTITUDE });
      const controls = g.controls();
      controls.enableZoom = false; // plain wheel scrolls the page; zoom = buttons / pinch
      controls.autoRotate = false; // replaced by the scripted tour below

      // Tour: fly Australia → UK → US → Australia on a loop, holding at each
      // stop. Keeps whatever zoom the viewer has chosen. Pauses while the
      // pointer is on the globe, resumes shortly after it leaves.
      let stop = 0;
      const nextLeg = () => {
        stop = (stop + 1) % TOUR.length;
        g.pointOfView({ ...TOUR[stop], altitude: g.pointOfView().altitude }, TOUR_TRAVEL_MS);
        tourTimer = window.setTimeout(nextLeg, TOUR_TRAVEL_MS + TOUR_HOLD_MS);
      };
      const pauseTour = () => {
        window.clearTimeout(tourTimer);
        g.pointOfView(g.pointOfView(), 0); // cancel an in-flight leg
      };
      const resumeTour = (delay: number) => {
        window.clearTimeout(tourTimer);
        if (!reduced) tourTimer = window.setTimeout(nextLeg, delay);
      };
      resumeTour(TOUR_HOLD_MS);
      // Listen on the whole globe panel so the zoom buttons count as "on the globe".
      const panel = host.parentElement || host;
      panel.addEventListener("pointerenter", pauseTour);
      panel.addEventListener("pointerleave", () => resumeTour(2000));

      // Pinch (trackpads send it as ctrl+wheel) and Ctrl/⌘+scroll zoom.
      host.addEventListener("wheel", (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        zoomBy(g, Math.exp(e.deltaY * 0.01), 0);
      }, { passive: false });

      g.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
      ro = new ResizeObserver(() => g.width(host.clientWidth).height(host.clientHeight));
      ro.observe(host);
      // Stop rendering entirely while the card is scrolled out of view.
      io = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) g.resumeAnimation();
        else g.pauseAnimation();
      });
      io.observe(host);
      globeRef.current = g;
      setReady(true);
    });

    return () => {
      disposed = true;
      window.clearTimeout(tourTimer);
      ro?.disconnect();
      io?.disconnect();
      globeRef.current?._destructor();
      globeRef.current = null;
      host.innerHTML = "";
    };
  }, []);

  // Light mode's halftone land needs country outlines — fetch once, on demand.
  useEffect(() => {
    if (theme !== "light" || land) return;
    fetch("/globe/land.geojson")
      .then((r) => r.json())
      .then((geo: { features: object[] }) => setLand(geo.features))
      .catch(() => { /* plain sphere is an acceptable fallback */ });
  }, [theme, land]);

  // Feed layers whenever data or theme changes.
  useEffect(() => {
    const g = globeRef.current;
    if (!g || !ready) return;
    const pal = GLOBE_THEME[theme];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Surface: night photo (dark) or a pale sphere with halftone-dot land (light).
    // three-globe ignores a falsy image URL (keeps the old map) and nulls the
    // material colour once a texture loads, so the untextured sphere is set on
    // the material directly. "" (not null) still registers as a change, so
    // flipping back to dark reloads the texture.
    g.globeImageUrl(pal.texture || "")
      .bumpImageUrl(pal.bump || "")
      .atmosphereColor(pal.atmosphere)
      .atmosphereAltitude(pal.atmosphereAlt);
    if (!pal.texture) {
      type Col = { set: (c: string) => void };
      const mat = g.globeMaterial() as unknown as {
        map: unknown; color: Col | null; emissive: Col & { constructor: new (c: string) => Col }; needsUpdate: boolean;
      };
      mat.map = null;
      if (mat.color) mat.color.set(pal.sphere);
      else mat.color = new mat.emissive.constructor(pal.sphere);
      mat.needsUpdate = true;
    }
    g.hexPolygonsData(pal.land && land ? land : [])
      .hexPolygonResolution(3)
      .hexPolygonMargin(0.45)
      .hexPolygonAltitude(0.002)
      .hexPolygonColor(() => pal.land || "#000");

    if (!data) return;
    const { origin } = data;
    const points = data.agg?.points || [];
    const ships = pickArcs(data.transit?.shipments || []);

    // Flat hexagon heatmap of all-time order density: one H3 cell per hex,
    // coloured on a log scale so smaller markets still register next to the
    // US. Merged into a single mesh — much cheaper to draw than per-hex meshes
    // (the trade-off: no per-hex hover tooltip).
    const bins = new Map<string, number>();
    for (const p of points) {
      const k = `${Math.round(p.lat)},${Math.round(p.lng)}`;
      bins.set(k, (bins.get(k) || 0) + p.n);
    }
    const maxLog = Math.log1p(Math.max(1, ...bins.values()));
    g.hexBinPointsData(points)
      .hexBinPointLat("lat")
      .hexBinPointLng("lng")
      .hexBinPointWeight("n")
      .hexBinResolution(3)
      .hexMargin(0.18)
      .hexBinMerge(true)
      .hexTransitionDuration(0)
      .hexAltitude(0.004)
      .hexTopColor((d) => heatColor(pal.hex, Math.log1p(d.sumWeight) / maxLog))
      .hexSideColor((d) => heatColor(pal.hex, Math.log1p(d.sumWeight) / maxLog));

    // Arcs: Canberra → each live shipment. Dark orange leaving the depot,
    // warming through light orange and yellow to green as it lands.
    g.arcsData(ships)
      .arcStartLat(() => origin.lat)
      .arcStartLng(() => origin.lng)
      .arcEndLat("lat")
      .arcEndLng("lng")
      .arcColor(() => pal.arc)
      .arcAltitudeAutoScale(0.42)
      .arcCurveResolution(40)
      .arcCircularResolution(3)
      .arcStroke((s: object) => ((s as Shipment).status === "delayed" ? 0.45 : 0.3))
      .arcDashLength(0.35)
      .arcDashGap(0.9)
      .arcDashInitialGap(() => Math.random())
      .arcDashAnimateTime(reduced ? 0 : (s: object) => 5200 + ((s as Shipment).o.charCodeAt(1) % 7) * 500)
      .arcLabel((o: object) => {
        const s = o as Shipment;
        const st = STATUS[s.status];
        return `<div class="globe-tip"><b>${esc(s.o)}</b> → ${esc(s.city || countryName(s.cc))} ${flag(s.cc)}<br/>
          <span style="color:var(--og-accent)">${st.label}${s.approx ? " (est.)" : ""}</span> · day ${daysSince(s.shippedAt)}
          ${s.carrier ? `<br/><span>${esc(s.carrier)}</span>` : ""}</div>`;
      });

    // Rings: depot heartbeat + a ripple on every order from the last 24h.
    const rings = [
      { lat: origin.lat, lng: origin.lng, depot: true },
      ...(data.agg?.recent || []).slice(-MAX_RINGS).map((r) => ({ lat: r.lat, lng: r.lng, depot: false })),
    ];
    const rgba = (c: [number, number, number], a: number) => `rgba(${c.join(",")},${a})`;
    g.ringsData(reduced ? [] : rings)
      .ringColor((r: object) => ((r as { depot: boolean }).depot
        ? (k: number) => rgba(pal.depotRing, 1 - k)
        : (k: number) => rgba(pal.recentRing, 0.9 * (1 - k))))
      .ringMaxRadius((r: object) => ((r as { depot: boolean }).depot ? 6 : 2.5))
      .ringPropagationSpeed(2.2)
      .ringRepeatPeriod((r: object) => ((r as { depot: boolean }).depot ? 1400 : 2200));

    // City tags: Canberra (the depot) + the busiest order cities, as bold
    // abbreviations (NYC, LA…). HTML overlays, so they stay crisp; faded out
    // when they rotate to the far side of the globe.
    g.htmlElementsData(cityTags(points, origin))
      .htmlLat("lat")
      .htmlLng("lng")
      .htmlAltitude(0.01)
      .htmlTransitionDuration(0)
      .htmlElement((d: object) => {
        const t = d as CityTag;
        const wrap = document.createElement("div");
        wrap.style.pointerEvents = "none";
        const tag = document.createElement("div");
        tag.className = t.kind === "notable" ? "og-city og-city-notable" : "og-city";
        tag.textContent = t.tag;
        if (t.name) tag.title = t.name;
        wrap.appendChild(tag);
        return wrap;
      })
      .htmlElementVisibilityModifier((el, visible) => {
        el.style.opacity = visible ? "1" : "0";
      });
  }, [data, ready, theme, land]);

  // globe.gl wipes its container (innerHTML = ""), so the host div must hold no
  // React children — the loading text is a sibling, not a child.
  return (
    <>
      <div ref={hostRef} style={styles.globeHost} />
      {!ready && <div style={styles.globeLoading}>Loading globe…</div>}
      {ready && (
        <div style={styles.zoomBar}>
          <button style={styles.zoomBtn} aria-label="Zoom in" title="Zoom in"
            onClick={() => globeRef.current && zoomBy(globeRef.current, 0.7)}>+</button>
          <button style={styles.zoomBtn} aria-label="Zoom out" title="Zoom out"
            onClick={() => globeRef.current && zoomBy(globeRef.current, 1 / 0.7)}>−</button>
          <button style={{ ...styles.zoomBtn, fontSize: "0.8rem" }} aria-label="Reset zoom" title="Reset zoom"
            onClick={() => {
              const g = globeRef.current;
              if (g) g.pointOfView({ ...g.pointOfView(), altitude: DEFAULT_ALTITUDE }, 600);
            }}>⟲</button>
        </div>
      )}
    </>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Kpi({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={styles.kpi}>
      <div style={{ ...styles.kpiValue, ...(accent ? { color: accent } : {}) }}>{value}</div>
      <div style={styles.kpiLabel}>{label}</div>
    </div>
  );
}

function Legend() {
  return (
    <div style={styles.legend}>
      <span style={styles.legendItem}>
        <span style={{ ...styles.swatch, background: "var(--og-ramp)" }} />
        All-time orders
      </span>
      <span style={styles.legendItem}>
        <span style={{ ...styles.swatch, background: "var(--og-arc)" }} />
        In transit
      </span>
      <span style={styles.legendItem}>
        <span style={{ ...styles.swatch, width: 8, borderRadius: "50%", background: "var(--og-ripple)" }} />
        Last 24h
      </span>
    </div>
  );
}

function Notice({ data, rebuilding, onRebuild }: { data: GlobeData; rebuilding: boolean; onRebuild: () => void }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  let text: string | null = null;
  let action = false;
  let busy = false;
  if (data.backfill?.status === "FAILED") {
    text = `Order history export failed${data.backfill.error ? ` (${data.backfill.error})` : ""}.`;
    action = true;
  } else if (!data.agg) {
    busy = true;
    text = data.backfill
      ? "Exporting order history from Shopify. The globe fills in within about 10 minutes."
      : "Order history export starts on the next sync, within 10 minutes.";
  } else if (data.allOrdersScope === false) {
    text = "Showing the last 60 days only. Add the read_all_orders scope to the Shopify app, then rebuild.";
    action = true;
  } else if (data.syncError) {
    text = `Last update failed: ${data.syncError.errors.join(" · ")}`;
  }
  if (!text || dismissed === text) return null;
  return (
    <div style={styles.notice} role="status">
      <div style={styles.noticeBody}>
        {busy && <span className="og-spinner" aria-hidden="true" />}
        <span>{text}</span>
        <button style={styles.noticeClose} onClick={() => setDismissed(text)} aria-label="Dismiss">×</button>
      </div>
      {action && (
        <button style={styles.noticeBtn} onClick={onRebuild} disabled={rebuilding}>
          {rebuilding ? "Starting…" : "Rebuild history"}
        </button>
      )}
    </div>
  );
}

interface RecordStat { n: number; label: string }
interface OrderRecords { day: RecordStat | null; week: RecordStat | null; month: RecordStat | null }

/** All-time best day, week (Mon–Sun, AEST) and month by order count. */
function computeRecords(byDay: Record<string, number>, byMonth: Record<string, number>): OrderRecords {
  const utc = (ymd: string) => new Date(ymd + "T00:00:00Z");
  const fmtDate = (d: Date, opts: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString("en-AU", { ...opts, timeZone: "UTC" });
  const best = (m: Record<string, number>) =>
    Object.entries(m).reduce<[string, number] | null>((top, e) => (!top || e[1] > top[1] ? e : top), null);

  const weeks: Record<string, number> = {};
  for (const [day, n] of Object.entries(byDay)) {
    const d = utc(day);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400_000);
    const key = monday.toISOString().slice(0, 10);
    weeks[key] = (weeks[key] || 0) + n;
  }
  const bd = best(byDay);
  const bw = best(weeks);
  const bm = best(byMonth);
  return {
    day: bd && { n: bd[1], label: fmtDate(utc(bd[0]), { weekday: "short", day: "numeric", month: "short", year: "numeric" }) },
    week: bw && { n: bw[1], label: `w/c ${fmtDate(utc(bw[0]), { day: "numeric", month: "short", year: "numeric" })}` },
    month: bm && { n: bm[1], label: fmtDate(utc(bm[0] + "-01"), { month: "long", year: "numeric" }) },
  };
}

function Records({ records }: { records: OrderRecords | null }) {
  const rows: [string, RecordStat | null | undefined][] = [
    ["Biggest day", records?.day],
    ["Biggest week", records?.week],
    ["Biggest month", records?.month],
  ];
  return (
    <div style={styles.records}>
      {rows.map(([label, r]) => (
        <div key={label} style={styles.record}>
          <div style={styles.kpiLabel}>{label}</div>
          <div style={styles.recordValue}>{r ? fmt(r.n) : "—"}</div>
          <div style={styles.recordDate}>{r?.label || ""}</div>
        </div>
      ))}
    </div>
  );
}

function MonthStrip({ byMonth, current }: { byMonth: Record<string, number>; current: string }) {
  const months = Object.keys(byMonth).sort();
  if (months.length < 2) return null;
  // Fill gaps so quiet months show as empty slots, not missing ones.
  const all: string[] = [];
  let [y, m] = months[0].split("-").map(Number);
  const [ey, em] = months[months.length - 1].split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    all.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  const shown = all.slice(-72);
  const max = Math.max(...shown.map((k) => byMonth[k] || 0), 1);
  const label = (k: string) =>
    new Date(k + "-01T00:00:00Z").toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
  return (
    <div style={styles.strip}>
      <div style={styles.stripBars}>
        {shown.map((k) => {
          const n = byMonth[k] || 0;
          return (
            <div
              key={k}
              title={`${label(k)}: ${fmt(n)} orders`}
              style={{
                ...styles.stripBar,
                height: `${Math.max(2, (n / max) * 100)}%`,
                background: C.accent,
                opacity: k === current ? 1 : 0.35 + 0.5 * (n / max),
              }}
            />
          );
        })}
      </div>
      <div style={styles.stripAxis}>
        <span>{label(shown[0])}</span>
        <span>Orders per month</span>
        <span>{label(shown[shown.length - 1])}</span>
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const mono = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

const styles: Record<string, CSSProperties> = {
  card: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.35fr) minmax(0, 1fr)",
    gridTemplateAreas: '"globe side" "strip strip"',
    borderRadius: "8px",
    overflow: "hidden",
    marginBottom: "1.25rem",
    color: C.text,
    background: "var(--og-bg)",
    border: "1px solid var(--og-border)",
    boxShadow: "0 2px 8px var(--shadow)",
  },
  globeWrap: { gridArea: "globe", position: "relative", minHeight: "460px" },
  globeHost: { position: "absolute", inset: 0, cursor: "grab" },
  zoomBar: {
    position: "absolute", top: "1rem", right: "1rem", zIndex: 1,
    display: "flex", flexDirection: "column", gap: "4px",
  },
  zoomBtn: {
    width: 28, height: 28, borderRadius: 6, border: `1px solid ${C.line}`,
    background: "var(--og-overlay)", color: C.text, fontSize: "1rem", lineHeight: 1,
    cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 1px 3px var(--shadow)",
  },
  globeLoading: {
    position: "absolute", inset: 0, pointerEvents: "none", display: "flex", alignItems: "center", justifyContent: "center",
    color: C.faint, fontSize: "0.8rem",
  },
  globeHead: { position: "absolute", top: "1.1rem", left: "1.3rem", pointerEvents: "none" },
  bigNum: {
    fontSize: "2.6rem", fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.05, marginTop: "0.2rem",
    fontVariantNumeric: "tabular-nums",
  },
  sub: { fontSize: "0.78rem", color: C.muted },
  legend: {
    position: "absolute", left: "1.3rem", bottom: "0.9rem", display: "flex", flexWrap: "wrap", gap: "0.9rem",
    fontSize: "0.7rem", color: C.muted, pointerEvents: "none",
  },
  legendItem: { display: "inline-flex", alignItems: "center", gap: "0.4rem" },
  swatch: { display: "inline-block", width: 22, height: 8, borderRadius: 4 },
  // Small toast pinned to the card's bottom-right corner.
  notice: {
    position: "absolute", right: "1rem", bottom: "1rem", zIndex: 2, width: "min(290px, calc(100% - 2rem))",
    background: "var(--og-overlay)", border: `1px solid ${C.line}`, borderRadius: 8,
    boxShadow: "0 6px 20px var(--shadow-strong)", padding: "0.6rem 0.7rem",
    fontSize: "0.74rem", lineHeight: 1.4, color: C.text,
    display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "0.5rem",
    animation: "ogToastIn 0.25s ease-out",
  },
  noticeBody: { display: "flex", alignItems: "flex-start", gap: "0.5rem", width: "100%" },
  noticeClose: {
    marginLeft: "auto", flexShrink: 0, background: "none", border: "none", color: C.muted,
    fontSize: "1rem", lineHeight: 1, cursor: "pointer", padding: 0, fontFamily: "inherit",
  },
  refreshBtn: {
    marginLeft: "0.5rem", background: "none", border: `1px solid ${C.line}`, borderRadius: 4,
    color: C.accent, fontFamily: "inherit", fontSize: "0.64rem", padding: "0.1rem 0.4rem", cursor: "pointer",
  },
  noticeBtn: {
    flexShrink: 0, background: C.accent, color: "#fff", border: "none", borderRadius: 4,
    padding: "0.35rem 0.7rem", fontSize: "0.74rem", fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  side: {
    gridArea: "side", display: "flex", flexDirection: "column", gap: "0.75rem",
    padding: "1.1rem 1.3rem 1rem", background: "var(--og-panel)", borderLeft: `1px solid ${C.line}`,
    minWidth: 0, backdropFilter: "blur(6px)",
  },
  kpis: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "0.5rem" },
  kpi: { minWidth: 0 },
  kpiValue: { fontSize: "1.35rem", fontWeight: 700, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" },
  kpiLabel: { fontSize: "0.66rem", color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" },
  periods: {
    display: "flex", gap: "1rem", fontSize: "0.76rem", color: C.muted, paddingBottom: "0.7rem",
    borderBottom: `1px solid ${C.line}`,
  },
  periodNum: { color: C.text, fontVariantNumeric: "tabular-nums" },
  blockTitle: {
    display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem",
    fontFamily: mono, fontSize: "0.66rem", letterSpacing: "0.12em", textTransform: "uppercase", color: C.muted,
  },
  colHint: { letterSpacing: "0.02em", textTransform: "none", color: C.faint },
  topList: { display: "flex", flexDirection: "column", gap: "0.35rem" },
  topRow: {
    display: "grid", gridTemplateColumns: "minmax(0, 8.5rem) minmax(0, 1fr) auto", alignItems: "center",
    gap: "0.6rem", fontSize: "0.78rem",
  },
  topName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  topBarTrack: { height: 6, background: "var(--og-track)", borderRadius: 3, overflow: "hidden" },
  topBar: {
    display: "block", height: "100%", borderRadius: 3,
    background: "var(--og-bar)",
  },
  topNums: { fontFamily: mono, fontSize: "0.72rem", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  records: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.5rem" },
  record: {
    minWidth: 0, padding: "0.55rem 0.65rem", borderRadius: 6,
    background: "var(--og-board)", border: `1px solid ${C.line}`,
  },
  recordValue: {
    fontSize: "1.3rem", fontWeight: 700, color: C.accent, fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em", marginTop: "0.15rem",
  },
  recordDate: { fontSize: "0.68rem", color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  empty: { fontSize: "0.76rem", color: C.faint, padding: "0.3rem 0" },
  strip: { gridArea: "strip", padding: "0.7rem 1.3rem 0.8rem", borderTop: `1px solid ${C.line}` },
  stripBars: { display: "flex", alignItems: "flex-end", gap: "2px", height: "38px" },
  stripBar: { flex: 1, minWidth: 0, borderRadius: "1px 1px 0 0" },
  stripAxis: {
    display: "flex", justifyContent: "space-between", marginTop: "0.35rem",
    fontFamily: mono, fontSize: "0.62rem", color: C.faint, letterSpacing: "0.04em",
  },
};
