// Circling + thermal detection. Mirrors ro.parapanta.skyreplay.analysis.ThermalDetector (Kotlin):
// same defaults, same hysteresis state machine, merge, trim and filters. Index ranges are [first, last].
import { angleDiff, Enu, vectorDir } from './geo.js?v=0d26e59';
import { headings, times, windowMean, windowSlope, climbAltitudes } from './processing.js?v=0d26e59';

export const DEFAULT_CONFIG = Object.freeze({
  windowS: 35, minTurnDeg: 300, mergeGapS: 20, minDurationS: 30, minSpeed: 1.5,
  turnWindowS: 45, turnDeg: 270, minClimb: 0.1, maxStraightS: 40, sinkDropM: 8, sinkRate: -0.1,
  maxLeadInS: 120, stallS: 25, minCirclingGainShare: 0.5, thermalGapS: 45, mergeDistM: 300, mergeDropM: 20,
  minGainM: 15, minThermalS: 30,
});

/** Cumulative signed heading change (deg, + = clockwise). */
export function cumulativeTurn(points, minSpeed = 1.5) {
  const h = headings(points, minSpeed);
  const c = new Float64Array(points.length);
  let last = NaN;
  for (let i = 0; i < points.length; i++) {
    let d = 0;
    if (!Number.isNaN(h[i])) {
      if (!Number.isNaN(last) && i > 0 && points[i].t - points[i - 1].t <= 10000) d = angleDiff(last, h[i]);
      last = h[i];
    }
    c[i] = (i > 0 ? c[i - 1] : 0) + d;
  }
  return c;
}

/** Per point: inside a window <= windowS s whose net heading change reaches minTurnDeg. */
export function circlingFlags(points, windowS, minTurnDeg, minSpeed = 1.5) {
  const n = points.length;
  const c = cumulativeTurn(points, minSpeed);
  const win = windowS * 1000;
  const circ = new Uint8Array(n);
  let covered = -1;
  for (let i = 0; i < n; i++) {
    for (let k = i + 1; k < n && points[k].t - points[i].t <= win; k++) {
      if (Math.abs(c[k] - c[i]) >= minTurnDeg) {
        for (let m = Math.max(i, covered + 1); m <= k; m++) circ[m] = 1;
        covered = Math.max(covered, k);
        break;
      }
    }
  }
  return circ;
}

/** Index ranges where the pilot is circling. */
export function circlingSegments(points, cfg = DEFAULT_CONFIG) {
  const n = points.length;
  if (n < 3) return [];
  const c = cumulativeTurn(points, cfg.minSpeed);
  const circ = circlingFlags(points, cfg.windowS, cfg.minTurnDeg, cfg.minSpeed);
  const raw = [];
  for (let i = 0; i < n;) {
    if (!circ[i]) { i++; continue; }
    let j = i;
    while (j + 1 < n && circ[j + 1]) j++;
    raw.push([i, j]); i = j + 1;
  }
  const merged = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (points[r[0]].t - points[prev[1]].t) / 1000 <= cfg.mergeGapS) prev[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  const rate = (i) => {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dt = (points[b].t - points[a].t) / 1000;
    return dt > 0 ? Math.abs(c[b] - c[a]) / dt : 0;
  };
  const minRate = cfg.minTurnDeg / cfg.windowS / 2;
  const out = [];
  for (const [f, l] of merged) {
    let a = f, b = l;
    while (a < b && rate(a) < minRate) a++;
    while (b > a && rate(b) < minRate) b--;
    if ((points[b].t - points[a].t) / 1000 >= cfg.minDurationS) out.push([a, b]);
  }
  return out;
}

/** Splits a segment into consecutive full turns (~360 deg each). */
export function turns(points, seg, cum = null) {
  const c = cum ?? cumulativeTurn(points);
  const out = [];
  let start = seg[0];
  for (let i = seg[0] + 1; i <= seg[1]; i++) {
    if (Math.abs(c[i] - c[start]) >= 360) { out.push([start, i]); start = i; }
  }
  return out;
}

