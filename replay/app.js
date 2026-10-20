// Reluarea 3D a unui zbor (paraglidingwind.com/replay.html). Portat din prototipul ~/Projects/skyreplay-web.
// Logica pură e în ./lib (oglinda codului Kotlin din aplicația SkyReplay; contract: tests/replay-contract.test.mjs).
// Traseele stau în browser (./tracks.js); pagina se deschide cu replay.html#flight=<id SkyReplay>.
import { parseFlight } from './lib/importer.js?v=0d26e59';
import { clean, prepare, FlightTrack } from './lib/processing.js?v=0d26e59';
import { detectThermals } from './lib/thermals.js?v=0d26e59';
import { estimateWind } from './lib/wind.js?v=0d26e59';
import { bearing as geoBearing, distance, angleDiff, normDeg } from './lib/geo.js?v=0d26e59';
import { t, LOC, translateStatic } from './i18n.js?v=0d26e59';
import { addTrackFile, loadTrack, listTracks, removeTrack, ID_RE } from './tracks.js?v=0d26e59';
import { clampRange, moveHandle, isWhole, quickPicks, sameRange, parseClock, stepInRange, rangeIndices, loadRange, saveRange, MIN_RANGE_MS } from './range.js?v=0d26e59';
import { gliderMesh, headingBank, lerpAngle, gliderScale, metersPerPixel } from './glider.js?v=0d26e59';
import { recorderSupport, recordVideo } from './recorder.js?v=0d26e59';
import { cleanIonToken, resolveIon } from './ion.js?v=0d26e59';
import { currentDevice } from './device.js?v=0d26e59';
import { FORMATS, DURATIONS, SPEEDUPS, durationForSpeed, renderPlan, videoFileName } from './video.js?v=0d26e59';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
translateStatic();

// ------------------------------------------------------------------ surse / atribuire
// EOX Sentinel-2 cloudless: CC BY-NC-SA 4.0, potrivit doar pentru un site gratuit, necomercial (cum e acesta).
const EOX_ATTR = '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless 2024</a> by ' +
  '<a href="https://eox.at" target="_blank" rel="noopener">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2024), ' +
  '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>';
const DEM_ATTR = 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Mapzen / AWS Terrain Tiles</a> ' +
  '(SRTM courtesy of the U.S. Geological Survey; EU-DEM: Copernicus data and information funded by the European Union; ' +
  '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">other sources</a>)';

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      eox: {
        type: 'raster', tileSize: 256, maxzoom: 15, attribution: EOX_ATTR,
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'],
      },
      dem: {
        type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: DEM_ATTR,
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      },
      shadow: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0d151b' } },
      { id: 'eox', type: 'raster', source: 'eox' },
      { id: 'track-shadow', type: 'line', source: 'shadow',
        paint: { 'line-color': '#000', 'line-opacity': 0.45, 'line-width': 2.5, 'line-blur': 1 } },
    ],
    terrain: { source: 'dem', exaggeration: 1 },
    sky: {
      'sky-color': '#5d8fc9', 'horizon-color': '#c9dcf0', 'fog-color': '#c9dcf0',
      'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0.6,
    },
  },
  center: [23.55, 46.65], zoom: 9, pitch: 45, maxPitch: 85,
  centerClampedToGround: false,
  attributionControl: false,
  canvasContextAttributes: { antialias: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
// Sursele hărții: controlul MapLibre (se actualizează singur cu sursele active, inclusiv Bing / Cesium ion), mutat în
// bara de jos; ⓘ din dreapta jos le arată / ascunde, deasupra a orice (text deschis pe fundal închis).
map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-left');
{
  const a = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
  if (a) $('credits').append(a);
  const setExpanded = (on) => { $('credits').hidden = !on; $('creditsBtn').setAttribute('aria-expanded', String(on)); };
  $('creditsBtn').onclick = (e) => { e.stopPropagation(); setExpanded($('credits').hidden); };
  $('creditsClose').onclick = () => setExpanded(false);
  // un click oriunde în afara popup-ului îl închide
  document.addEventListener('pointerdown', (e) => {
    if (!$('credits').hidden && !$('credits').contains(e.target) && e.target !== $('creditsBtn')) setExpanded(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('credits').hidden) setExpanded(false); });
}

const overlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
map.addControl(overlay);

// ------------------------------------------------------------------ stare
const S = {
  id: null, flight: null, track: null, pts: null, thermals: [], wind: [], chase: null,
  t: 0, playing: false, speed: 10, cam: 'chase', camBearing: null, zOff: 0, snap: true,
  showThermals: true, layersData: null, timings: {}, fps: 0, scrubbing: false, lastHud: 0,
  range: null, sel: null, loop: true, hb: null, recording: false,
  trackFull: false, trailMin: 4, aheadMin: 2, shadowKey: null,
};
try {
  const tp = JSON.parse(localStorage.getItem('vld.replayTrack')) || {};
  S.trackFull = !!tp.full; S.trailMin = Math.min(15, Math.max(1, Math.round(tp.min) || 4));
  if (Number.isFinite(tp.ahead)) S.aheadMin = Math.min(10, Math.max(0, Math.round(tp.ahead)));
} catch { /* fără stocare */ }
try { S.loop = localStorage.getItem('vld.replayLoop') !== '0'; } catch { /* fără stocare */ }
const GLIDER_MESH = gliderMesh();
window.SR = { S, map, overlay }; // pentru depanare
const SPEEDS = [1, 2, 5, 10, 20, 50, 100];

// ------------------------------------------------------------------ colours
const VARIO_STOPS = [
  [-4, [70, 70, 235]], [-2, [60, 140, 255]], [-0.7, [140, 200, 255]], [0, [235, 235, 235]],
  [0.7, [150, 235, 120]], [1.5, [60, 210, 90]], [2.5, [250, 220, 40]], [3.5, [255, 140, 30]], [5, [255, 50, 50]],
];
function varioColor(v) {
  if (v <= VARIO_STOPS[0][0]) return VARIO_STOPS[0][1];
  for (let i = 1; i < VARIO_STOPS.length; i++) {
    const [b, cb] = VARIO_STOPS[i];
    if (v <= b) {
      const [a, ca] = VARIO_STOPS[i - 1];
      const f = (v - a) / (b - a);
      return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * f));
    }
  }
  return VARIO_STOPS[VARIO_STOPS.length - 1][1];
}
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ------------------------------------------------------------------ încărcare
function setStatus(msg, err = false) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', err); }
const ERR = {
  'not-flight': 'Fișierul nu pare un zbor (FIT, IGC sau GPX).',
  'no-gps': 'Fișierul nu are puncte GPS.',
  'too-large': 'Fișierul e prea mare.',
  'bad-zip': 'Arhiva .zip e stricată.',
  'zip-empty': 'Arhiva nu conține un fișier .fit, .igc sau .gpx.',
  read: 'Nu am putut citi zborul din fișier.',
};
const errText = (e) => t(ERR[e?.message] || 'Nu am putut deschide fișierul.');
const tmFmt = (ms) => new Date(ms).toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = (ms) => new Date(ms).toLocaleDateString(LOC, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const durFmt = (m) => { const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`; };

/** Afișează zborul din octeții unui fișier deja despachetat. */
function showBytes(bytes, name) {
  const t0 = performance.now();
  const raw = parseFlight(bytes, name);
  const t1 = performance.now();
  const prepared = prepare(raw);
  if (prepared.points.length < 10) throw new Error('no-gps');
  const t2 = performance.now();
  const thermals = detectThermals(prepared.points);
  const wind = estimateWind(prepared.points);
  const t3 = performance.now();
  S.timings = { parseMs: t1 - t0, prepareMs: t2 - t1, analysisMs: t3 - t2, rawPoints: raw.points.length };
  startReplay(raw, prepared, thermals, wind);
}

/** Deschide un traseu păstrat în browser (sau, mai târziu, în Drive) după id. */
async function openId(id) {
  setPlaying(false);
  $('intro').hidden = false;
  setStatus(t('Deschid zborul…'));
  const r = await loadTrack(id).catch(() => null);
  if (!r) {
    showIntro(t('Traseul acesta nu e în acest browser. Alege fișierul zborului ca să-l vezi.'));
    return;
  }
  try {
    S.id = id; S.meta = r.meta;
    showBytes(r.bytes, r.meta.name);
    $('flightName').textContent = `${dayFmt(r.meta.startMs)} · ${durFmt(r.meta.minutes)}`;
    document.title = `${t('Reluare 3D')} · ${dayFmt(r.meta.startMs)}`;
    showJournalBar();
  } catch (e) {
    console.error(e);
    showIntro(errText(e), true);
  }
}

/** Un fișier ales sau tras pe pagină: se păstrează în browser, apoi se deschide. */
async function openFile(file) {
  setPlaying(false);
  setStatus(t('Citesc {n}…', { n: file.name }));
  try {
    const { meta } = await addTrackFile(file);
    if (location.hash !== `#flight=${meta.id}`) history.replaceState(null, '', `#flight=${meta.id}`);
    await openId(meta.id);
  } catch (e) {
    console.error(e);
    $('intro').hidden = false;
    setStatus(errText(e), true);
  }
}

