// IGC + GPX parsers. Mirror ro.parapanta.skyreplay.io.IgcParser / GpxParser (Kotlin).

// ------------------------------------------------------------------ IGC
export function looksLikeIgc(text) {
  const head = text.trimStart().slice(0, 4096);
  return (head.startsWith('A') && /^H[FOP]/m.test(head)) ||
    /^HFDTE/m.test(head) ||
    /^B\d{6}\d{7}[NS]\d{8}[EW][AV]/m.test(text.slice(0, 200000));
}

function igcDate(line) {
  const m = /(\d{2})(\d{2})(\d{2})/.exec(line.slice(5));
  if (!m) return null;
  const d = +m[1], mo = +m[2], yy = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(yy < 80 ? 2000 + yy : 1900 + yy, mo - 1, d);
}

function parseB(l) {
  const int = (a, b) => { const s = l.slice(a, b); return /^\d+$/.test(s) ? +s : NaN; };
  const hh = int(1, 3), mm = int(3, 5), ss = int(5, 7);
  if (!(hh <= 23 && mm <= 59 && ss <= 59)) return null;
  let lat = int(7, 9) + int(9, 14) / 60000;
  if (l[14] === 'S') lat = -lat; else if (l[14] !== 'N') return null;
  let lon = int(15, 18) + int(18, 23) / 60000;
  if (l[23] === 'W') lon = -lon; else if (l[23] !== 'E') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  const valid = l[24] === 'A';
  const num = (s) => { s = s.trim(); return /^-?\d+$/.test(s) ? +s : null; };
  const pAlt = num(l.slice(25, 30));
  const gAlt = num(l.slice(30, 35));
  const gps = gAlt != null && valid && gAlt !== 0 ? gAlt : null;
  const baro = pAlt != null && pAlt !== 0 ? pAlt : null;
  const alt = gps ?? baro ?? gAlt ?? pAlt;
  if (alt == null) return null;
  return { sod: hh * 3600 + mm * 60 + ss, lat, lon, alt, altBaro: baro };
}

export function parseIgc(text, sourceName = null) {
  let dayStartMs = 0, dateSet = false, lastSod = -1, dayOffset = 0;
  const pts = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[\r ]+$/, '');
    if (line.startsWith('HFDTE') && !dateSet) {
      const d = igcDate(line);
      if (d != null) { dayStartMs = d; dateSet = true; }
    } else if (line.length >= 35 && line[0] === 'B') {
      const p = parseB(line);
      if (!p) continue;
      if (lastSod >= 0 && p.sod < lastSod - 3600) dayOffset += 86400000;
      lastSod = p.sod;
      const t = dayStartMs + dayOffset + p.sod * 1000;
      if (pts.length && pts[pts.length - 1].t >= t) continue;
      pts.push({ t, lat: p.lat, lon: p.lon, alt: p.alt, altBaro: p.altBaro, vario: null, speed: null, hr: null });
    }
  }
  return { points: pts, sport: null, sourceName };
}

// ------------------------------------------------------------------ GPX
export function looksLikeGpx(text) {
  const head = text.slice(0, 8192);
  return /<(\w+:)?gpx[\s>]/.test(head) || /<(\w+:)?trkpt\b/.test(head);
}

const tagCache = new Map();
function tag(body, name) {
  let re = tagCache.get(name);
  if (!re) { re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}\\s*>`); tagCache.set(name, re); }
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

/** ISO time → epoch ms; a time without zone designator is read as UTC (like the Kotlin version). */
export function parseGpxTime(s) {
  if (!s) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const ms = Date.parse(hasZone ? s : s + 'Z');
  return Number.isFinite(ms) ? ms : null;
}

const toNum = (s) => { if (s == null || s === '') return null; const v = Number(s); return Number.isFinite(v) ? v : null; };

export function parseGpx(text, sourceName = null) {
  const name = tag(text, 'name');
  const ptStart = /<(?:\w+:)?(trkpt|rtept)\b([^>]*?)(\/?)>/g;
  const all = [...text.matchAll(ptStart)];
  const useTag = all.some((m) => m[1] === 'trkpt') ? 'trkpt' : 'rtept';
  const closeRe = new RegExp(`</(?:\\w+:)?${useTag}\\s*>`, 'g');
  const pts = [];
  let lastAlt = 0, syntheticT = 0;
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (m[1] !== useTag) continue;
    const attrs = m[2];
    const lat = toNum(/\blat\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]);
    const lon = toNum(/\blon\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]);
    if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    let body = '';
    if (m[3] !== '/') {
      const bodyStart = m.index + m[0].length;
      closeRe.lastIndex = bodyStart;
      const close = closeRe.exec(text);
      const next = all[i + 1];
      const ends = [close?.index, next?.index].filter((x) => x != null);
      body = text.slice(bodyStart, ends.length ? Math.min(...ends) : text.length);
    }
    const ele = toNum(tag(body, 'ele'));
    if (ele != null) lastAlt = ele;
    const tt = parseGpxTime(tag(body, 'time'));
    const time = tt ?? syntheticT + 1000;
    syntheticT = time;
    const hr = toNum(tag(body, 'hr'));
    pts.push({ t: time, lat, lon, alt: ele ?? lastAlt, altBaro: null, vario: null, speed: toNum(tag(body, 'speed')), hr: hr != null ? Math.trunc(hr) : null });
  }
  pts.sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const p of pts) if (!dedup.length || dedup[dedup.length - 1].t !== p.t) dedup.push(p);
  return { points: dedup, sport: null, sourceName: sourceName ?? name };
}
