// Cleaning, trimming, derived series and time interpolation.
// Mirrors ro.parapanta.skyreplay.analysis.FlightProcessing + FlightTrack (Kotlin).
import { distance, bearing, normDeg, angleDiff } from './geo.js?v=a6ebe58';

export const SPIKE_SPEED_MS = 150 / 3.6;

/** Drops points without a usable fix, sorts by time, one point per timestamp, removes GPS spikes. */
export function clean(points) {
  const ok = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.alt) &&
    p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180 && !(p.lat === 0 && p.lon === 0))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of ok) if (!out.length || out[out.length - 1].t !== p.t) out.push(p);
  return dropSpikes(out);
}

export function dropSpikes(points) {
  const n = points.length;
  if (n < 3) return points;
  const fast = (a, b) => distance(a.lat, a.lon, b.lat, b.lon) > SPIKE_SPEED_MS * Math.max(Math.abs(b.t - a.t) / 1000, 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    let spike;
    if (i === 0) spike = fast(p, points[1]) && !fast(points[1], points[2]) && fast(p, points[2]);
    else if (i === n - 1) spike = out.length >= 2 && fast(out[out.length - 1], p) && !fast(out[out.length - 2], out[out.length - 1]);
    else {
      const prev = out.length ? out[out.length - 1] : points[i - 1];
      const next = points[i + 1];
      spike = fast(prev, p) && fast(p, next) && !fast(prev, next);
    }
    if (!spike) out.push(p);
  }
  return out;
}

/** clean + trim pre-takeoff / post-landing. */
export function prepare(flight) {
  const c = clean(flight.points);
  return { ...flight, points: trim(c) };
}

export function trim(points) {
  const r = flightRange(points);
  if (!r) return points;
  return points.slice(r[0], r[1] + 1);
}

/** [first, last] index from takeoff to landing, or null (see Kotlin flightRange). */
export function flightRange(points, flySpeed = 4.0, flyVario = 1.5, minRunS = 20.0) {
  const n = points.length;
  if (n < 3) return null;
  const t = times(points);
  const gs = windowMean(t, groundSpeeds(points), 5.0);
  const vz = verticalSpeeds(points);
  let first = -1, last = -1, i = 0;
  const flying = (k) => gs[k] > flySpeed || Math.abs(vz[k]) > flyVario;
  while (i < n) {
    if (!flying(i)) { i++; continue; }
    let j = i;
    while (j + 1 < n && flying(j + 1)) j++;
    if ((t[j] - t[i]) / 1000 >= minRunS) { if (first < 0) first = i; last = j; }
    i = j + 1;
  }
  return first < 0 ? null : [first, last];
}

export function times(points) {
  const t = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) t[i] = points[i].t;
  return t;
}

export function groundSpeeds(points) {
  const n = points.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    const dt = (b.t - a.t) / 1000;
    out[i] = dt > 0 && dt < 30 ? distance(a.lat, a.lon, b.lat, b.lon) / dt : (points[i].speed ?? 0);
  }
  return out;
}

/** Track heading (deg); NaN where slower than minSpeed. */
export function headings(points, minSpeed = 1.5) {
  const n = points.length;
  const gs = groundSpeeds(points);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    out[i] = gs[i] < minSpeed || (a.lat === b.lat && a.lon === b.lon) ? NaN : bearing(a.lat, a.lon, b.lat, b.lon);
  }
  return out;
}

export function hasBaro(points) {
  if (!points.length) return false;
  let c = 0;
  for (const p of points) if (p.altBaro != null && Number.isFinite(p.altBaro)) c++;
  return c >= points.length * 0.9;
}

/** Altitude series for climb rates: barometric if present (gaps filled), else GPS. */
export function climbAltitudes(points) {
  const n = points.length;
  const out = new Float64Array(n);
  if (!hasBaro(points)) { for (let i = 0; i < n; i++) out[i] = points[i].alt; return out; }
  let last = points.find((p) => p.altBaro != null)?.altBaro ?? 0;
  for (let i = 0; i < n; i++) {
    const b = points[i].altBaro;
    if (b != null && Number.isFinite(b)) { last = b; out[i] = b; } else out[i] = last;
  }
  return out;
}

