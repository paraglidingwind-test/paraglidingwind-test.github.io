// Parapanta 3D (ca în aplicația SkyReplay, render/MeshBuilders.glider): voal arcuit cu celule în dungi portocaliu/galben,
// suspante și pilotul, în metri; înainte = +Y, dreapta = +X, sus = +Z, pilotul în origine. Plus direcția și înclinarea
// în viraj pentru fiecare punct. Logică pură, testată în tests/replay-glider.test.mjs.
import { distance, bearing } from './lib/geo.js?v=0d26e59';

/** Mesh pentru deck.gl SimpleMeshLayer: {attributes: {POSITION, NORMAL, COLOR_0, TEXCOORD_0}}, triunghiuri neindexate. */
export function gliderMesh() {
  const pos = [], nor = [], col = [];
  const tri = (a, b, c, k) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.max(1e-6, Math.hypot(nx, ny, nz)); nx /= l; ny /= l; nz /= l;
    for (const p of [a, b, c]) { pos.push(...p); nor.push(nx, ny, nz); col.push(...k); }
  };
  const quad = (a, b, c, d, k) => { tri(a, b, c, k); tri(a, c, d, k); };
  const N = 14, R = 5.6, H = 7.6, maxA = 64;
  const sections = [];
  for (let s = 0; s <= N; s++) {
    const th = ((-maxA + (2 * maxA * s) / N) * Math.PI) / 180;
    const chord = 2.9 * (1 - (0.45 * Math.abs(th)) / ((maxA * Math.PI) / 180));
    // profil: bord de atac, extrados, bord de fugă, intrados (y, abatere radială)
    const prof = [[chord * 0.5, 0], [chord * 0.2, 0.32], [-chord * 0.5, 0], [chord * 0.2, -0.12]];
    sections.push(prof.map(([py, dr]) => { const r = R + dr; return [r * Math.sin(th), py, H - R + r * Math.cos(th)]; }));
  }
  const c1 = [1, 0.35, 0.08], c2 = [1, 0.82, 0.1], under = [0.75, 0.25, 0.1];
  for (let s = 0; s < N; s++) {
    const a = sections[s], b = sections[s + 1], top = s % 2 === 0 ? c1 : c2;
    quad(a[0], b[0], b[1], a[1], top);
    quad(a[1], b[1], b[2], a[2], top);
    quad(a[2], b[2], b[3], a[3], under);
    quad(a[3], b[3], b[0], a[0], under);
  }
  // pilotul (cutie)
  const pc = [0.15, 0.2, 0.35], px = 0.35, py = 0.45, pz0 = -0.5, pz1 = 0.6;
  const P = Array.from({ length: 8 }, (_, i) => [i & 1 ? px : -px, i & 2 ? py : -py, i & 4 ? pz1 : pz0]);
  quad(P[0], P[2], P[3], P[1], pc); quad(P[4], P[5], P[7], P[6], pc);
  quad(P[0], P[1], P[5], P[4], pc); quad(P[2], P[6], P[7], P[3], pc);
  quad(P[0], P[4], P[6], P[2], pc); quad(P[1], P[3], P[7], P[5], pc);
  // suspantele: benzi subțiri de la pilot la voal, la 0,35 și 0,8 din semi-anvergură (ambele fețe, ca să se vadă din orice parte)
  const lc = [0.92, 0.92, 0.92];
  for (const side of [-1, 1]) for (const tip of [0.35, 0.8]) {
    const th = (side * maxA * tip * Math.PI) / 180;
    const wx = R * Math.sin(th), wz = H - R + R * Math.cos(th);
    const b0 = [side * 0.3, 0, pz1], t0 = [wx, 0, wz], b1 = [b0[0], 0.12, b0[2]], t1 = [t0[0], 0.12, t0[2]];
    quad(b0, b1, t1, t0, lc); quad(b0, t0, t1, b1, lc);
  }
  const n = pos.length / 3;
  return {
    attributes: {
      POSITION: { size: 3, value: new Float32Array(pos) },
      NORMAL: { size: 3, value: new Float32Array(nor) },
      COLOR_0: { size: 3, value: new Float32Array(col) },
      TEXCOORD_0: { size: 2, value: new Float32Array(n * 2) },
    },
  };
}

/** Anvergura modelului (m), pentru mărimea minimă pe ecran. */
export const GLIDER_SPAN_M = 2 * 5.6 * Math.sin((64 * Math.PI) / 180);

/**
 * Direcția (grade de la nord, în sensul acelor) din deplasarea pe ±4 s și înclinarea în viraj (grade, + = viraj la dreapta)
 * din rata de viraj pe ±2 s, ca într-un viraj coordonat (tan φ = v·ω/g), limitată la ±55° și netezită.
 */
export function headingBank(pts) {
  const n = pts.length, hd = new Float64Array(n), bank = new Float64Array(n), raw = new Float64Array(n);
  const lower = (i, ms) => { let k = i; while (k > 0 && pts[k - 1].t >= pts[i].t - ms) k--; return k; };
  const upper = (i, ms) => { let k = i; while (k < n - 1 && pts[k + 1].t <= pts[i].t + ms) k++; return k; };
  for (let i = 0; i < n; i++) {
    const a = pts[lower(i, 4000)], b = pts[upper(i, 4000)];
    hd[i] = distance(a.lat, a.lon, b.lat, b.lon) > 1 ? bearing(a.lat, a.lon, b.lat, b.lon) : i ? hd[i - 1] : 0;
  }
  for (let i = 0; i < n; i++) {
    const ia = lower(i, 2000), ib = upper(i, 2000), dt = (pts[ib].t - pts[ia].t) / 1000;
    if (dt <= 0) continue;
    let dh = hd[ib] - hd[ia]; while (dh > 180) dh -= 360; while (dh < -180) dh += 360;
    const v = distance(pts[ia].lat, pts[ia].lon, pts[ib].lat, pts[ib].lon) / dt;
    const omega = (dh * Math.PI) / 180 / dt;
    raw[i] = Math.max(-55, Math.min(55, (Math.atan((v * omega) / 9.81) * 180) / Math.PI));
  }
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) { s += raw[k]; c++; } bank[i] = s / c; }
  return { heading: hd, bank };
}

/** Interpolează un unghi (grade) între două valori pe drumul cel mai scurt. */
export const lerpAngle = (a, b, f) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return (((a + d * f) % 360) + 360) % 360; };

/**
 * Scara modelului: mărime reală de aproape, dar cel puțin `minPx` pixeli de anvergură pe ecran de departe.
 * `mPerPx` = metri pe pixel CSS în dreptul parapantei.
 */
export const gliderScale = (mPerPx, minPx = 34) => Math.max(1, (mPerPx * minPx) / GLIDER_SPAN_M);

/** Metri pe pixel CSS la zoomul MapLibre `zoom` și latitudinea `lat` (dale de 512 px). */
export const metersPerPixel = (zoom, lat) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
