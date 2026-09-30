// Major cities with the short tags shown on the order globe (NYC, LA, SYD…).
// The globe's order data is anonymous grid cells, so the busiest cells are
// matched to the nearest city here. [tag, lat, lng]
export const GLOBE_CITIES: [string, number, number][] = [
  // United States
  ["NYC", 40.71, -74.01], ["LA", 34.05, -118.24], ["CHI", 41.88, -87.63], ["HOU", 29.76, -95.37],
  ["PHX", 33.45, -112.07], ["PHL", 39.95, -75.17], ["SAT", 29.42, -98.49], ["SD", 32.72, -117.16],
  ["DAL", 32.78, -96.8], ["ATX", 30.27, -97.74], ["SF", 37.77, -122.42], ["SEA", 47.61, -122.33],
  ["DEN", 39.74, -104.99], ["BOS", 42.36, -71.06], ["ATL", 33.75, -84.39], ["MIA", 25.76, -80.19],
  ["DC", 38.91, -77.04], ["DET", 42.33, -83.05], ["MSP", 44.98, -93.27], ["PDX", 45.52, -122.68],
  ["LV", 36.17, -115.14], ["NASH", 36.16, -86.78], ["SLC", 40.76, -111.89], ["ORL", 28.54, -81.38],
  ["TPA", 27.95, -82.46], ["CLT", 35.23, -80.84], ["STL", 38.63, -90.2], ["KC", 39.1, -94.58],
  ["IND", 39.77, -86.16], ["CLE", 41.5, -81.69], ["PIT", 40.44, -80.0], ["SAC", 38.58, -121.49],
  ["RAL", 35.78, -78.64], ["CIN", 39.1, -84.51], ["OKC", 35.47, -97.52], ["CMH", 39.96, -83.0],
  ["JAX", 30.33, -81.66], ["MKE", 43.04, -87.91], ["ABQ", 35.08, -106.65], ["TUS", 32.22, -110.97],
  ["NOLA", 29.95, -90.07], ["BHM", 33.52, -86.8], ["BUF", 42.89, -78.88], ["SJ", 37.34, -121.89],
  ["HNL", 21.31, -157.86], ["ANC", 61.22, -149.9], ["BOI", 43.62, -116.2], ["OMA", 41.26, -95.93],
  ["MEM", 35.15, -90.05], ["LOU", 38.25, -85.76], ["RIC", 37.54, -77.44], ["NJ", 40.74, -74.17],
  // Australia / NZ
  ["CBR", -35.28, 149.13], ["SYD", -33.87, 151.21], ["MEL", -37.81, 144.96], ["BNE", -27.47, 153.03],
  ["PER", -31.95, 115.86], ["ADL", -34.93, 138.6], ["GC", -28.02, 153.4], ["HBA", -42.88, 147.33],
  ["DRW", -12.46, 130.84], ["NCL", -32.93, 151.78], ["CNS", -16.92, 145.77], ["TSV", -19.26, 146.82],
  ["WOL", -34.42, 150.89], ["GEE", -38.15, 144.36], ["SC", -26.65, 153.07], ["AKL", -36.85, 174.76],
  ["WLG", -41.29, 174.78], ["CHC", -43.53, 172.64],
  // UK / Ireland
  ["LDN", 51.51, -0.13], ["MAN", 53.48, -2.24], ["BHX", 52.49, -1.89], ["GLA", 55.86, -4.25],
  ["EDI", 55.95, -3.19], ["LDS", 53.8, -1.55], ["LPL", 53.41, -2.99], ["BRS", 51.45, -2.59],
  ["NCS", 54.98, -1.61], ["BFS", 54.6, -5.93], ["CDF", 51.48, -3.18], ["DUB", 53.35, -6.26],
  // Canada
  ["TOR", 43.65, -79.38], ["VAN", 49.28, -123.12], ["MTL", 45.5, -73.57], ["CGY", 51.05, -114.07],
  ["EDM", 53.55, -113.49], ["OTT", 45.42, -75.7], ["WPG", 49.9, -97.14],
  // Europe
  ["BER", 52.52, 13.4], ["PAR", 48.86, 2.35], ["AMS", 52.37, 4.9], ["ZRH", 47.38, 8.54],
  ["GVA", 46.2, 6.14], ["MUC", 48.14, 11.58], ["HAM", 53.55, 9.99], ["FRA", 50.11, 8.68],
  ["VIE", 48.21, 16.37], ["MAD", 40.42, -3.7], ["BCN", 41.39, 2.17], ["CPH", 55.68, 12.57],
  ["STO", 59.33, 18.07], ["OSL", 59.91, 10.75], ["MIL", 45.46, 9.19], ["ROM", 41.9, 12.5],
  ["BRU", 50.85, 4.35], ["LIS", 38.72, -9.14], ["HEL", 60.17, 24.94], ["WAW", 52.23, 21.01],
  // Asia / other
  ["SIN", 1.35, 103.82], ["HK", 22.32, 114.17], ["TYO", 35.68, 139.69], ["SEL", 37.57, 126.98],
  ["DXB", 25.2, 55.27], ["JNB", -26.2, 28.05], ["CPT", -33.92, 18.42],
];