/** Zborul nu e în jurnal (nicio zi nu are id-ul lui): oferim „Adaugă în jurnal”. Jurnalul hotărăște ziua (index.html). */
function showJournalBar() {
  let flights = [];
  try { flights = JSON.parse(localStorage.getItem('vld.flights')) || []; } catch { /* fără stocare */ }
  const inLog = flights.some((f) => f.sr?.includes(S.id));
  $('journalBar').hidden = inLog;
  if (!inLog) {
    $('journalTxt').textContent = t('Zborul nu e încă în jurnal.');
    $('journalAdd').href = `index.html#addtrack=${S.id}`;
  }
  document.documentElement.style.setProperty('--panel-h', `${$('panel').offsetHeight}px`);
}

async function showIntro(msg, err = false) {
  for (const id of ['hud', 'panel', 'menuBtn', 'helpFab']) $(id).hidden = true;
  $('intro').hidden = false;
  setStatus(msg || '', err);
  const list = await listTracks().catch(() => []);
  $('recent').hidden = !list.length;
  $('recentList').innerHTML = trackItems(list.slice(0, 8));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trackItems = (list) => list.map((m) => `<li><span>${escapeHtml(dayFmt(m.startMs))} · ${tmFmt(m.startMs)} · ${durFmt(m.minutes)}${m.site ? ' · ' + escapeHtml(m.site) : ''}</span>
  <a class="btn" href="#flight=${m.id}"${m.id === S.id ? ' aria-current="true"' : ''}>${t(m.id === S.id ? 'Deschis' : 'Deschide')}</a></li>`).join('');

// ------------------------------------------------------------------ replay setup
function startReplay(raw, prepared, thermals, wind) {
  const pts = prepared.points;
  const track = new FlightTrack(pts);
  S.flight = prepared; S.raw = raw; S.pts = pts; S.track = track; S.thermals = thermals; S.wind = wind;
  S.t = track.startMs; S.camBearing = null; S.zOff = 0;
  S.chase = chaseBearings(pts);
  S.hb = headingBank(pts);
  S.groundRef = groundRefPoint(raw, pts);
  S.sel = null;
  S.range = S.id ? loadRange(localStorage, S.id, track.startMs, track.endMs) : null;
  if (S.range) S.t = S.range.a;

  // static layer data (positions get zOff added at build time)
  const ts = Array.from(track.times, (t) => (t - track.startMs) / 1000);
  const colors = Array.from(track.vario, (v) => varioColor(v));
  S.layersData = { ts, colors };
  rebuildStatic();

  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const p of pts) { minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); }
  const panelH = $('panel').offsetHeight || 150;
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
    padding: { top: 160, bottom: panelH + 30, left: 30, right: 30 }, pitch: 55, bearing: S.chase[0] ?? 0, duration: 0,
  });

  $('intro').hidden = true; setStatus('');
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  for (const id of ['hud', 'panel', 'menuBtn', 'helpFab']) $(id).hidden = false;
  document.documentElement.style.setProperty('--panel-h', `${$('panel').offsetHeight}px`);
  buildSheet();
  closeSelect(false);
  renderRangeBar();
  resizeProfile();
  map.once('idle', () => { computeZOff(); update(true); });

  const st = parseFloat(params.get('t'));
  if (Number.isFinite(st)) S.t = Math.min(track.endMs, track.startMs + st * 1000);
  if (params.get('cam')) setCam(params.get('cam'));
  if (params.get('speed')) setSpeed(+params.get('speed'));
  update(true);
  if (params.get('play') === '1') setPlaying(true);
}

/** Point to align the track with the DEM: first recorded fix (on the ground before takeoff), if near the start. */
function groundRefPoint(raw, pts) {
  const c = clean(raw.points);
  const g = c[0];
  if (g && distance(g.lat, g.lon, pts[0].lat, pts[0].lon) < 300) return g;
  return pts[0];
}

function computeZOff() {
  const g = S.groundRef;
  const e = map.queryTerrainElevation([g.lon, g.lat]);
  if (e == null) { S.zOff = 0; $('snapInfo').textContent = t('Relieful de la decolare nu s-a încărcat încă.'); return; }
  const d = e - g.alt + 1;
  S.zOffCandidate = Math.abs(d) <= 150 ? d : 0;
  S.zOff = S.snap ? S.zOffCandidate : 0;
  $('snapInfo').textContent = t('Altitudinea GPS la decolare față de relief: {d} m', { d: `${d >= 0 ? '+' : ''}${d.toFixed(0)}` }) + ' ' +
    t(S.snap ? '(aplicat doar traseului 3D; sus se vede altitudinea înregistrată).' : '(neaplicat).');
  rebuildStatic();
}

/** Smoothed "chase" bearing per point: direction of displacement over ±20 s (stable while circling). */
function chaseBearings(pts) {
  const n = pts.length;
  const out = new Float64Array(n);
  let lo = 0, hi = 0, last = null;
  for (let i = 0; i < n; i++) {
    while (lo < i && pts[i].t - pts[lo].t > 20000) lo++;
    while (hi < n - 1 && pts[hi + 1].t - pts[i].t <= 20000) hi++;
    const a = pts[lo], b = pts[hi];
    if (distance(a.lat, a.lon, b.lat, b.lon) > 40) last = geoBearing(a.lat, a.lon, b.lat, b.lon);
    out[i] = last ?? NaN;
  }
  const first = out.find((x) => !Number.isNaN(x)) ?? 0;
  for (let i = 0; i < n && Number.isNaN(out[i]); i++) out[i] = first;
  return out;
}

// ------------------------------------------------------------------ deck.gl layers
/** Porțiunea care contează acum: cea editată (previzualizare) sau cea aplicată; null = tot zborul. */
const activeRange = () => S.sel || S.range;

function rebuildStatic() {
  if (!S.pts) return;
  const z = S.zOff;
  const path = S.pts.map((p) => [p.lon, p.lat, p.alt + z]);
  const r = activeRange();
  const part = r && !isWhole(r, S.track.startMs, S.track.endMs) ? r : null;
  // cu o porțiune nu se desenează nimic din afara ei: nici traseul, nici umbra, nici termicele
  const [i0, i1] = part ? rangeIndices(S.track.times, part.a, part.b) : [0, S.pts.length - 1];
  const sl = (a) => (part ? a.slice(i0, i1 + 1) : a);
  const thermalCols = S.thermals.filter((th) => !part || (th.endMs >= part.a && th.startMs <= part.b)).map((th) => ({
    th, from: [th.lon, th.lat, th.baseAlt + z], to: [th.lon, th.lat, th.topAlt + z], color: varioColor(th.avgClimb),
    label: `+${th.avgClimb.toFixed(1)} m/s  ${Math.round(th.topAlt - th.baseAlt)} m`,
  }));
  const tp = sl(path), tts = sl(S.layersData.ts), tcol = sl(S.layersData.colors);
  S.static = {
    path, thermalCols, part, i0, i1,
    trip: [{ path: tp, ts: tts, colors: tcol }],
    // „fantoma” din față: același traseu în ordine inversă, cu timpul negat, ca TripsLayer să-l estompeze spre viitor;
    // culori mai deschise (amestecate cu alb)
    ghost: [{ path: tp.slice().reverse(), ts: tts.map((x) => -x).reverse(),
      colors: tcol.map((c) => c.map((v) => Math.round(v + (255 - v) * 0.45))).reverse() }],
  };
  S.shadowKey = null;
  update(true);
}

/** Metri pe pixel CSS în dreptul parapantei (după distanța camerei, merge și în vederea înclinată). */
function metersPerPxAt(lon, lat, alt) {
  try {
    const cp = map.getFreeCameraOptions().position, ll = cp.toLngLat();
    const d = Math.hypot(distance(ll.lat, ll.lng, lat, lon), cp.toAltitude() - alt);
    const fov = ((map.getVerticalFieldOfView?.() ?? 36.87) * Math.PI) / 180;
    const c2c = (0.5 / Math.tan(fov / 2)) * map.getContainer().clientHeight;
    if (Number.isFinite(d) && d > 0 && c2c > 0) return d / c2c;
  } catch { /* MapLibre fără cameră liberă */ }
  return metersPerPixel(map.getZoom(), lat);
}

/**
 * Umbra traseului pe relief (linie MapLibre, urmează terenul): aceeași parte ca traseul vizibil.
 * În modul urmă se actualizează pe măsură ce zboară parapanta (cel mult de ~6 ori pe secundă; la fiecare cadru în video).
 */
