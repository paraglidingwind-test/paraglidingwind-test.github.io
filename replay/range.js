// Porțiunea din zbor (ca în aplicația SkyReplay: ui/replay/RangeUi.kt, ReplayViewModel). Logică pură, testată în tests/replay-range.test.mjs.
// Timpii sunt ms epoch; o porțiune e {a, b} cu a < b, în interiorul zborului.

export const MIN_RANGE_MS = 20_000;
export const THERMAL_MARGIN_MS = 30_000;

/** Porțiunea [a, b] ordonată, tăiată la zbor și de cel puțin `min` ms (se lungește spre dreapta, apoi spre stânga). */
export function clampRange(a, b, start, end, min = MIN_RANGE_MS) {
  if (!(end > start)) return null;
  let lo = Math.min(a, b), hi = Math.max(a, b);
  lo = Math.max(start, Math.min(end, lo)); hi = Math.max(start, Math.min(end, hi));
  const m = Math.min(min, end - start);
  if (hi - lo < m) { hi = Math.min(end, lo + m); lo = Math.max(start, hi - m); }
  return { a: Math.round(lo), b: Math.round(hi) };
}

/** Mută un mâner ('a' sau 'b') la `t`; celălalt rămâne pe loc, iar distanța dintre ele rămâne de cel puțin `min`. */
export function moveHandle(r, which, t, start, end, min = MIN_RANGE_MS) {
  const m = Math.min(min, end - start);
  if (which === 'a') return { a: Math.round(Math.max(start, Math.min(t, r.b - m))), b: r.b };
  return { a: r.a, b: Math.round(Math.min(end, Math.max(t, r.a + m))) };
}

/** Porțiunea acoperă tot zborul (deci nu e o porțiune). */
export const isWhole = (r, start, end) => !r || (r.a <= start && r.b >= end);

/**
 * Alegerile rapide, în ordinea din aplicație: tot zborul, decolare → prima termică, ultimele 5/15/30 min
 * (până la momentul curent, sau până la aterizare dacă suntem în primele 5 min), apoi fiecare termică ±30 s.
 */
export function quickPicks(thermals, start, end, nowMs) {
  const clamp = (a, b) => clampRange(a, b, start, end);
  const out = [{ key: 'whole', range: null }];
  if (thermals.length) out.push({ key: 'toFirst', range: clamp(start, thermals[0].startMs) });
  let anchor = Math.max(start, Math.min(end, nowMs));
  if (anchor - start < 5 * 60_000) anchor = end;
  for (const m of [5, 15, 30]) if (end - start > m * 60_000) out.push({ key: 'last', min: m, range: clamp(anchor - m * 60_000, anchor) });
  thermals.forEach((th, i) => out.push({ key: 'thermal', n: i + 1, th, range: clamp(th.startMs - THERMAL_MARGIN_MS, th.endMs + THERMAL_MARGIN_MS) }));
  return out;
}

export const sameRange = (x, y) => (!x && !y) || (!!x && !!y && x.a === y.a && x.b === y.b);

/** „14:24”, „14:24:08” sau „142408” în ziua lui `dayMs` (ora locală) → ms epoch; null dacă nu e o oră validă. */
export function parseClock(text, dayMs) {
  const s = String(text).replace(/[^\d:.]/g, '').replace(/\./g, ':');
  const parts = s.includes(':') ? s.split(':') : s.match(/.{1,2}/g) || [];
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d{1,2}$/.test(p))) return null;
  const [h, m, sec = 0] = parts.map(Number);
  if (h > 23 || m > 59 || sec > 59) return null;
  const d = new Date(dayMs);
  d.setHours(h, m, sec, 0);
  return d.getTime();
}

/**
 * Pasul de redare în porțiune: după capăt, în buclă se reia de la început, altfel se oprește la capăt.
 * Întoarce {t, stop}. Fără porțiune: oprire la aterizare.
 */
export function stepInRange(t, r, loop, start, end) {
  const a = r ? r.a : start, b = r ? r.b : end;
  if (t < a) return { t: a, stop: false };
  if (t >= b) return r && loop ? { t: a, stop: false } : { t: b, stop: true };
  return { t, stop: false };
}

/** Indicii punctelor din [a, b] (inclusiv câte un punct de margine), după vectorul de timpi crescător. */
export function rangeIndices(times, a, b) {
  const n = times.length;
  const lower = (x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >>> 1; if (times[m] < x) lo = m + 1; else hi = m; } return lo; };
  const i0 = Math.max(0, lower(a) - 1), i1 = Math.min(n - 1, lower(b));
  return [i0, Math.max(i0, i1)];
}

// ------------------------------------------------------------------ memorare per zbor (localStorage)
const KEY = 'vld.replayRanges';
const KEEP = 40;
export function loadRange(storage, id, start, end) {
  try {
    const all = JSON.parse(storage.getItem(KEY)) || {};
    const v = all[id];
    if (!Array.isArray(v)) return null;
    const r = clampRange(v[0], v[1], start, end);
    return r && !isWhole(r, start, end) ? r : null;
  } catch { return null; }
}
export function saveRange(storage, id, r) {
  try {
    const all = JSON.parse(storage.getItem(KEY)) || {};
    if (r) all[id] = [r.a, r.b, Date.now()]; else delete all[id];
    const ids = Object.keys(all).sort((x, y) => (all[y][2] || 0) - (all[x][2] || 0));
    for (const k of ids.slice(KEEP)) delete all[k];
    storage.setItem(KEY, JSON.stringify(all));
  } catch { /* fără stocare */ }
}
