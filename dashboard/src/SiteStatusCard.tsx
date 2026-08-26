import { useEffect, useState, type CSSProperties } from "react";

// Website hero card — the home page's centerpiece, full width above the two
// columns. Three groups: live status (pulsing dot), a real 24h response-time
// sparkline (pings recorded every 10 min by the worker), and the store's Shop
// review stats. All data from /api/site-status; every graphic is live data,
// nothing decorative.

interface HistoryPoint {
  t: number;
  ms: number | null;
  ok: boolean;
}

interface SiteStatus {
  live: boolean;
  status: number;
  responseMs: number | null;
  checkedAt: string;
  reviews: { count: number; avgRating: number | null; updatedAt: string } | null;
  history?: HistoryPoint[];
}

export function SiteStatusCard() {
  const [data, setData] = useState<SiteStatus | null>(null);

  useEffect(() => {
    let closed = false;
    const load = () => {
      fetch("/api/site-status")
        .then(async (r) => {
          if (r.ok && !closed) setData(await r.json());
        })
        .catch(() => { /* keep last snapshot */ });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);

  const loading = data === null;
  const live = data?.live ?? false;
  const avg = data?.reviews?.avgRating == null ? null : Math.round(data.reviews.avgRating * 10) / 10;
  const starFill = Math.min(((data?.reviews?.avgRating ?? 0) / 5) * 100, 100);

  return (
    <div style={styles.card}>
      {/* Status */}
      <div style={styles.group}>
        <div style={styles.statusRow}>
          <span
            className={live ? "status-dot-live" : undefined}
            style={{ ...styles.dot, background: loading ? "var(--border-strong)" : live ? "#2e7d32" : "#d32f2f" }}
          />
          <span style={{ ...styles.statusText, color: loading ? "var(--text-muted)" : live ? "#2e7d32" : "#d32f2f" }}>
            {loading ? "…" : live ? "Live" : "Down"}
          </span>
        </div>
        <div style={styles.groupLabel}>
          bootink.com{data?.responseMs != null ? ` · ${data.responseMs} ms` : ""}
        </div>
      </div>

      {/* Response-time sparkline */}
      <div style={styles.sparkGroup}>
        <Sparkline history={data?.history || []} live={live} />
        <div style={styles.groupLabel}>Response time · last 24h</div>
      </div>

      {/* Shop reviews */}
      <div style={styles.group}>
        <div style={styles.reviewRow}>
          <div style={styles.stars} role="img" aria-label={`Rated ${avg ?? "?"} out of 5 stars`}>
            <span style={styles.starsBase} aria-hidden="true">★★★★★</span>
            <span style={{ ...styles.starsFill, width: `${starFill}%` }} aria-hidden="true">★★★★★</span>
          </div>
          <span style={styles.avg}>{avg ?? "—"}</span>
        </div>
        <div style={styles.groupLabel}>
          {data?.reviews ? `${data.reviews.count.toLocaleString()} reviews on Shop` : "Shop reviews"}
        </div>
      </div>
    </div>
  );
}

// SVG polyline over the ping history. Scale is 0 → a padded max so the line
// sits low and calm when the site is fast, and visibly climbs when it isn't.
// Unreachable pings become gaps; the last point gets a marker dot.
function Sparkline({ history, live }: { history: HistoryPoint[]; live: boolean }) {
  const points = history.filter((h) => h.ms != null) as Array<HistoryPoint & { ms: number }>;
  if (points.length < 2) {
    return <div style={styles.sparkEmpty}>Collecting history…</div>;
  }
  const W = 600;
  const H = 56;
  const PAD = 4;
  const max = Math.max(...points.map((p) => p.ms), 500) * 1.2;
  const coords = points.map((p, i) => {
    const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = H - PAD - (p.ms / max) * (H - PAD * 2);
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${PAD},${H - PAD} ${line} ${(W - PAD).toFixed(1)},${H - PAD}`;
  const [lastX, lastY] = coords[coords.length - 1];
  const color = live ? "#2e7d32" : "#d32f2f";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={styles.sparkSvg}>
      <polygon points={area} fill={color} opacity={0.08} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r={3} fill={color} />
    </svg>
  );
}

// Hero variant of the shared card family: same surface/border/shadow, wider
// padding, three groups on one axis with the sparkline flexing in the middle.
const styles: Record<string, CSSProperties> = {
  card: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 2px 8px var(--shadow)",
    padding: "1.1rem 1.5rem",
    marginBottom: "1.75rem",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "2rem",
  },
  group: { textAlign: "center", whiteSpace: "nowrap" },
  groupLabel: { fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.3rem" },
  statusRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.5rem",
  },
  dot: { width: "12px", height: "12px", borderRadius: "50%", flexShrink: 0 },
  statusText: { fontSize: "1.4rem", fontWeight: 700 },
  sparkGroup: { minWidth: 0, textAlign: "center" },
  sparkSvg: { display: "block", width: "100%", height: "56px" },
  sparkEmpty: {
    height: "56px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.8rem",
    color: "var(--text-faint)",
  },
  reviewRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.6rem",
  },
  stars: {
    position: "relative",
    display: "inline-block",
    fontSize: "1.5rem",
    lineHeight: 1,
  },
  starsBase: { color: "var(--border-strong)" },
  starsFill: {
    position: "absolute",
    top: 0,
    left: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    color: "#ffc60d",
  },
  avg: { fontSize: "1.4rem", fontWeight: 700, color: "var(--text)" },
};