let lastShadow = 0;
function updateShadow(force = S.recording) {
  const st = S.static, src = map.getSource('shadow');
  if (!st || !src) return;
  let a = st.i0, b = st.i1, tail = null;
  if (!S.trackFull) {
    const tr = S.track;
    // umbra acoperă aceeași fereastră ca traseul vizibil: urma din spate + fantoma din față
    b = Math.min(st.i1, tr.indexAt(S.t + S.aheadMin * 60e3));
    a = Math.max(st.i0, tr.indexAt(S.t - S.trailMin * 60e3));
    if (S.t < tr.times[st.i0] && !S.aheadMin) b = a - 1;
    else if (!S.aheadMin) { const p = tr.positionAt(S.t); tail = [p.lon, p.lat]; }
  }
  const key = `${S.trackFull}:${a}:${b}`;
  const now = performance.now();
  if (key === S.shadowKey && !(tail && force)) return;
  if (!force && S.shadowKey != null && !S.trackFull && now - lastShadow < 160) return;
  S.shadowKey = key; lastShadow = now;
  const coords = [];
  for (let i = a; i <= b; i++) coords.push([S.pts[i].lon, S.pts[i].lat]);
  if (tail) coords.push(tail);
  src.setData(coords.length >= 2 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
    : { type: 'FeatureCollection', features: [] });
}

/**
 * deck.gl (în modul „interleaved”) își ține propriul obiect pentru framebuffer-ul implicit, cu mărimea de la pornire;
 * după ce se schimbă mărimea sau pixelRatio-ul hărții (fereastră redimensionată, înregistrare video), straturile
 * ies decalate pe verticală. Îl aliniem la canvasul hărții.
 */
function syncDeckFramebuffer() {
  try {
    const fb = overlay._deck?.device?.getDefaultCanvasContext?.()?._framebuffer, c = map.getCanvas();
    if (fb?.resize && (fb.width !== c.width || fb.height !== c.height)) fb.resize({ width: c.width, height: c.height });
  } catch { /* altă versiune deck.gl */ }
}
map.on('resize', syncDeckFramebuffer);

/** Eticheta încape întreagă în hartă (proiectată cu aceeași cameră ca deck.gl). */
function labelFits(p, text, k) {
  try {
    const el = map.getContainer(), W = el.clientWidth, H = el.clientHeight, c = map.getCenter();
    const vp = new deck.WebMercatorViewport({ width: W, height: H, longitude: c.lng, latitude: c.lat, zoom: map.getZoom(),
      pitch: map.getPitch(), bearing: map.getBearing(), position: [0, 0, map.getCenterElevation?.() || 0] });
    const [x, y] = vp.project(p);
    const half = (text.length * 7.2 * k) / 2 + 6 * k;
    return x > half && x < W - half && y > 28 * k && y < H - 6 * k;
  } catch { return true; }
}

function buildLayers(pos, ground, vario) {
  syncDeckFramebuffer();
  const st = S.static;
  const cur = (S.t - S.track.startMs) / 1000;
  // în video harta poate fi randată la alt pixelRatio decât ecranul: liniile și textele se scalează ca să arate la fel
  const k = S.uiScale || 1;
  const g = [pos.lon, pos.lat, pos.alt + S.zOff];
  const trips = (id, width, trailLength, fadeTrail) => new deck.TripsLayer({
    id, data: st.trip, getPath: (d) => d.path, getTimestamps: (d) => d.ts, getColor: (d) => d.colors,
    widthUnits: 'pixels', getWidth: width * k, jointRounded: true, capRounded: true, currentTime: cur, trailLength, fadeTrail,
  });
  // Ca în aplicație: „Urmă” (implicit) = doar ultimele N minute din spatele parapantei, tot mai subțire și mai
  // transparentă spre coadă, nimic în față; „Tot traseul” = trecutul colorat, viitorul abia vizibil.
  // Totul doar în porțiunea aleasă, dacă e una.
  const layers = S.trackFull ? [
    new deck.PathLayer({
      id: 'track-future', data: st.trip, getPath: (d) => d.path, getColor: [235, 240, 245],
      widthUnits: 'pixels', getWidth: 1.5 * k, opacity: 0.28, jointRounded: true, capRounded: true,
    }),
    trips('track-played', 4, 1e7, false),
  ] : [
    trips('trail', 2.5, S.trailMin * 60, true),
    trips('trail-head', 5, S.trailMin * 60 * 0.35, true),
    ...(S.aheadMin > 0 ? [new deck.TripsLayer({
      id: 'ghost', data: st.ghost, getPath: (d) => d.path, getTimestamps: (d) => d.ts, getColor: (d) => d.colors,
      widthUnits: 'pixels', getWidth: 2.5 * k, opacity: 0.75, jointRounded: true, capRounded: true,
      currentTime: -cur, trailLength: S.aheadMin * 60, fadeTrail: true,
    })] : []),
  ];
  updateShadow();
  if (S.showThermals && st.thermalCols.length) {
    layers.push(new deck.LineLayer({
      id: 'thermals', data: st.thermalCols, getSourcePosition: (d) => d.from, getTargetPosition: (d) => d.to,
      getColor: (d) => [...d.color, 200], widthUnits: 'pixels', getWidth: 10 * k, pickable: true,
    }));
    // în video: fără etichete tăiate de marginea cadrului
    const labels = S.recording ? st.thermalCols.filter((d) => labelFits(d.to, d.label, k)) : st.thermalCols;
    layers.push(new deck.TextLayer({
      id: 'thermal-labels', data: labels, getPosition: (d) => d.to, getText: (d) => d.label,
      getSize: 13 * k, getColor: [255, 255, 255, 235], background: true, getBackgroundColor: [13, 17, 23, 190],
      backgroundPadding: [4 * k, 2 * k], getPixelOffset: [0, -14 * k], fontFamily: 'system-ui, sans-serif', fontWeight: 600,
    }));
  }
  if (ground != null) {
    layers.push(new deck.LineLayer({
      id: 'stick', data: [0], getSourcePosition: () => g, getTargetPosition: () => [pos.lon, pos.lat, ground],
      getColor: [255, 255, 255, 140], widthUnits: 'pixels', getWidth: 1.5 * k,
      updateTriggers: { getSourcePosition: S.t, getTargetPosition: S.t },
    }));
  }
  // parapanta 3D (ca în aplicație): orientată după direcție, înclinată în viraj; mărime reală de aproape,
  // dar cel puțin ~34 px de anvergură de departe
  const [i, j, f] = S.track.frac(S.t);
  const heading = lerpAngle(S.hb.heading[i], S.hb.heading[j], f);
  const bank = S.hb.bank[i] + (S.hb.bank[j] - S.hb.bank[i]) * f;
  const sc = gliderScale(metersPerPxAt(pos.lon, pos.lat, g[2]), 34 * k);
  layers.push(new deck.SimpleMeshLayer({
    id: 'glider', data: [0], mesh: GLIDER_MESH, getPosition: () => g,
    getOrientation: () => [bank, -heading, 0], getScale: () => [sc, sc, sc], getColor: [255, 255, 255],
    material: { ambient: 0.6, diffuse: 0.55, shininess: 24, specularColor: [50, 50, 50] },
    updateTriggers: { getPosition: S.t, getOrientation: S.t, getScale: [S.t, sc] },
  }));
  return layers;
}

// ------------------------------------------------------------------ frame update
function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (d) => COMPASS[Math.round(normDeg(d) / 22.5) % 16];

function windAt(alt) {
  if (!S.wind.length) return null;
  return S.wind.reduce((a, b) => (Math.abs(b.altM - alt) < Math.abs(a.altM - alt) ? b : a));
}

function update(force = false) {
  if (!S.track || !S.static) return;
  const u0 = performance.now();
  const tr = S.track;
  const pos = tr.positionAt(S.t);
  const vario = tr.varioAt(S.t);
  const ground = map.queryTerrainElevation([pos.lon, pos.lat]);

  // camera
  if (S.cam !== 'free' && (S.playing || S.scrubbing || force === 'cam')) {
    const i = tr.indexAt(S.t);
    const target = S.chase[i];
    if (S.camBearing == null) S.camBearing = target;
    else S.camBearing = normDeg(S.camBearing + angleDiff(S.camBearing, target) * 0.06);
    const opts = { center: [pos.lon, pos.lat], elevation: pos.alt + S.zOff };
    if (S.cam === 'chase') opts.bearing = S.camBearing;
    map.jumpTo(opts);
  }

  overlay.setProps({ layers: buildLayers(pos, ground, vario) });

  // HUD (throttled to ~12 Hz)
  const now = performance.now();
  if (force || now - S.lastHud > 80) {
    S.lastHud = now;
    $('hAlt').textContent = `${Math.round(pos.alt)} m`;
    $('hAgl').textContent = ground != null ? `AGL ${Math.round(pos.alt + S.zOff - ground)} m` : 'AGL –';
    const hv = $('hVario');
    hv.textContent = `${vario >= 0.05 ? '▲' : vario <= -0.05 ? '▼' : ''}${Math.abs(vario).toFixed(1)}`;
    hv.className = 'val ' + (vario >= 0.05 ? 'up' : vario <= -0.05 ? 'down' : '');
    $('hSpd').textContent = `${Math.round(tr.groundSpeedAt(S.t) * 3.6)}`;
    $('hClock').textContent = new Date(S.t).toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    $('hElapsed').textContent = fmtDur((S.t - tr.startMs) / 1000);
    const w = windAt(pos.alt);
    $('hWind').innerHTML = w
      ? `<span class="arrow" style="transform:rotate(${(w.dirFromDeg + 180 - map.getBearing()).toFixed(0)}deg)">&#8593;</span> ${compass(w.dirFromDeg)} ${Math.round(w.speedMs * 3.6)}`
      : t('vânt –');
    $('playBtn').innerHTML = S.playing ? '&#10073;&#10073;' : '&#9654;';
    $('playBtn').setAttribute('aria-label', t(S.playing ? 'Pauză' : 'Pornește'));
  }
  drawProfileCursor();
  const du = performance.now() - u0;
  S.updMs = S.updMs ? S.updMs * 0.95 + du * 0.05 : du;
}