function slope(x, y) {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  return den > 1e-9 ? num / den : null;
}

/** Drift of the turn centres: { dir (deg TO), speed (m/s) } or null if < 2 turns. */
export function drift(points, trs) {
  if (trs.length < 2) return null;
  const ref = points[trs[0][0]];
  const enu = new Enu(ref.lat, ref.lon);
  const ts = [], xs = [], ys = [];
  for (const [f, l0] of trs) {
    const l = l0 > f ? l0 - 1 : l0;
    let x = 0, y = 0, t = 0;
    for (let k = f; k <= l; k++) { x += enu.x(points[k].lon); y += enu.y(points[k].lat); t += points[k].t / 1000; }
    const m = l - f + 1;
    xs.push(x / m); ys.push(y / m); ts.push(t / m);
  }
  const vx = slope(ts, xs); if (vx == null) return null;
  const vy = slope(ts, ys); if (vy == null) return null;
  return { dir: vectorDir(vx, vy), speed: Math.hypot(vx, vy) };
}

/** Thermal ranges [base, top] (index), as a pilot sees them. */
export function thermalRanges(points, cfg = DEFAULT_CONFIG, pre = null) {
  const n = points.length;
  if (n < 10) return [];
  const t = pre?.t ?? times(points);
  const alt = pre?.alt ?? windowMean(t, climbAltitudes(points), 2.5);
  const vz = windowSlope(t, alt, 10);
  const circ = circlingFlags(points, cfg.turnWindowS, cfg.turnDeg, cfg.minSpeed);
  const maxStraight = cfg.maxStraightS * 1000;

  const trailingRate = (i) => {
    let j = i;
    while (j > 0 && t[i] - t[j - 1] <= 40000) j--;
    const dt = (t[i] - t[j]) / 1000;
    return dt >= 20 ? (alt[i] - alt[j]) / dt : 0;
  };

  // 1. hysteresis state machine
  const raw = [];
  let inTh = false, start = 0, lastCirc = 0, top = 0;
  for (let i = 0; i < n; i++) {
    if (!inTh) {
      if (circ[i] && vz[i] > cfg.minClimb) { inTh = true; start = i; lastCirc = i; top = alt[i]; }
      continue;
    }
    if (circ[i]) lastCirc = i;
    top = Math.max(top, alt[i]);
    const sinkExit = top - alt[i] > cfg.sinkDropM && trailingRate(i) < cfg.sinkRate;
    if (sinkExit || t[i] - t[lastCirc] > maxStraight) {
      raw.push([start, sinkExit ? i : lastCirc]);
      inTh = false;
    }
  }
  if (inTh) raw.push([start, lastCirc]);

  // 2. merge consecutive ranges of the same climb
  const merged = [];
  for (const r of raw) {
    const prev = merged[merged.length - 1];
    if (prev && shouldMerge(points, alt, prev, r, cfg)) prev[1] = r[1];
    else merged.push([r[0], r[1]]);
  }

  // 3. cut each to base..top and filter
  const out = [];
  for (const m of merged) {
    const r = trimToClimb(t, alt, vz, m, cfg);
    if (r[1] <= r[0]) continue;
    const dur = (t[r[1]] - t[r[0]]) / 1000;
    const gain = alt[r[1]] - alt[r[0]];
    const from = Math.max(r[0], m[0]);
    const climbFromEntry = alt[r[1]] - alt[from];
    let circGain = 0;
    for (let k = from + 1; k <= r[1]; k++) if (circ[k]) circGain += alt[k] - alt[k - 1];
    if (dur >= cfg.minThermalS && gain >= cfg.minGainM && gain / dur >= cfg.minClimb &&
        circGain >= cfg.minCirclingGainShare * climbFromEntry) out.push(r);
  }
  return out;
}

