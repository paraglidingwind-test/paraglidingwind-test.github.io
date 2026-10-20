// Wind from circling flight. Mirrors ro.parapanta.skyreplay.analysis.WindEstimator (Kotlin):
// per full turn a Kasa least-squares circle fit of the ground-velocity vectors (centre = wind,
// radius = airspeed), plausibility checks, then vector averaging per altitude band.
import { Enu, normDeg, vectorDir } from './geo.js?v=0d26e59';
import { DEFAULT_CONFIG, circlingSegments, cumulativeTurn, turns } from './thermals.js?v=0d26e59';

/** Algebraic (Kasa) circle fit → { cx, cy, r, rms } or null. */
export function fitCircle(x, y) {
  const n = x.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = x[i] - mx, v = y[i] - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (suu * b2 - suv * b1) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  const cx = uc + mx, cy = vc + my;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = Math.hypot(x[i] - cx, y[i] - cy) - r; ss += d * d; }
  return { cx, cy, r, rms: Math.sqrt(ss / n) };
}

/** One wind estimate per plausible full turn: { timeMs, altM, dirFromDeg, speedMs, airspeedMs, rmsMs }. */
export function estimateTurns(points, cfg = DEFAULT_CONFIG) {
  if (points.length < 5) return [];
  const segs = circlingSegments(points, cfg);
  if (!segs.length) return [];
  const cum = cumulativeTurn(points, cfg.minSpeed);
  const enu = new Enu(points[0].lat, points[0].lon);
  const n = points.length;
  const vx = new Float64Array(n), vy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    const dt = (b.t - a.t) / 1000;
    if (dt > 0 && dt <= 10) { vx[i] = (enu.x(b.lon) - enu.x(a.lon)) / dt; vy[i] = (enu.y(b.lat) - enu.y(a.lat)) / dt; }
    else { vx[i] = NaN; vy[i] = NaN; }
  }
  const out = [];
  for (const s of segs) for (const [f, l] of turns(points, s, cum)) {
    const idx = [];
    for (let k = f; k < l; k++) if (!Number.isNaN(vx[k])) idx.push(k);
    if (idx.length < 8) continue;
    const fit = fitCircle(idx.map((k) => vx[k]), idx.map((k) => vy[k]));
    if (!fit) continue;
    const ws = Math.hypot(fit.cx, fit.cy);
    if (fit.r < 4 || fit.r > 25 || ws > 25 || ws > fit.r * 1.2 || fit.rms > 0.35 * fit.r) continue;
    const mid = (f + l) >> 1;
    const alt = idx.reduce((s2, k) => s2 + points[k].alt, 0) / idx.length;
    out.push({ timeMs: points[mid].t, altM: alt, dirFromDeg: normDeg(vectorDir(fit.cx, fit.cy) + 180), speedMs: ws, airspeedMs: fit.r, rmsMs: fit.rms });
  }
  return out;
}

/** Vector-averaged wind per altitude band: [{ altM, dirFromDeg, speedMs, n }], sorted by altitude. */
export function windBands(turnWinds, bandM = 100) {
  const groups = new Map();
  for (const w of turnWinds) {
    const k = Math.floor(w.altM / bandM);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((k) => {
    const ts = groups.get(k);
    let ex = 0, ny = 0;
    for (const w of ts) {
      const to = (w.dirFromDeg + 180) * Math.PI / 180;
      ex += w.speedMs * Math.sin(to); ny += w.speedMs * Math.cos(to);
    }
    ex /= ts.length; ny /= ts.length;
    return {
      altM: ts.reduce((s, w) => s + w.altM, 0) / ts.length,
      dirFromDeg: normDeg(Math.atan2(ex, ny) * 180 / Math.PI + 180),
      speedMs: Math.hypot(ex, ny), n: ts.length,
    };
  });
}

export function estimateWind(points, bandM = 100, cfg = DEFAULT_CONFIG) {
  return windBands(estimateTurns(points, cfg), bandM);
}