window.SR.update = update; // pentru depanare și testele din browser

let lastFrame = performance.now();
function loop(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (S.playing && S.track && !S.recording) {
    S.fps = S.fps ? S.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 60;
    const st = stepInRange(S.t + dt * 1000 * S.speed, activeRange(), S.loop, S.track.startMs, S.track.endMs);
    S.t = st.t;
    if (st.stop) setPlaying(false);
    update();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ------------------------------------------------------------------ controls
function setPlaying(p) {
  if (!S.track) return;
  const r = activeRange();
  if (p && r && (S.t < r.a || S.t >= r.b)) S.t = r.a;
  else if (p && S.t >= S.track.endMs) S.t = S.track.startMs;
  S.playing = p;
  if (p && S.cam !== 'free') enterFollowZoom();
  update(true);
}
function enterFollowZoom() {
  if (map.getZoom() < 15 || map.getPitch() < 40) {
    const pos = S.track.positionAt(S.t);
    S.camBearing = S.chase[S.track.indexAt(S.t)];
    map.jumpTo({ center: [pos.lon, pos.lat], elevation: pos.alt + S.zOff, zoom: 15.6, pitch: 68,
      bearing: S.cam === 'chase' ? S.camBearing : map.getBearing() });
  }
}
function setSpeed(v) {
  S.speed = SPEEDS.includes(v) ? v : 10;
  $('speedBtn').textContent = `${S.speed}×`;
}
function setCam(mode) {
  if (!['chase', 'follow', 'free'].includes(mode)) return;
  S.cam = mode;
  document.querySelectorAll('[data-cam]').forEach((b) => b.classList.toggle('on', b.dataset.cam === mode));
  if (mode !== 'free' && S.track) { S.camBearing = null; enterFollowZoom(); update('cam'); }
}

$('playBtn').onclick = () => setPlaying(!S.playing);
$('speedBtn').onclick = () => setSpeed(SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length]);
document.querySelectorAll('[data-cam]').forEach((b) => { b.onclick = () => setCam(b.dataset.cam); });
map.on('dragstart', (e) => { if (e.originalEvent && S.cam !== 'free') setCam('free'); });
map.on('rotate', () => { if (S.track && !S.playing) S.lastHud = 0; });

// Touchpad (MacBook) ca în Google Earth: două degete = mută harta, ciupire = zoom, Shift + două degete = rotește, ⌥ + două degete = înclină.
// Rotița unui mouse clasic rămâne zoom. Browserele trimit ciupirea de pe touchpad ca „wheel” cu ctrlKey.
map.scrollZoom.disable();
const canvas = map.getCanvasContainer();
const isMouseWheel = (e) => e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 100 && Number.isInteger(e.deltaY));
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const around = map.unproject([e.offsetX, e.offsetY]);
  if (e.ctrlKey || isMouseWheel(e)) {
    const dz = -e.deltaY * (e.ctrlKey ? 0.01 : 0.0025);
    if (S.cam !== 'free' && !e.ctrlKey && !isMouseWheel(e)) setCam('free');
    map.zoomTo(map.getZoom() + dz, { around, duration: 0 });
    return;
  }
  if (S.cam !== 'free') setCam('free');
  if (e.shiftKey) {
    // Shift + două degete: rotește (Chrome transformă Shift + scroll vertical în orizontal, deci orice direcție)
    map.jumpTo({ bearing: map.getBearing() + (e.deltaX + e.deltaY) * 0.3 });
    return;
  }
  if (e.altKey) {
    // Option (⌥) + două degete sus/jos: înclină
    map.jumpTo({ pitch: Math.max(0, Math.min(85, map.getPitch() - (e.deltaY || e.deltaX) * 0.2)) });
    return;
  }
  map.panBy([e.deltaX, e.deltaY], { duration: 0 });
}, { passive: false });
// Safari pe Mac: rotirea cu două degete pe touchpad
let gestureBearing = null;
canvas.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureBearing = map.getBearing(); });
canvas.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (gestureBearing === null) return;
  if (S.cam !== 'free') setCam('free');
  map.jumpTo({ bearing: gestureBearing - e.rotation });
});
canvas.addEventListener('gestureend', (e) => { e.preventDefault(); gestureBearing = null; });

// ⓘ jos, în bara de redare: un rând cu gesturile chiar la marginea de jos a ecranului; panoul urcă exact cu înălțimea lui.
// La prima vizită rândul e pornit (înlocuiește vechiul indiciu); apoi se ține minte. „Mai mult…” deschide ajutorul complet.
// Rândul și ajutorul se potrivesc dispozitivului: telefon / tabletă, Mac sau Windows / Linux.
const DEVICE = currentDevice();
$('infoTxt').textContent = {
  touch: t('Un deget: mută · Două degete: zoom și rotește · Două degete sus/jos: înclină'),
  mac: t('Două degete: mută · Ciupire: zoom · Shift: rotește · ⌥: înclină'),
  pc: t('Trage: mută · Rotiță: zoom · Ctrl + trage (sau click dreapta + trage): rotește și înclină · Touchpad: două degete mută, ciupire zoom'),
}[DEVICE];
document.documentElement.dataset.device = DEVICE;
// în ajutor: întâi secțiunea dispozitivului de acum, deschisă; celelalte după, închise
{
  const box = $('gestures'), mine = box.querySelector(`[data-dev="${DEVICE}"]`);
  if (mine) { box.prepend(mine); mine.open = true; }
}
// --info-h = înălțimea barei de jos (surse + gesturi), urmărită și când se desfășoară sursele
const syncBottom = () => {
  document.documentElement.style.setProperty('--info-h', `${$('bottomBar').offsetHeight}px`);
  if (S.track) setPanelH();
};
new ResizeObserver(syncBottom).observe($('bottomBar'));
function setInfo(on) {
  $('infoTxt').hidden = !on; $('infoMore').hidden = !on;
  $('bottomBar').classList.toggle('compact', !on);
  $('optInfo').checked = on;
  syncBottom();
  try { localStorage.setItem('vld.replayInfo', on ? '1' : '0'); } catch { /* fără stocare */ }
  if (S.track) setPanelH();
}
let infoOn = true;
try { infoOn = localStorage.getItem('vld.replayInfo') !== '0'; } catch { /* fără stocare */ }
setInfo(infoOn);
$('optInfo').onchange = (e) => setInfo(e.target.checked);
$('infoMore').onclick = () => $('help').showModal();
$('helpFab').onclick = () => $('help').showModal();

window.addEventListener('keydown', (e) => {
  if (!S.track || S.recording || e.target.closest?.('input,select,textarea,button,a,[role="slider"],dialog')) return;
  const r = S.range || { a: S.track.startMs, b: S.track.endMs };
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!S.playing); }
  if (e.code === 'ArrowRight') { S.t = Math.min(r.b, S.t + 10000 * Math.max(1, S.speed / 5)); update(true); }
  if (e.code === 'ArrowLeft') { S.t = Math.max(r.a, S.t - 10000 * Math.max(1, S.speed / 5)); update(true); }
});

// fișier ales / tras pe pagină
$('file').onchange = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
const openPicker = () => { $('sheet').close(); $('file').click(); };
$('openBtn').onclick = openPicker;
$('openBtn2').onclick = openPicker;
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropHint').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('dropHint').hidden = true;
  const f = e.dataTransfer.files[0];
  if (f) openFile(f);
});