// City tags never shown even when they rank in the top cities: in Australia
// only Sydney and Melbourne are tagged (plus the CBR depot), and DC is left
// off the crowded US east coast.
export const HIDDEN_CITY_TAGS = new Set([
  "BNE", "PER", "ADL", "GC", "HBA", "DRW", "NCL", "CNS", "TSV", "WOL", "GEE", "SC", "DC",
]);

/** Nearest city tag within `maxKm`, or null. Equirectangular distance — plenty
 *  accurate at city scale. */
export function nearestCity(lat: number, lng: number, maxKm = 70): { tag: string; lat: number; lng: number } | null {
  let best: [string, number, number] | null = null;
  let bestD = Infinity;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  for (const c of GLOBE_CITIES) {
    const dx = (c[2] - lng) * cosLat * 111.32;
    const dy = (c[1] - lat) * 110.57;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best && Math.sqrt(bestD) <= maxKm ? { tag: best[0], lat: best[1], lng: best[2] } : null;
}

// Notable far-flung places we've shipped to — tagged on the globe when at
// least one order landed within `km` of them (small places get a tight radius
// so a neighbouring country's orders don't count; places that are their own
// country also require the order's country code to match, since points are
// snapped to a ~55km grid). [tag, full name, lat, lng, km, country?]
export const NOTABLE_PLACES: [string, string, number, number, number, string?][] = [
  ["HNL", "Honolulu, Hawaii", 21.31, -157.86, 60],
  ["ANC", "Anchorage, Alaska", 61.22, -149.9, 60],
  ["BDA", "Bermuda", 32.3, -64.78, 40, "BM"],
  ["FAE", "Faroe Islands", 62.01, -6.77, 60, "FO"],
  ["REK", "Reykjavík, Iceland", 64.15, -21.94, 60, "IS"],
  ["BOO", "Bodø, Norway — Arctic Circle", 67.28, 14.4, 60],
  ["IVC", "Invercargill, NZ — southernmost", -46.41, 168.35, 60],
  ["LPA", "Gran Canaria — furthest from Canberra", 27.96, -15.59, 60],
  ["DXB", "Dubai", 25.2, 55.27, 40, "AE"],
  ["SIN", "Singapore", 1.35, 103.82, 40, "SG"],
  ["TYO", "Tokyo", 35.68, 139.69, 60],
  ["SEL", "Seoul", 37.57, 126.98, 60],
  ["SJU", "San Juan, Puerto Rico", 18.47, -66.11, 60],
  ["MCM", "Monaco", 43.74, 7.42, 12, "MC"],
  ["GIB", "Gibraltar", 36.14, -5.35, 12, "GI"],
  ["TAS", "Tashkent, Uzbekistan", 41.3, 69.24, 60, "UZ"],
  ["WDH", "Windhoek, Namibia", -22.56, 17.08, 60, "NA"],
  ["CJC", "Atacama Desert, Chile", -22.46, -68.93, 80],
  ["CPT", "Cape Town", -33.92, 18.42, 60],
  ["MEX", "Mexico City", 19.43, -99.13, 60],
  ["HKD", "Hokkaido, Japan", 42.92, 143.2, 80],
];

/** True when any order point (optionally in country `cc`) lies within `km`
 *  of (lat, lng). */
export function hasOrderNear(
  points: { lat: number; lng: number; cc?: string }[], lat: number, lng: number, km: number, cc?: string,
): boolean {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Points are snapped to a 0.5° grid, so allow half a cell of slack.
  const r = km + 35;
  return points.some((p) => {
    if (cc && p.cc !== cc) return false;
    const dx = (p.lng - lng) * cosLat * 111.32;
    const dy = (p.lat - lat) * 110.57;
    return dx * dx + dy * dy <= r * r;
  });
}
