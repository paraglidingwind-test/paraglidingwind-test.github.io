// Videoclipul zborului: planul cadrelor (timeline), camera cinematică, formatul fișierului.
// Logică pură (fără DOM), portată din aplicația SkyReplay (export/ExportOptions.kt, export/CinematicCamera.kt);
// testată în tests/replay-video.test.mjs. Înregistrarea propriu-zisă e în ./recorder.js.

export const FPS = 30;
export const FORMATS = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
};
export const DURATIONS = [15, 30, 60];
export const SPEEDUPS = [5, 10, 20, 50];
export const INTRO_S = 2, OUTRO_S = 2.5;

/**
 * Cât de mare se randează harta. Containerul hărții trebuie să încapă în fereastră (altfel deck.gl, care desenează
 * traseul și parapanta în același canvas, iese decalat față de hartă), deci containerul = rezoluția videoclipului
 * împărțită la un pixelRatio cel puțin cât al ecranului și destul de mare ca să încapă în availW×availH.
 * uiScale: cât se îngroașă liniile și textele (în pixeli CSS) ca în video să arate ca pe un ecran „retina” la 1080p.
 * Dacă placa video nu poate atât (maxDim), rezoluția scade proporțional (scaled = true).
 */
export function renderPlan(fmt, maxDim = 4096, dpr = 2, availW = Infinity, availH = Infinity) {
  const f = FORMATS[fmt] || FORMATS['16:9'];
  const k = Math.min(1, maxDim / Math.max(f.w, f.h));
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  const w = even(f.w * k), h = even(f.h * k);
  const pr = Math.max(dpr > 0 ? dpr : 1, w / Math.max(1, availW), h / Math.max(1, availH));
  const cssW = Math.floor(w / pr), cssH = Math.floor(h / pr);
  const ratio = Math.max(w / cssW, h / cssH);
  return { w, h, cssW, cssH, pixelRatio: ratio, uiScale: (2 / ratio) * Math.min(w, h) / 1080, scaled: k < 1 };
}

/** Bitrate H.264/VP9 (bit/s) pentru w×h la fps: „Standard” din aplicație (0,12 biți/pixel/cadru), ex. 1080×1920@30 ≈ 7,5 Mbit/s. */
export const bitrate = (w, h, fps = FPS) => Math.round(Math.min(40e6, Math.max(1e6, w * h * fps * 0.12)));

/** Lungimea videoclipului (s) pentru timp real ×N: titlu + porțiunea accelerată + încheiere, rotunjit în sus. */
export function durationForSpeed(spanMs, speed) {
  return Math.ceil(INTRO_S + OUTRO_S + 0.8 + spanMs / 1000 / speed);
}

/**
 * Cadrele videoclipului → timpul zborului: titlu ținut pe loc, mijlocul în time-lapse cu accelerare și frânare
 * line (fără smucituri), încheiere ținută pe loc (vederea de ansamblu). Ca ExportTimeline din aplicație.
 */
export class Timeline {
  constructor(startMs, endMs, durationS, fps = FPS, introS = INTRO_S, outroS = OUTRO_S, rampS = 0.8) {
    if (!(endMs > startMs)) throw new Error('empty range');
    this.startMs = startMs; this.endMs = endMs; this.durationS = durationS; this.fps = fps;
    this.frames = Math.round(durationS * fps);
    this.introFrames = Math.round(Math.min(introS, durationS * 0.2) * fps);
    this.outroFrames = Math.round(Math.min(outroS, durationS * 0.2) * fps);
    this.middleS = Math.max(1, this.frames - this.introFrames - this.outroFrames) / fps;
    this.ramp = Math.min(rampS, this.middleS / 3);
    /** Accelerarea maximă (secunde de zbor pe secundă de video). */
    this.peakSpeed = (endMs - startMs) / 1000 / (this.middleS - this.ramp);
  }
  videoS(frame) { return frame / this.fps; }
  /** Timpul zborului (ms epoch) în cadrul `frame`: crescător, startMs la cadrul 0, endMs la ultimele cadre. */
  flightTimeAt(frame) {
    const u = this.videoS(frame) - this.introFrames / this.fps;
    return this.startMs + Math.min(this.endMs - this.startMs, Math.max(0, Math.round(this.progressS(u) * 1000)));
  }
  /** Accelerarea în cadrul `frame` (0 cât timp e ținut pe loc). */
  speedAt(frame) {
    const u = this.videoS(frame) - this.introFrames / this.fps, m = this.middleS, a = this.ramp, v = this.peakSpeed;
    if (u <= 0 || u >= m) return 0;
    if (u < a) return v * u / a;
    if (u > m - a) return v * (m - u) / a;
    return v;
  }
  progressS(u) {
    const m = this.middleS, v = this.peakSpeed, a = this.ramp;
    if (u <= 0) return 0;
    if (u < a) return v * u * u / (2 * a);
    if (u <= m - a) return v * a / 2 + v * (u - a);
    if (u < m) { const r = m - u; return v * (m - a) - v * r * r / (2 * a); }
    return v * (m - a);
  }
}