// ------------------------------------------------------------------ profile + scrubber
const prof = { base: null, w: 0, h: 0, dpr: 1, pad: 4, altMin: 0, altMax: 1 };
function resizeProfile() {
  const c = $('profile');
  const r = c.getBoundingClientRect();
  prof.dpr = window.devicePixelRatio || 1;
  prof.w = Math.max(1, Math.round(r.width * prof.dpr)); prof.h = Math.max(1, Math.round(r.height * prof.dpr));
  c.width = prof.w; c.height = prof.h;
  drawProfileBase();
  drawProfileCursor();
}
const xOf = (t) => ((t - S.track.startMs) / (S.track.endMs - S.track.startMs)) * prof.w;
const yOf = (a) => prof.h - prof.pad * prof.dpr - ((a - prof.altMin) / (prof.altMax - prof.altMin)) * (prof.h - 2 * prof.pad * prof.dpr - 14 * prof.dpr);

function drawProfileBase() {
  if (!S.track) return;
  const off = document.createElement('canvas');
  off.width = prof.w; off.height = prof.h;
  const g = off.getContext('2d');
  const pts = S.pts, tr = S.track;
  let mn = Infinity, mx = -Infinity;
  for (const p of pts) { mn = Math.min(mn, p.alt); mx = Math.max(mx, p.alt); }
  prof.altMin = mn - 10; prof.altMax = mx + 10;
  // thermal bands
  for (const th of S.thermals) {
    g.fillStyle = 'rgba(63,208,122,0.24)';
    g.fillRect(xOf(th.startMs), 0, Math.max(2, xOf(th.endMs) - xOf(th.startMs)), prof.h);
  }
  // area
  const step = Math.max(1, Math.floor(pts.length / prof.w));
  g.beginPath(); g.moveTo(0, prof.h);
  for (let i = 0; i < pts.length; i += step) g.lineTo(xOf(pts[i].t), yOf(pts[i].alt));
  g.lineTo(prof.w, prof.h); g.closePath();
  g.fillStyle = 'rgba(76,194,255,0.10)'; g.fill();
  // vario-coloured line
  g.lineWidth = 2 * prof.dpr;
  for (let i = step; i < pts.length; i += step) {
    g.strokeStyle = rgb(varioColor(tr.vario[i]));
    g.beginPath(); g.moveTo(xOf(pts[i - step].t), yOf(pts[i - step].alt)); g.lineTo(xOf(pts[i].t), yOf(pts[i].alt)); g.stroke();
  }
  g.fillStyle = '#8b949e'; g.font = `${11 * prof.dpr}px system-ui`; g.textBaseline = 'top';
  g.fillText(`${Math.round(mx)} m`, 4 * prof.dpr, 1 * prof.dpr);
  g.textAlign = 'right';
  g.fillText(`${fmtDur((tr.endMs - tr.startMs) / 1000)} · ${t('{n} termice', { n: S.thermals.length })}`, prof.w - 4 * prof.dpr, 1 * prof.dpr);
  prof.base = off;
}

function drawProfileCursor() {
  if (!S.track || !prof.base) return;
  const g = $('profile').getContext('2d');
  g.clearRect(0, 0, prof.w, prof.h);
  g.drawImage(prof.base, 0, 0);
  const r = activeRange();
  if (r) {
    g.fillStyle = 'rgba(8,12,16,0.62)';
    g.fillRect(0, 0, xOf(r.a), prof.h);
    g.fillRect(xOf(r.b), 0, prof.w - xOf(r.b), prof.h);
    if (!S.sel) { g.fillStyle = 'rgba(255,138,61,0.9)'; g.fillRect(xOf(r.a), prof.h - 3 * prof.dpr, xOf(r.b) - xOf(r.a), 3 * prof.dpr); }
  }
  const x = xOf(S.t);
  g.fillStyle = 'rgba(13,17,23,0.35)';
  g.fillRect(x, 0, prof.w - x, prof.h);
  g.strokeStyle = '#fff'; g.lineWidth = 2 * prof.dpr;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, prof.h); g.stroke();
  const a = S.track.positionAt(S.t).alt;
  g.fillStyle = '#fff'; g.beginPath(); g.arc(x, yOf(a), 4 * prof.dpr, 0, Math.PI * 2); g.fill();
}

const profEl = $('profile');
function scrubTo(e) {
  const r = profEl.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  S.t = S.track.startMs + f * (S.track.endMs - S.track.startMs);
  if (S.range && !S.sel) S.t = Math.min(S.range.b, Math.max(S.range.a, S.t));
  update(true);
}
profEl.addEventListener('pointerdown', (e) => { if (!S.track) return; S.scrubbing = true; profEl.setPointerCapture(e.pointerId); scrubTo(e); });
profEl.addEventListener('pointermove', (e) => { if (S.scrubbing) scrubTo(e); });
const endScrub = () => { S.scrubbing = false; };
profEl.addEventListener('pointerup', endScrub);
profEl.addEventListener('pointercancel', endScrub);
window.addEventListener('resize', () => { if (S.track && !S.recording) { resizeProfile(); placeHandles(); document.documentElement.style.setProperty('--panel-h', `${$('panel').offsetHeight}px`); } });

// ------------------------------------------------------------------ porțiunea (selectare, buclă, încadrare)
const clock = (ms, sec = false) => new Date(ms).toLocaleTimeString(LOC, { hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}), hour12: false });
const rangeText = (r) => `${clock(r.a, true)} – ${clock(r.b, true)} · ${fmtDur((r.b - r.a) / 1000)}`;
const setPanelH = () => document.documentElement.style.setProperty('--panel-h', `${$('panel').offsetHeight}px`);

function renderRangeBar() {
  const r = S.range, editing = !!S.sel;
  $('rangeBar').hidden = editing;
  $('selBtn').hidden = !!r;
  $('rangeChip').hidden = !r; $('fitBtn').hidden = !r; $('loopBtn').hidden = !r;
  if (r) {
    $('rangeEdit').textContent = `${clock(r.a)}–${clock(r.b)}`;
    $('loopBtn').textContent = t(S.loop ? 'În buclă' : 'Oprire la final');
    $('loopBtn').setAttribute('aria-pressed', String(S.loop));
  }
  $('recBtn').querySelector('.dot').nextSibling.nodeValue = t(r ? 'Înregistrează porțiunea' : 'Înregistrează video');
  setPanelH();
}

/** Mânerele stau peste profil, în dreptul capetelor porțiunii editate. */
function placeHandles() {
  const on = !!S.sel && !!S.track;
  for (const [id, k] of [['hA', 'a'], ['hB', 'b']]) {
    const h = $(id);
    h.hidden = !on;
    if (!on) continue;
    const ms = S.sel[k], span = S.track.endMs - S.track.startMs;
    h.style.left = `${((ms - S.track.startMs) / span) * 100}%`;
    h.querySelector('.tag').textContent = clock(ms, true);
    h.setAttribute('aria-valuemin', '0'); h.setAttribute('aria-valuemax', String(Math.round(span / 1000)));
    h.setAttribute('aria-valuenow', String(Math.round((ms - S.track.startMs) / 1000)));
    h.setAttribute('aria-valuetext', clock(ms, true));
  }
  if (on) {
    $('selLabel').textContent = rangeText(S.sel);
    $('picks').querySelectorAll('button[data-pick]').forEach((b) => b.setAttribute('aria-pressed', String(sameRange(S.picks[+b.dataset.pick].range || full(), S.sel))));
  }
}
const full = () => ({ a: S.track.startMs, b: S.track.endMs });

function pickLabel(p) {
  if (p.key === 'whole') return t('Tot zborul');
  if (p.key === 'toFirst') return t('Decolare → prima termică');
  if (p.key === 'last') return t('Ultimele {n} min', { n: p.min });
  return t('Termica {n} · {time} +{climb}', { n: p.n, time: tmFmt(p.th.startMs), climb: p.th.avgClimb.toFixed(1) });
}