function trimToClimb(t, alt, vz, r, cfg) {
  let top = r[0];
  for (let k = r[0]; k <= r[1]; k++) if (alt[k] > alt[top]) top = k;
  let from = r[0];
  let b = r[0];
  while (b > 0 && vz[b - 1] > 0 && t[b] - t[b - 1] <= 10000) b--;
  if (b === 0 && t[r[0]] - t[0] <= cfg.maxLeadInS * 1000) from = 0;
  let base = from;
  for (let k = from; k <= top; k++) if (alt[k] < alt[base]) base = k;
  const stall = cfg.stallS * 1000;
  for (;;) {
    let runMax = alt[base], runMaxI = base, cut = -1;
    for (let k = base; k <= top; k++) {
      if (alt[k] > runMax + 0.5) {
        if (t[k] - t[runMaxI] >= stall && runMax - alt[base] < (alt[top] - alt[base]) / 3) {
          cut = runMaxI;
          for (let m = runMaxI; m <= k; m++) if (alt[m] < alt[cut]) cut = m;
          break;
        }
        runMax = alt[k]; runMaxI = k;
      }
    }
    if (cut < 0 || cut === base) break;
    base = cut;
  }
  return [base, top];
}

function shouldMerge(p, alt, a, b, cfg) {
  const gapS = (p[b[0]].t - p[a[1]].t) / 1000;
  if (gapS > cfg.thermalGapS) return false;
  let topA = a[0];
  for (let k = a[0]; k <= a[1]; k++) if (alt[k] > alt[topA]) topA = k;
  if (alt[topA] - alt[b[0]] > cfg.mergeDropM) return false;
  const enu = new Enu(p[a[1]].lat, p[a[1]].lon);
  const centre = (f, l) => {
    let x = 0, y = 0, tt = 0, m = 0;
    for (let k = f; k <= l; k++) { x += enu.x(p[k].lon); y += enu.y(p[k].lat); tt += p[k].t / 1000; m++; }
    return [x / m, y / m, tt / m];
  };
  let jb = a[1]; while (jb > 0 && p[a[1]].t - p[jb - 1].t <= 30000) jb--;
  let ja = b[0]; while (ja < p.length - 1 && p[ja + 1].t - p[b[0]].t <= 30000) ja++;
  const endA = centre(Math.max(a[0], jb), a[1]);
  const startB = centre(b[0], Math.min(b[1], ja));
  let dx = startB[0] - endA[0], dy = startB[1] - endA[1];
  const d = drift(p, turns(p, a));
  if (d) {
    const dt = startB[2] - endA[2];
    const rad = d.dir * Math.PI / 180;
    dx -= d.speed * Math.sin(rad) * dt;
    dy -= d.speed * Math.cos(rad) * dt;
  }
  return Math.hypot(dx, dy) < cfg.mergeDistM;
}

/**
 * Detected thermals: { startMs, endMs, lat, lon, baseAlt, topAlt, avgClimb, driftDirDeg, driftSpeed, i0, i1 }.
 * baseAlt is anchored to GPS altitude (AMSL); the baro gives the height difference.
 */
export function detectThermals(points, cfg = DEFAULT_CONFIG) {
  const t = times(points);
  const alt = windowMean(t, climbAltitudes(points), 2.5);
  const cum = cumulativeTurn(points, cfg.minSpeed);
  return thermalRanges(points, cfg, { t, alt }).map(([f, l]) => {
    const dur = (t[l] - t[f]) / 1000;
    const gain = alt[l] - alt[f];
    let lat = 0, lon = 0;
    for (let k = f; k <= l; k++) { lat += points[k].lat; lon += points[k].lon; }
    const m = l - f + 1;
    const base = points[f].alt;
    const d = drift(points, turns(points, [f, l], cum));
    return {
      startMs: t[f], endMs: t[l], lat: lat / m, lon: lon / m, baseAlt: base, topAlt: base + gain,
      avgClimb: dur > 0 ? gain / dur : 0, driftDirDeg: d?.dir ?? null, driftSpeed: d?.speed ?? null, i0: f, i1: l,
    };
  });
}