/** Smoothed vario (m/s): LSQ slope of baro (else GPS) altitude over a centred window. */
export function verticalSpeeds(points, windowS = 6.0) {
  return windowSlope(times(points), climbAltitudes(points), windowS / 2);
}

export function windowMean(t, v, halfS) {
  const n = t.length;
  const out = new Float64Array(n);
  const half = Math.trunc(halfS * 1000);
  let lo = 0, hi = -1, sum = 0;
  for (let i = 0; i < n; i++) {
    while (hi + 1 < n && t[hi + 1] <= t[i] + half) { hi++; sum += v[hi]; }
    while (t[lo] < t[i] - half) { sum -= v[lo]; lo++; }
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

export function windowSlope(t, v, halfS) {
  const n = t.length;
  const out = new Float64Array(n);
  const half = Math.trunc(halfS * 1000);
  let lo = 0, hi = -1;
  for (let i = 0; i < n; i++) {
    while (hi + 1 < n && t[hi + 1] <= t[i] + half) hi++;
    while (t[lo] < t[i] - half) lo++;
    let a = lo, b = hi;
    if (b - a < 1) { a = Math.max(0, i - 1); b = Math.min(n - 1, i + 1); }
    if (b <= a) { out[i] = 0; continue; }
    const t0 = t[i];
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    const m = b - a + 1;
    for (let k = a; k <= b; k++) {
      const x = (t[k] - t0) / 1000;
      sx += x; sy += v[k]; sxx += x * x; sxy += x * v[k];
    }
    const den = m * sxx - sx * sx;
    out[i] = den > 1e-9 ? (m * sxy - sx * sy) / den : 0;
  }
  return out;
}

/** Replay helper (mirrors Kotlin FlightTrack): interpolation + precomputed vario/speed/heading. */
export class FlightTrack {
  constructor(points) {
    if (!points.length) throw new Error('empty track');
    this.points = points;
    this.times = times(points);
    this.vario = verticalSpeeds(points);
    this.groundSpeed = groundSpeeds(points);
    const h = headings(points, 1.0);
    let last = h.find((x) => !Number.isNaN(x)) ?? 0;
    for (let i = 0; i < h.length; i++) { if (Number.isNaN(h[i])) h[i] = last; else last = h[i]; }
    this.heading = h;
  }
  get startMs() { return this.times[0]; }
  get endMs() { return this.times[this.times.length - 1]; }

  /** Index of the last point with time <= timeMs (0 before the start). */
  indexAt(timeMs) {
    const t = this.times;
    if (timeMs <= t[0]) return 0;
    let lo = 0, hi = t.length - 1;
    if (timeMs >= t[hi]) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (t[mid] <= timeMs) lo = mid; else hi = mid; }
    return lo;
  }

  frac(timeMs) {
    const i = this.indexAt(timeMs);
    const j = Math.min(i + 1, this.times.length - 1);
    const span = this.times[j] - this.times[i];
    return [i, j, span > 0 ? Math.min(1, Math.max(0, (timeMs - this.times[i]) / span)) : 0];
  }

  positionAt(timeMs) {
    const [i, j, f] = this.frac(timeMs);
    const a = this.points[i], b = this.points[j];
    const L = (x, y) => x + (y - x) * f;
    return { t: timeMs, lat: L(a.lat, b.lat), lon: L(a.lon, b.lon), alt: L(a.alt, b.alt), hr: f < 0.5 ? a.hr : b.hr };
  }

  interp(arr, timeMs) { const [i, j, f] = this.frac(timeMs); return arr[i] + (arr[j] - arr[i]) * f; }
  varioAt(timeMs) { return this.interp(this.vario, timeMs); }
  groundSpeedAt(timeMs) { return this.interp(this.groundSpeed, timeMs); }
  headingAt(timeMs) {
    const [i, j, f] = this.frac(timeMs);
    const a = this.heading[i], b = this.heading[j];
    return normDeg(a + angleDiff(a, b) * f);
  }
}