function openSelect() {
  if (!S.track) return;
  S.sel = S.range ? { ...S.range } : full();
  S.picks = quickPicks(S.thermals, S.track.startMs, S.track.endMs, S.t);
  $('picks').innerHTML = S.picks.map((p, i) => `<button type="button" data-pick="${i}" aria-pressed="false">${escapeHtml(pickLabel(p))}</button>`).join('') +
    `<button type="button" id="pickCustom">${t('De la – până la…')}</button>`;
  $('picks').querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => { const p = S.picks[+b.dataset.pick]; setSel(p.range || full(), true); }; });
  $('pickCustom').onclick = () => {
    const f = $('customForm');
    f.hidden = !f.hidden;
    if (!f.hidden) { $('cFrom').value = clock(S.sel.a); $('cTo').value = clock(S.sel.b); $('cErr').textContent = ''; $('cFrom').focus(); }
    setPanelH();
  };
  $('customForm').hidden = true;
  $('selPanel').hidden = false;
  renderRangeBar(); placeHandles(); rebuildStatic(); drawProfileCursor();
  $('hA').focus({ preventScroll: true });
}
function setSel(r, seek) {
  S.sel = r;
  if (seek || S.t < r.a || S.t > r.b) S.t = r.a;
  placeHandles(); rebuildStatic();
}
/** Închide editarea; apply = păstrează porțiunea (tot zborul = fără porțiune). */
function closeSelect(apply) {
  if (apply && S.sel) {
    S.range = isWhole(S.sel, S.track.startMs, S.track.endMs) ? null : S.sel;
    if (S.id) saveRange(localStorage, S.id, S.range);
    if (S.range && (S.t < S.range.a || S.t > S.range.b)) S.t = S.range.a;
  }
  S.sel = null;
  $('selPanel').hidden = true;
  placeHandles();
  if (S.track) { renderRangeBar(); rebuildStatic(); drawProfileCursor(); }
}
function clearRange() {
  S.range = null; if (S.id) saveRange(localStorage, S.id, null);
  renderRangeBar(); rebuildStatic(); drawProfileCursor();
}
function fitRange() {
  const r = activeRange() || full();
  const [i0, i1] = rangeIndices(S.track.times, r.a, r.b);
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (let i = i0; i <= i1; i++) { const p = S.pts[i]; minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); }
  setPlaying(false); setCam('free');
  const top = ($('hud').getBoundingClientRect().bottom || 120) + 20;
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
    padding: { top, bottom: $('panel').offsetHeight + 30, left: 40, right: 60 }, pitch: Math.max(45, map.getPitch()), bearing: map.getBearing(), duration: 700, maxZoom: 16,
  });
}

$('selBtn').onclick = openSelect;
$('rangeEdit').onclick = openSelect;
$('rangeClear').onclick = clearRange;
$('fitBtn').onclick = fitRange;
$('loopBtn').onclick = () => { S.loop = !S.loop; try { localStorage.setItem('vld.replayLoop', S.loop ? '1' : '0'); } catch { /* fără stocare */ } renderRangeBar(); };
$('selCancel').onclick = () => closeSelect(false);
$('selApply').onclick = () => closeSelect(true);
$('customForm').onsubmit = (e) => {
  e.preventDefault();
  const a = parseClock($('cFrom').value, S.track.startMs), b = parseClock($('cTo').value, S.track.startMs);
  let err = '';
  if (a == null || b == null) err = t('Folosește HH:MM sau HH:MM:SS');
  else if (b - a < MIN_RANGE_MS) err = t('„Până la” trebuie să fie la cel puțin 20 s după „De la”');
  else if (b < S.track.startMs || a > S.track.endMs) err = t('Zborul ține de la {a} până la {b}', { a: clock(S.track.startMs), b: clock(S.track.endMs) });
  $('cErr').textContent = err;
  if (!err) { setSel(clampRange(a, b, S.track.startMs, S.track.endMs), true); $('customForm').hidden = true; setPanelH(); }
};
// mânerele: mouse, atingere, creion (pointer events) și tastatură
for (const [id, k] of [['hA', 'a'], ['hB', 'b']]) {
  const h = $(id);
  const moveTo = (ms) => { setSel(moveHandle(S.sel, k, ms, S.track.startMs, S.track.endMs)); S.t = S.sel[k]; update(true); };
  h.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); h.setPointerCapture(e.pointerId); h.dataset.drag = '1'; h.focus({ preventScroll: true }); });
  h.addEventListener('pointermove', (e) => {
    if (!h.dataset.drag) return;
    const r = profEl.getBoundingClientRect();
    moveTo(S.track.startMs + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (S.track.endMs - S.track.startMs));
  });
  const end = () => { delete h.dataset.drag; };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  h.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -10e3, ArrowRight: 10e3, ArrowDown: -10e3, ArrowUp: 10e3, PageDown: -300e3, PageUp: 300e3 }[e.key];
    if (step) { e.preventDefault(); moveTo(S.sel[k] + step * (e.shiftKey && Math.abs(step) < 60e3 ? 6 : 1)); }
    else if (e.key === 'Home') { e.preventDefault(); moveTo(S.track.startMs); }
    else if (e.key === 'End') { e.preventDefault(); moveTo(S.track.endMs); }
    else if (e.key === 'Enter') { e.preventDefault(); closeSelect(true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSelect(false); }
  });
}

// ------------------------------------------------------------------ ajutor
$('helpClose').onclick = () => $('help').close();
for (const d of ['help', 'recSheet']) $(d).addEventListener('click', (e) => { if (e.target === $(d)) $(d).close(); });

// ------------------------------------------------------------------ înregistrarea video
const SHOW_DEF = { title: true, hud: true, profile: true, watermark: true };
const REC = { fmt: '9:16', what: 'part', len: '30', cam: 'cine', show: { ...SHOW_DEF }, abort: null, url: null };
try { Object.assign(REC, JSON.parse(localStorage.getItem('vld.replayRec')) || {}); } catch { /* fără stocare */ }
REC.abort = null; REC.url = null; REC.show = { ...SHOW_DEF, ...(REC.show || {}) };
const recRange = () => (REC.what === 'part' && S.range ? S.range : full());
function recDuration() {
  const r = recRange();
  return REC.len.startsWith('x') ? Math.min(600, durationForSpeed(r.b - r.a, +REC.len.slice(1))) : +REC.len;
}
function renderRecSheet() {
  const sup = recorderSupport(), r = recRange();
  $('recWhatBox').hidden = !S.range;
  for (const [box, attr, val] of [['recWhat', 'what', REC.what], ['recFmt', 'fmt', REC.fmt], ['recCam', 'rcam', REC.cam]])
    $(box).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset[attr] === val));
  const span = (r.b - r.a) / 1000;
  $('recLen').innerHTML = DURATIONS.map((d) => `<option value="${d}">${d} s</option>`).join('') +
    SPEEDUPS.map((k) => `<option value="x${k}">${t('Timp real ×{k} (~{d})', { k, d: fmtDur(durationForSpeed(span * 1000, k)) })}</option>`).join('');
  $('recLen').value = REC.len;
  if ($('recLen').value !== REC.len) { REC.len = '30'; $('recLen').value = '30'; }
  const dur = recDuration(), plan = renderPlan(REC.fmt);
  $('recSpan').textContent = t('{span} de zbor ({a}–{b}) → video de {d} s', { span: fmtDur(span), a: clock(r.a), b: clock(r.b), d: dur }) +
    (span / dur > 1.5 ? ' ' + t('(time-lapse până la ×{k})', { k: Math.round(span / Math.max(1, dur - 5)) }) : '');
  $('recCamHint').textContent = t(REC.cam === 'cine'
    ? 'Orbită la decolare, din spate pe planări, orbită lentă în termice, la final vederea de ansamblu.'
    : 'Camera de acum (Din spate, Urmărește sau Liber), cu același unghi și zoom.');
  $('recInfo').textContent = sup.ok
    ? t('Fișier: {f} · {w}×{h} · 30 fps. Se randează aici, în browser, cadru cu cadru: durează cam cât clipul sau mai mult.', { f: sup.label, w: plan.w, h: plan.h })
    : t('Browserul acesta nu poate înregistra video (lipsește MediaRecorder). Încearcă un Chrome, Edge sau Safari recent.');
  $('recGo').disabled = !sup.ok;
  for (const k of Object.keys(SHOW_DEF)) $('show_' + k).checked = !!REC.show[k];
}
const saveRec = () => { try { localStorage.setItem('vld.replayRec', JSON.stringify({ fmt: REC.fmt, what: REC.what, len: REC.len, cam: REC.cam, show: REC.show })); } catch { /* fără stocare */ } };
$('recBtn').onclick = () => { setPlaying(false); REC.what = S.range ? 'part' : 'all'; renderRecSheet(); $('recSheet').showModal(); };
$('recClose').onclick = $('recCancel').onclick = () => $('recSheet').close();
$('recWhat').onclick = (e) => { const b = e.target.closest('[data-what]'); if (b) { REC.what = b.dataset.what; renderRecSheet(); } };
$('recFmt').onclick = (e) => { const b = e.target.closest('[data-fmt]'); if (b) { REC.fmt = b.dataset.fmt; saveRec(); renderRecSheet(); } };
$('recCam').onclick = (e) => { const b = e.target.closest('[data-rcam]'); if (b) { REC.cam = b.dataset.rcam; saveRec(); renderRecSheet(); } };
$('recLen').onchange = (e) => { REC.len = e.target.value; saveRec(); renderRecSheet(); };
for (const k of Object.keys(SHOW_DEF)) $('show_' + k).onchange = (e) => { REC.show[k] = e.target.checked; saveRec(); };

/** Numele locului: din ziua din jurnal legată de traseu, altfel din traseu. */
function siteName() {
  try { const f = (JSON.parse(localStorage.getItem('vld.flights')) || []).find((x) => x.sr?.includes(S.id)); if (f?.site) return f.site; } catch { /* fără stocare */ }
  return S.meta?.site || '';
}

