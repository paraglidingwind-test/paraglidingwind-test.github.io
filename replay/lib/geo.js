// Mirrors ro.parapanta.skyreplay.analysis.Geo (Kotlin). Spherical earth, flight-scale distances.

export const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;

export function distance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
  const a = s1 * s1 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * s2 * s2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

/** Initial bearing 0..360 (0 = north, 90 = east). */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normDeg(Math.atan2(y, x) / D2R);
}

export function normDeg(d) { const r = d % 360; return r < 0 ? r + 360 : r; }

/** Signed smallest difference b - a in (-180, 180]. */
export function angleDiff(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Compass direction (0 = north) of an east/north vector. */
export function vectorDir(east, north) { return normDeg(Math.atan2(east, north) / D2R); }

/** Local equirectangular projection around a reference point, metres (x east, y north). */
export class Enu {
  constructor(lat0, lon0) {
    this.lat0 = lat0; this.lon0 = lon0;
    this.kx = EARTH_R * D2R * Math.cos(lat0 * D2R);
    this.ky = EARTH_R * D2R;
  }
  x(lon) { return (lon - this.lon0) * this.kx; }
  y(lat) { return (lat - this.lat0) * this.ky; }
  lon(x) { return this.lon0 + x / this.kx; }
  lat(y) { return this.lat0 + y / this.ky; }
}