/** Codecul înregistrării: MP4/H.264 unde se poate (Chrome și Safari recente), altfel WebM VP9/VP8. */
export const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.4d0028', 'video/mp4;codecs=avc1', 'video/mp4',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
];
export function pickMime(isSupported) {
  for (const m of MIME_CANDIDATES) { try { if (isSupported(m)) return m; } catch { /* browser vechi */ } }
  return null;
}
/** „MP4 · H.264”, „WebM · VP9”… pentru interfață; extensia fișierului. */
export function mimeInfo(mime) {
  const mp4 = /mp4/.test(mime || '');
  const codec = /avc1|h264/i.test(mime) ? 'H.264' : /vp9/i.test(mime) ? 'VP9' : /vp8/i.test(mime) ? 'VP8' : '';
  return { ext: mp4 ? 'mp4' : 'webm', label: (mp4 ? 'MP4' : 'WebM') + (codec ? ' · ' + codec : '') };
}

/** Text simplu pentru nume de fișier: fără diacritice, litere mici, cratime. */
export const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** zbor-2026-10-17-faureni-1724.mp4 (data și ora locală a începutului porțiunii). */
export function videoFileName(startMs, site, ext = 'mp4') {
  const d = new Date(startMs), p = (x) => String(x).padStart(2, '0');
  const parts = ['zbor', `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, slug(site), `${p(d.getHours())}${p(d.getMinutes())}`];
  return parts.filter(Boolean).join('-') + '.' + ext;
}

/**
 * Zoomul MapLibre la care camera e la `distM` metri de centru: distanța cameră–centru în pixeli
 * (0,5 / tan(fov/2) × înălțimea hărții) ori metri pe pixel (circumferința × cos(lat) / (512 × 2^zoom)).
 */
export function zoomForDistance(distM, latDeg, cssH, fovDeg = 36.87) {
  const c2c = 0.5 / Math.tan((fovDeg * Math.PI) / 360) * cssH;
  return Math.log2((40075016.686 * Math.cos((latDeg * Math.PI) / 180) * c2c) / (512 * distM));
}

// ------------------------------------------------------------------ camera cinematică
const angleDiff = (to, from) => { let d = (to - from) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const norm = (a) => ((a % 360) + 360) % 360;
const lerp = (a, b, f) => a + (b - a) * f;
const smoothstep = (x) => x * x * (3 - 2 * x);
/** Netezire exponențială înainte și înapoi (fază zero), constanta de timp în secunde de video. */
function smooth(a, fps, tauS) {
  if (a.length < 2) return;
  const k = 1 - Math.exp(-1 / (fps * tauS));
  for (let i = 1; i < a.length; i++) a[i] = a[i - 1] + (a[i] - a[i - 1]) * k;
  for (let i = a.length - 2; i >= 0; i--) a[i] = a[i + 1] + (a[i] - a[i + 1]) * k;
}

/**
 * Camera „cinematică” (ca CinematicCamera.kt, simplificată): orbită de deschidere în jurul decolării cât stă titlul,
 * urmărire din spate pe planări (mai departe când zborul trece repede pe ecran), orbită lentă în jurul spiralelor
 * în termice, la final ridicare spre o vedere de ansamblu a porțiunii. Totul netezit, fără tăieturi.
 *
 * Intrare: timeline, timpii (ms) și pozițiile în metri (x est, y nord, z sus) ale traseului, termicele [{startMs,endMs}],
 * raportul lățime/înălțime. Ieșire pe cadru: ținta (tx, ty, tz), yaw (încotro privește camera, grade de la nord),
 * pitch (grade sub orizont), dist (metri cameră–țintă) și shot (planul dominant).
 */
export function cinematicCamera(tl, t, x, y, z, thermals, aspect, fovYDeg = 36.87) {
  const n = tl.frames, fps = tl.fps, N = t.length;
  if (N < 2) throw new Error('track too short');
  let cache = 0;
  const p = [0, 0, 0];
  const at = (ms) => {
    const tm = Math.min(t[N - 1], Math.max(t[0], ms));
    let i = Math.min(N - 2, Math.max(0, cache));
    if (t[i] > tm || t[i + 1] < tm) {
      let lo = 0, hi = N - 2;
      while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (t[mid] <= tm) lo = mid; else hi = mid - 1; }
      i = lo; cache = i;
    }
    const f = Math.min(1, Math.max(0, (tm - t[i]) / Math.max(1, t[i + 1] - t[i])));
    p[0] = x[i] + (x[i + 1] - x[i]) * f; p[1] = y[i] + (y[i + 1] - y[i]) * f; p[2] = z[i] + (z[i + 1] - z[i]) * f;
  };
  const mean = (ms, half, k = 13) => {
    let sx = 0, sy = 0, sz = 0;
    for (let j = 0; j < k; j++) { at(ms - half + (2 * half * j) / (k - 1)); sx += p[0]; sy += p[1]; sz += p[2]; }
    p[0] = sx / k; p[1] = sy / k; p[2] = sz / k;
  };

  const ft = new Float64Array(n), gx = new Float64Array(n), gy = new Float64Array(n), gz = new Float64Array(n);
  const sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ft[i] = tl.flightTimeAt(i);
    at(ft[i]); gx[i] = p[0]; gy[i] = p[1]; gz[i] = p[2];
    mean(ft[i], Math.max(4000, tl.speedAt(i) * 400)); sx[i] = p[0]; sy[i] = p[1]; sz[i] = p[2];
  }
  // direcția de urmărire: deplasarea pe ± max(25 s, 1 s de video) de zbor (stabilă în spirale)
  const course = new Float64Array(n);
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const w = Math.max(25000, tl.speedAt(i) * 1000);
    mean(ft[i] + w / 2, w / 2, 7); const ax = p[0], ay = p[1];
    mean(ft[i] - w / 2, w / 2, 7);
    const dx = ax - p[0], dy = ay - p[1];
    let c = Math.hypot(dx, dy) < 5 && !Number.isNaN(prev) ? prev : (Math.atan2(dx, dy) * 180) / Math.PI;
    if (!Number.isNaN(prev)) c = prev + angleDiff(c, prev);
    course[i] = c; prev = c;
  }
  smooth(course, fps, 1);
  // viteza pe ecran (m pe secundă de video) → distanța de urmărire
  const vv = new Float64Array(n), k = Math.max(1, Math.round(fps * 0.5));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - k), b = Math.min(n - 1, i + k);
    vv[i] = b > a ? Math.hypot(sx[b] - sx[a], sy[b] - sy[a]) / ((b - a) / fps) : 0;
  }
  smooth(vv, fps, 1);

  // vederea de ansamblu (final)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, zs = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    if (t[i] < tl.startMs || t[i] > tl.endMs) continue;
    x0 = Math.min(x0, x[i]); x1 = Math.max(x1, x[i]); y0 = Math.min(y0, y[i]); y1 = Math.max(y1, y[i]); zs += z[i]; cnt++;
  }
  if (!cnt) { at(tl.startMs); x0 = x1 = p[0]; y0 = y1 = p[1]; zs = p[2]; cnt = 1; }
  const ocx = (x0 + x1) / 2, ocy = (y0 + y1) / 2, ocz = zs / cnt;
  const th = Math.tan((fovYDeg * Math.PI) / 360);
  const extV = Math.max(y1 - y0, (x1 - x0) * 0.6), extH = x1 - x0;
  const overviewDist = Math.min(50000, Math.max(900, Math.max(extV * 0.75 / (2 * th), extH / (2 * th * aspect)) * 1.25 + 400));

  // termice: intervale de video destul de lungi ca să se vadă o orbită (≥ 1,4 s)
  const thW = new Float64Array(n), thYaw = new Float64Array(n), thFrame = new Int32Array(n).fill(-1), thRate = new Float64Array(n);
  for (const r of thermals) {
    if (!(r.endMs > r.startMs)) continue;
    let a = -1, b = -1;
    for (let i = tl.introFrames; i < n - tl.outroFrames; i++) if (ft[i] >= r.startMs && ft[i] <= r.endMs) { if (a < 0) a = i; b = i; }
    if (a < 0 || b - a < 1.4 * fps) continue;
    const ramp = Math.min(1.2 * fps, (b - a) / 3), len = b - a;
    const turns = Math.round((16 * len) / fps / 360);
    // ture întregi plus diferența de direcție dintre intrare și ieșire: orbita se termină privind încotro pleacă parapanta
    const rate = turns >= 1 ? (turns * 360 + angleDiff(course[b], course[a])) / len : 6 / fps;
    for (let i = a; i <= b; i++) {
      const w = smoothstep(Math.min(1, Math.max(0, Math.min((i - a) / ramp, (b - i) / ramp))));
      if (w > thW[i]) { thW[i] = w; thFrame[i] = a; thYaw[i] = course[a]; thRate[i] = rate; }
    }
  }

  const introEnd = tl.introFrames, outroStart = n - tl.outroFrames, introRamp = 0.9 * fps;
  const outroBegin = outroStart - 0.6 * fps, outroRamp = Math.max(1, (tl.outroFrames + 0.6 * fps) * 0.85);
  const ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n);
  const uyaw = new Float64Array(n), upitch = new Float64Array(n), ulogd = new Float64Array(n);
  const shot = new Array(n);
  for (let i = 0; i < n; i++) {
    const vt = i / fps;
    const cd = Math.min(4000, Math.max(380, 380 + vv[i]));
    const cyaw = course[i], cr = (cyaw * Math.PI) / 180, ahead = cd * 0.12;
    let px = sx[i] + Math.sin(cr) * ahead, py = sy[i] + Math.cos(cr) * ahead, pz = sz[i];
    let pyaw = cyaw, ppitch = 17 + 18 * Math.min(1, Math.max(0, (cd - 380) / 4000)), plogd = Math.log(cd), dom = 'chase';
    const tw = thW[i];
    if (tw > 0) {
      mean(ft[i], 14000); const cx = p[0], cy = p[1];
      const oyaw = thYaw[i] + thRate[i] * (i - thFrame[i]);
      px = lerp(px, cx, tw); py = lerp(py, cy, tw); pz = lerp(pz, gz[i], tw);
      pyaw += angleDiff(oyaw, pyaw) * tw; ppitch = lerp(ppitch, 27, tw); plogd = lerp(plogd, Math.log(Math.max(520, cd * 0.8)), tw);
      if (tw > 0.5) dom = 'thermal';
    }
    const wi = i < introEnd - introRamp / 2 ? 1 : smoothstep(Math.min(1, Math.max(0, (introEnd + introRamp / 2 - i) / introRamp)));
    if (wi > 0 && introEnd > 0) {
      const iyaw = course[0] - 75 + 30 * vt;
      px = lerp(px, gx[0], wi); py = lerp(py, gy[0], wi); pz = lerp(pz, gz[0], wi);
      pyaw += angleDiff(iyaw, pyaw) * wi; ppitch = lerp(ppitch, 24, wi); plogd = lerp(plogd, Math.log(1100), wi);
      if (wi > 0.5) dom = 'intro';
    }
    const wo = smoothstep(Math.min(1, Math.max(0, (i - outroBegin) / outroRamp)));
    if (wo > 0) {
      const oyaw = course[Math.min(n - 1, Math.max(0, outroStart))] + (8 * (i - outroStart)) / fps;
      px = lerp(px, ocx, wo); py = lerp(py, ocy, wo); pz = lerp(pz, ocz, wo);
      pyaw += angleDiff(oyaw, pyaw) * wo; ppitch = lerp(ppitch, 52, wo); plogd = lerp(plogd, Math.log(overviewDist), wo);
      if (wo > 0.5) dom = 'outro';
    }
    ux[i] = px; uy[i] = py; uz[i] = pz;
    uyaw[i] = i === 0 ? pyaw : uyaw[i - 1] + angleDiff(pyaw, uyaw[i - 1]);
    upitch[i] = Math.min(75, Math.max(8, ppitch)); ulogd[i] = plogd; shot[i] = dom;
  }
  for (const a of [ux, uy, uz, uyaw, upitch, ulogd]) smooth(a, fps, 0.35);
  const out = { frames: n, tx: ux, ty: uy, tz: uz, yaw: new Float64Array(n), pitch: upitch, dist: new Float64Array(n), shot, flightTime: ft };
  for (let i = 0; i < n; i++) { out.yaw[i] = norm(uyaw[i]); out.dist[i] = Math.exp(ulogd[i]); }
  return out;
}

/** Proiecție locală echirectangulară (metri) în jurul unui punct; suficientă pe zeci de km. */
export function localFrame(lat0, lon0) {
  const R = 6371008.8, kx = (Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180), ky = (Math.PI / 180) * R;
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (xm, ym) => [lat0 + ym / ky, lon0 + xm / kx],
  };
}