$('recGo').onclick = async () => {
  $('recSheet').close();
  const r = recRange(), site = siteName();
  const ac = new AbortController();
  REC.abort = ac;
  if (REC.url) { URL.revokeObjectURL(REC.url); REC.url = null; }
  $('recPrev').innerHTML = ''; $('recRun').hidden = false; $('recDone').hidden = true;
  $('recBar').style.width = '0%'; $('recTxt').textContent = t('Se pregătește…');
  $('recProg').hidden = false;
  const was = { t: S.t, cam: S.cam };
  S.recording = true; setPlaying(false);
  let maxAlt = -Infinity;
  for (let k = 0; k <= 200; k++) maxAlt = Math.max(maxAlt, S.track.positionAt(r.a + ((r.b - r.a) * k) / 200).alt);
  const env = {
    map, deck: overlay, track: S.track, pts: S.pts, setScale: (k) => { S.uiScale = k; }, thermals: S.thermals, zOff: S.zOff, chase: S.chase, varioColor,
    setTime(ms) {
      S.t = ms;
      const pos = S.track.positionAt(ms);
      overlay.setProps({ layers: buildLayers(pos, map.queryTerrainElevation([pos.lon, pos.lat]), S.track.varioAt(ms)) });
    },
    hud(ms, speed) {
      const pos = S.track.positionAt(ms), v = S.track.varioAt(ms);
      return {
        alt: `${Math.round(pos.alt)}`, vario: `${v >= 0.05 ? '+' : v <= -0.05 ? '−' : ''}${Math.abs(v).toFixed(1)}`, varioMs: v,
        speed: `${Math.round(S.track.groundSpeedAt(ms) * 3.6)}`, flightTime: fmtDur((ms - S.track.startMs) / 1000),
        clock: clock(ms, true), timeLapse: speed,
      };
    },
    currentCam: () => ({ mode: was.cam, center: map.getCenter().toArray(), elevation: map.getCenterElevation?.(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }),
    overlay: {
      show: { ...REC.show },
      title: site || t('Zborul meu'),
      subtitle: `${dayFmt(r.a)} · ${clock(r.a)}–${clock(r.b)}`,
      stats: t('{d} de zbor · max {m} m', { d: fmtDur((r.b - r.a) / 1000), m: Math.round(maxAlt) }),
      attribution: IMG.which === 'ion' && map.getLayer('ion')
        ? t('Imagini: {a} · Relief: Mapzen / AWS Terrain Tiles (SRTM: USGS; EU-DEM: Copernicus)', { a: IMG.attribution })
        : t('Imagini: Sentinel-2 cloudless 2024 de EOX IT Services GmbH (conține date Copernicus Sentinel modificate 2024), CC BY-NC-SA 4.0 · Relief: Mapzen / AWS Terrain Tiles (SRTM: USGS; EU-DEM: Copernicus)'),
      labels: {
        alt: t('ALT'), vario: 'VARIO', speed: t('VITEZĂ'), time: t('TIMP'), altitude: t('ALTITUDINE'),
        max: `MAX ${Math.round(maxAlt)} m`, subtitle: t('Reluare 3D a zborului'),
      },
    },
  };
  let res = null, err = null;
  try {
    res = await recordVideo(env, { fmt: REC.fmt, range: r, durationS: recDuration(), camera: REC.cam }, {
      signal: ac.signal,
      preview: (c) => { $('recPrev').append(c); },
      progress: (i, n, eta) => {
        (window.SR.recLog ||= []).push([i, Math.round(performance.now())]);
        $('recBar').style.width = `${(100 * i) / n}%`;
        $('recTxt').textContent = t('Cadrul {i} din {n}', { i, n }) + (i > 5 ? ' · ' + t('mai durează cam {d}', { d: fmtDur(eta) }) : '');
      },
    });
  } catch (e) { console.error(e); err = e; }
  S.recording = false; REC.abort = null;
  S.t = was.t;
  resizeProfile(); update(true);
  if (!res) {
    if (err) { $('recTxt').textContent = t('Înregistrarea a eșuat: {e}', { e: err.message || String(err) }); $('recStop').textContent = t('Închide'); return; }
    $('recProg').hidden = true; return;
  }
  const name = videoFileName(r.a, site, res.ext);
  REC.url = URL.createObjectURL(res.blob);
  REC.file = new File([res.blob], name, { type: res.blob.type });
  const v = document.createElement('video');
  v.src = REC.url; v.controls = true; v.playsInline = true; v.muted = true; v.loop = true;
  $('recPrev').innerHTML = ''; $('recPrev').append(v);
  $('recDl').href = REC.url; $('recDl').download = name;
  $('recResult').textContent = `${name} · ${Math.round(res.durationS)} s · ${res.w}×${res.h} · 30 fps · ${(res.blob.size / 1e6).toFixed(1)} MB · ${res.label} · ` +
    t('înregistrat în {d}', { d: fmtDur(res.elapsedMs / 1000) }) + (res.scaled ? ' · ' + t('rezoluție redusă (limita plăcii video)') : '');
  $('recShare').hidden = !(navigator.canShare && navigator.canShare({ files: [REC.file] }));
  $('recRun').hidden = true; $('recDone').hidden = false;
  window.SR.lastVideo = { name, size: res.blob.size, mime: res.mime, elapsedMs: res.elapsedMs, slowFrames: res.slowFrames, frames: res.frames };
};
$('recStop').onclick = () => { if (REC.abort) REC.abort.abort(); else { $('recProg').hidden = true; $('recStop').textContent = t('Renunță'); } };
$('recNew').onclick = () => { $('recProg').hidden = true; $('recPrev').innerHTML = ''; };
$('recShare').onclick = async () => {
  try { await navigator.share({ files: [REC.file], title: REC.file.name }); } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
};

// ------------------------------------------------------------------ detaliile zborului
function buildSheet() {
  const tr = S.track, pts = S.pts;
  let dist = 0, mn = Infinity, mx = -Infinity, vmax = -Infinity, vmin = Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i) dist += distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    mn = Math.min(mn, pts[i].alt); mx = Math.max(mx, pts[i].alt);
    vmax = Math.max(vmax, tr.vario[i]); vmin = Math.min(vmin, tr.vario[i]);
  }
  const items = [
    [t('Timp în aer'), fmtDur((tr.endMs - tr.startMs) / 1000)], [t('Traseu'), `${(dist / 1000).toFixed(1)} km`],
    [t('Altitudine maximă'), `${Math.round(mx)} m`], [t('Altitudine minimă'), `${Math.round(mn)} m`],
    [t('Cea mai bună urcare'), `+${vmax.toFixed(1)} m/s`], [t('Coborâre maximă'), `${vmin.toFixed(1)} m/s`],
    [t('Termice'), `${S.thermals.length}`], [t('Puncte'), `${pts.length} / ${S.timings.rawPoints}`],
  ];
  $('stats').innerHTML = `<div style="grid-column:1/-1"><span>${t('Fișier')}</span><b style="font-size:14px">${escapeHtml(S.flight.sourceName || S.meta?.name || '')}${S.flight.sport ? ' · ' + escapeHtml(S.flight.sport) : ''}</b></div>` +
    items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  $('thermalList').innerHTML = S.thermals.length ? S.thermals.map((th, i) => `<li>
      <span>${tmFmt(th.startMs)} · +${th.avgClimb.toFixed(1)} m/s · ${Math.round(th.topAlt - th.baseAlt)} m · ${fmtDur((th.endMs - th.startMs) / 1000)}</span>
      <button class="btn" data-th="${i}">${t('Mergi')}</button></li>`).join('') : `<li>${t('Nicio termică găsită')}</li>`;
  $('thermalList').querySelectorAll('[data-th]').forEach((b) => {
    b.onclick = () => { S.t = S.thermals[+b.dataset.th].startMs; $('sheet').close(); if (S.cam === 'free') setCam('chase'); update('cam'); };
  });
  $('windList').innerHTML = S.wind.length ? S.wind.map((w) => `<li><span>${Math.round(w.altM)} m</span>
      <span>${t('din {d}', { d: compass(w.dirFromDeg) })} (${Math.round(w.dirFromDeg)}°) · ${Math.round(w.speedMs * 3.6)} km/h · ${t('{n} spirale', { n: w.n })}</span></li>`).join('')
    : `<li>${t('Prea puține spirale ca să estimez vântul')}</li>`;
}

