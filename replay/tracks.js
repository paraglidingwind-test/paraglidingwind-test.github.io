// Trasee pentru reluarea 3D: citirea fișierelor (FIT / IGC / GPX, și arhivele .zip / .gz), id-ul SkyReplay și locul unde
// stau. Folosit de replay.html (import static) și de jurnalul din index.html (import dinamic, la nevoie).
//
// Id-ul = primele 10 octeți (20 de cifre hex) din SHA-256 al fișierului de zbor, după despachetarea arhivei. Exact ca
// FlightLibrary.sha() + ArchiveUnwrap din aplicația SkyReplay, deci același zbor are același id pe telefon și pe web.
//
// „Surse” de trasee: deocamdată doar browserul (IndexedDB). O sursă are list() → [meta], get(id) → {meta, bytes} | null,
// put(meta, bytes), remove(id). Google Drive va fi încă o sursă în SOURCES (pasul următor), fără schimbări în pagini.
import { parseFlight } from './lib/importer.js?v=0d26e59';
import { prepare } from './lib/processing.js?v=0d26e59';
import { isFit } from './lib/fit.js?v=0d26e59';
import { distance } from './lib/geo.js?v=0d26e59';

const MAX_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 200, MAX_TOTAL = 100 * 1024 * 1024;
const FLIGHT_EXT = /\.(fit|igc|gpx)$/i;
const latin1 = new TextDecoder('latin1');

/** Pare un fișier de zbor? (ca FlightLibrary.looksLikeFlightFile) */
export function looksLikeFlight(b) {
  if (isFit(b)) return true;
  const head = latin1.decode(b.subarray(0, 1024));
  return head.includes('<gpx') || (head.startsWith('A') && head.includes('\nH'));
}

async function inflate(data, format) {
  if (typeof DecompressionStream === 'undefined') throw new Error('browser fără DecompressionStream');
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    n += value.length; if (n > MAX_BYTES) { reader.cancel(); throw new Error('too-large'); }
    parts.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Garmin Connect „Export Original” dă un .zip cu .fit înăuntru; exporturile în masă dau .fit.gz.
 * Întoarce primul fișier de zbor din arhivă (octeții + numele lui) sau intrarea neschimbată. Ca ArchiveUnwrap.unwrap().
 */
export async function unwrap(bytes, name) {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('bad-zip');
    const count = dv.getUint16(eocd + 10, true);
    if (count > MAX_ENTRIES) throw new Error('bad-zip');
    let p = dv.getUint32(eocd + 16, true), total = 0, fallback = null;
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad-zip');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
      const full = dec.decode(bytes.subarray(p + 46, p + 46 + nlen)), inner = full.split('/').pop();
      p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
      if (!inner || full.endsWith('/') || (method !== 0 && method !== 8)) continue;
      total += usize; if (total > MAX_TOTAL || usize > MAX_BYTES) throw new Error('too-large');
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const read = async () => { const raw = bytes.subarray(start, start + csize); return method === 8 ? inflate(raw, 'deflate-raw') : raw.slice(); };
      if (FLIGHT_EXT.test(inner)) return { bytes: await read(), name: inner };
      if (!fallback) { const b = await read(); if (looksLikeFlight(b)) fallback = { bytes: b, name: inner }; }
    }
    if (fallback) return fallback;
    throw new Error('zip-empty');
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return { bytes: await inflate(bytes, 'gzip'), name: name ? name.replace(/\.gz$/i, '') : name };
  }
  return { bytes, name };
}

/** Id-ul SkyReplay: SHA-256, primii 10 octeți, hex. */
export async function trackId(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(h.subarray(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
}

const pad = (n) => String(n).padStart(2, '0');
/** Data locală AAAA-LL-ZZ a unui moment (ca Logbook.date cu fusul orar al dispozitivului). */
export const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** Rezumatul unui zbor citit și curățat: ce afișează jurnalul fără să recitească fișierul. */
export function summarize(id, name, flight) {
  const pts = flight.points;
  const startMs = pts[0].t, endMs = pts[pts.length - 1].t;
  let dist = 0, maxAlt = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i) dist += distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    maxAlt = Math.max(maxAlt, pts[i].altBaro ?? pts[i].alt);
  }
  return {
    id, name: name || null, startMs, endMs,
    minutes: Math.round(Math.floor((endMs - startMs) / 1000) / 60),   // ca Logbook.minutes(durationS)
    date: localDate(startMs), lat: pts[0].lat, lon: pts[0].lon, sport: flight.sport || null,
    maxAlt: Math.round(maxAlt), distKm: Math.round(dist / 100) / 10, site: null, addedAt: Date.now(),
  };
}