$('menuBtn').onclick = async () => {
  $('sheetTracks').innerHTML = trackItems(await listTracks().catch(() => []));
  delete $('delBtn').dataset.armed; $('delBtn').textContent = t('Șterge traseul din acest browser');
  $('sheet').showModal();
};
$('sheetClose').onclick = () => $('sheet').close();
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').close(); if (e.target.closest('a[href^="#flight="]')) $('sheet').close(); });
$('optThermals').onchange = (e) => { S.showThermals = e.target.checked; update(true); };
$('optSnap').onchange = (e) => { S.snap = e.target.checked; computeZOff(); };
const saveTrackPrefs = () => { try { localStorage.setItem('vld.replayTrack', JSON.stringify({ full: S.trackFull, min: S.trailMin, ahead: S.aheadMin })); } catch { /* fără stocare */ } };
function renderTrackPrefs() {
  $('optFull').checked = S.trackFull;
  $('trailBox').hidden = S.trackFull;
  $('optTrail').value = String(S.trailMin);
  $('trailVal').textContent = t('{n} min', { n: S.trailMin });
  $('optAhead').value = String(S.aheadMin);
  $('aheadVal').textContent = S.aheadMin ? t('{n} min', { n: S.aheadMin }) : t('oprit');
}
$('optFull').onchange = (e) => { S.trackFull = e.target.checked; saveTrackPrefs(); renderTrackPrefs(); S.shadowKey = null; update(true); };
$('optTrail').oninput = (e) => { S.trailMin = +e.target.value; saveTrackPrefs(); renderTrackPrefs(); S.shadowKey = null; update(true); };
$('optAhead').oninput = (e) => { S.aheadMin = +e.target.value; saveTrackPrefs(); renderTrackPrefs(); S.shadowKey = null; update(true); };
renderTrackPrefs();

// ------------------------------------------------------------------ imagini: Sentinel-2 (EOX) sau Bing prin Cesium ion
// Tokenul: doar în memorie, sau în localStorage-ul acestui browser dacă e bifat „Ține minte”; pleacă doar spre api.cesium.com.
const IMG = { which: 'eox', token: '', attribution: null, failed: false };
try {
  IMG.which = localStorage.getItem('vld.imagery') === 'ion' ? 'ion' : 'eox';
  IMG.token = cleanIonToken(localStorage.getItem('vld.ionToken'));
} catch { /* fără stocare */ }
if (IMG.token) { $('ionToken').value = IMG.token; $('ionRemember').checked = true; }

function notice(msg) {
  document.querySelector('.notice')?.remove();
  const n = document.createElement('div');
  n.className = 'notice'; n.setAttribute('role', 'status'); n.textContent = msg; n.onclick = () => n.remove();
  document.body.append(n);
  setTimeout(() => n.remove(), 9000);
}
function ionMsg(text, kind = '') { const m = $('ionMsg'); m.textContent = text; m.className = 'hint ' + kind; }
/** Arată imaginile alese; „ion” doar dacă sursa e deja pregătită. */
function showImagery(which) {
  const ion = which === 'ion' && !!map.getLayer('ion');
  if (map.getLayer('eox')) map.setLayoutProperty('eox', 'visibility', ion ? 'none' : 'visible');
  if (map.getLayer('ion')) map.setLayoutProperty('ion', 'visibility', ion ? 'visible' : 'none');
  document.querySelectorAll('[data-img]').forEach((b) => b.classList.toggle('on', b.dataset.img === which));
  $('ionBox').hidden = which !== 'ion';
}
const saveImagery = () => { try { localStorage.setItem('vld.imagery', IMG.which); } catch { /* fără stocare */ } };
const ION_ERR = {
  empty: 'Lipește întâi tokenul tău Cesium ion.',
  auth: 'Tokenul nu e valid sau a expirat (Cesium ion a răspuns {s}).',
  asset: 'Contul tău Cesium ion nu are „Bing Maps Aerial” (asset 2); adaug-o din Asset Depot.',
  network: 'Nu pot contacta Cesium ion (fără internet sau adresă blocată).',
  type: 'Cesium ion a dat un răspuns neașteptat.',
  http: 'Cesium ion a răspuns cu eroarea {s}.',
  bing: 'Bing nu a dat informațiile despre imagini ({s}).',
  'bing-meta': 'Bing nu a dat informațiile despre imagini.',
};
async function useIon(raw, quiet = false) {
  const token = cleanIonToken(raw);
  ionMsg(t('Contactez Cesium ion…'));
  try {
    const r = await resolveIon(token);
    if (map.getLayer('ion')) map.removeLayer('ion');
    if (map.getSource('ion')) map.removeSource('ion');
    map.addSource('ion', { type: 'raster', tiles: r.tiles, tileSize: 256, maxzoom: r.maxzoom, attribution: escapeHtml(r.attribution) });
    map.addLayer({ id: 'ion', type: 'raster', source: 'ion' }, 'track-shadow');
    Object.assign(IMG, { which: 'ion', token: r.token, attribution: r.attribution, failed: false });
    try { if ($('ionRemember').checked) localStorage.setItem('vld.ionToken', r.token); else localStorage.removeItem('vld.ionToken'); } catch { /* fără stocare */ }
    saveImagery(); showImagery('ion');
    ionMsg(t('Merge: imagini Bing prin Cesium ion.'), 'ok');
    return true;
  } catch (e) {
    const text = t(ION_ERR[e.code] || ION_ERR[e.message] || 'Nu am putut folosi Cesium ion.', { s: e.status || '' });
    ionMsg(text, 'err');
    IMG.which = quiet ? 'eox' : IMG.which;
    showImagery(quiet ? 'eox' : 'ion');
    if (map.getLayer('eox')) map.setLayoutProperty('eox', 'visibility', 'visible');
    if (quiet) notice(t('Imaginile detaliate (Cesium ion) nu s-au putut încărca; folosesc Sentinel-2.') + ' ' + text);
    return false;
  }
}
/** O dală Bing care nu se încarcă (cheie expirată, CORS, rețea): înapoi la Sentinel-2, cu un mesaj. */
map.on('error', (e) => {
  if (e.sourceId !== 'ion' || IMG.failed || IMG.which !== 'ion') return;
  IMG.failed = true; IMG.which = 'eox'; showImagery('eox');
  notice(t('Imaginile Bing nu se încarcă; folosesc Sentinel-2.'));
});
document.querySelectorAll('[data-img]').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.img === 'eox') { IMG.which = 'eox'; saveImagery(); showImagery('eox'); return; }
    showImagery('ion');
    if (map.getLayer('ion')) { IMG.which = 'ion'; saveImagery(); showImagery('ion'); }
    else if (cleanIonToken($('ionToken').value)) useIon($('ionToken').value);
    else { ionMsg(t(ION_ERR.empty)); $('ionToken').focus(); }
  };
});
$('ionTest').onclick = () => useIon($('ionToken').value);
$('ionPaste').onclick = async () => {
  try { $('ionToken').value = cleanIonToken(await navigator.clipboard.readText()); ionMsg(''); }
  catch { ionMsg(t('Browserul nu permite lipirea de aici; lipește în câmp (Cmd/Ctrl + V).')); $('ionToken').focus(); }
};
$('ionClear').onclick = () => {
  $('ionToken').value = ''; IMG.token = ''; ionMsg('');
  try { localStorage.removeItem('vld.ionToken'); } catch { /* fără stocare */ }
  if (map.getLayer('ion')) map.removeLayer('ion');
  if (map.getSource('ion')) map.removeSource('ion');
  IMG.which = 'eox'; saveImagery(); showImagery('ion');
  if (map.getLayer('eox')) map.setLayoutProperty('eox', 'visibility', 'visible');
};
$('ionToken').addEventListener('input', (e) => { const c = cleanIonToken(e.target.value); if (c !== e.target.value) e.target.value = c; });
$('ionRemember').onchange = (e) => {
  try { if (e.target.checked && IMG.token) localStorage.setItem('vld.ionToken', IMG.token); else if (!e.target.checked) localStorage.removeItem('vld.ionToken'); } catch { /* fără stocare */ }
};
const whenStyle = (fn) => (map.isStyleLoaded() ? fn() : map.once('load', fn));
whenStyle(() => {
  if (IMG.which === 'ion' && IMG.token) { showImagery('ion'); useIon(IMG.token, true); }
  else { IMG.which = 'eox'; showImagery('eox'); }   // fără token ținut minte: Sentinel-2
});
$('delBtn').onclick = async () => {
  const b = $('delBtn');
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = t('Apasă din nou pentru ștergere'); return; }
  await removeTrack(S.id).catch(() => {});
  $('sheet').close();
  S.id = null; S.track = null; history.replaceState(null, '', location.pathname + location.search);
  $('flightName').textContent = '';
  showIntro(t('Traseul a fost șters din acest browser. Ziua din jurnal rămâne.'));
};

// ------------------------------------------------------------------ pornire
function fromHash() {
  const m = location.hash.match(/^#flight=([0-9a-f]+)$/);
  if (m && ID_RE.test(m[1])) { if (m[1] !== S.id || !S.track) openId(m[1]); }
  else showIntro('');
}
window.addEventListener('hashchange', fromHash);
map.on('error', (e) => console.warn('[map]', e.error?.message || e));
if (map.loaded()) fromHash(); else map.once('load', fromHash);