/**
 * Citește un fișier ales de utilizator: despachetează, calculează id-ul, verifică că e un zbor cu puncte GPS.
 * Întoarce {meta, bytes} (încă nesalvat). Erori: 'not-flight', 'no-gps', 'too-large', 'bad-zip', 'zip-empty', 'read'.
 */
export async function readTrackFile(buf, fileName) {
  const raw = new Uint8Array(buf);
  if (raw.length > MAX_BYTES) throw new Error('too-large');
  const { bytes, name } = await unwrap(raw, fileName);
  if (!looksLikeFlight(bytes) && !/\.(igc|gpx)$/i.test(name || '')) throw new Error('not-flight');
  let flight;
  try { flight = prepare(parseFlight(bytes, name)); } catch { throw new Error('read'); }
  if (flight.points.length < 2) throw new Error('no-gps');
  return { meta: summarize(await trackId(bytes), name, flight), bytes };
}

// ------------------------------------------------------------------ IndexedDB (trasee păstrate în acest browser)
const DB = 'vld-skyreplay';
let dbP = null;
function db() {
  return dbP ??= new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('meta', { keyPath: 'id' }); d.createObjectStore('files', { keyPath: 'id' }); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { dbP = null; fail(r.error); };
  });
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((ok, fail) => {
    const t = d.transaction(stores, mode), res = fn(t);
    t.oncomplete = () => ok(res?.result ?? res);
    t.onerror = t.onabort = () => fail(t.error);
  });
}
export const deviceSource = {
  id: 'device',
  list: () => tx(['meta'], 'readonly', (t) => t.objectStore('meta').getAll()),
  async get(id) {
    let meta, file;
    await tx(['meta', 'files'], 'readonly', (t) => {
      const a = t.objectStore('meta').get(id), b = t.objectStore('files').get(id);
      a.onsuccess = () => { meta = a.result; }; b.onsuccess = () => { file = b.result; };
    });
    return meta && file ? { meta, bytes: new Uint8Array(file.bytes) } : null;
  },
  put: (meta, bytes) => tx(['meta', 'files'], 'readwrite', (t) => {
    t.objectStore('meta').put(meta);
    t.objectStore('files').put({ id: meta.id, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }),
  updateMeta: (meta) => tx(['meta'], 'readwrite', (t) => { t.objectStore('meta').put(meta); }),
  remove: (id) => tx(['meta', 'files'], 'readwrite', (t) => { t.objectStore('meta').delete(id); t.objectStore('files').delete(id); }),
};

/** Sursele, în ordinea în care se caută un traseu. */
export const SOURCES = [deviceSource];

/** Toate traseele cunoscute (rezumatele), fără dubluri, cele mai noi primele. */
export async function listTracks() {
  const by = new Map();
  for (const s of SOURCES) { try { for (const m of await s.list()) if (!by.has(m.id)) by.set(m.id, { ...m, source: s.id }); } catch { /* sursă indisponibilă */ } }
  return [...by.values()].sort((a, b) => b.startMs - a.startMs);
}

/** Un traseu după id: {meta, bytes} din prima sursă care îl are, sau null. */
export async function loadTrack(id) {
  for (const s of SOURCES) { try { const r = await s.get(id); if (r) return { ...r, source: s.id }; } catch { /* următoarea sursă */ } }
  return null;
}

/** Păstrează traseul în browser (dacă nu e deja). Întoarce {meta, existed}. */
export async function saveTrack(meta, bytes) {
  const old = await deviceSource.get(meta.id).catch(() => null);
  if (old) return { meta: old.meta, existed: true };
  await deviceSource.put(meta, bytes);
  return { meta, existed: false };
}

/** Citește + păstrează un fișier ales sau tras pe pagină. */
export async function addTrackFile(file) {
  const { meta, bytes } = await readTrackFile(await file.arrayBuffer(), file.name);
  return saveTrack(meta, bytes);
}

export const removeTrack = (id) => deviceSource.remove(id);
export const setTrackSite = async (id, site) => { const r = await deviceSource.get(id); if (r) await deviceSource.updateMeta({ ...r.meta, site }); };

/** Pentru jurnal: id valid de zbor SkyReplay în adresa paginii. */
export const ID_RE = /^[0-9a-f]{8,64}$/;
