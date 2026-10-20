// Ce se „arde” în videoclip, desenat cu Canvas 2D peste imaginea hărții (ca export/OverlayPainter.kt din aplicație):
// titlul (primele 2 s, apoi se estompează), HUD-ul (altitudine, vario colorat, viteză, timp de zbor), profilul altitudinii
// porțiunii cu marcajul care se mișcă, „paraglidingwind.com” și atribuirea imaginilor și a reliefului, lizibilă.
// Aranjarea lasă liber ce acoperă Instagram/WhatsApp în 9:16 (sus ~10 %, jos ~14 %).

const FONT = '"Barlow Semi Condensed", "Roboto Condensed", system-ui, sans-serif';
const FONT_C = '"Barlow Condensed", "Roboto Condensed", system-ui, sans-serif';
const SCRIM = 'rgba(11,15,18,0.55)';
const DIM = '#b8c2cc';
const MARK = '#ffc94a';

function rrect(g, x, y, w, h, r) { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); }

/** Rupe textul în rânduri de cel mult `maxW` pixeli (cel mult `maxLines`). */
function wrap(g, text, maxW, maxLines) {
  const words = text.split(' '), lines = [];
  let cur = '';
  for (const w of words) {
    const s = cur ? cur + ' ' + w : w;
    if (g.measureText(s).width <= maxW || !cur) cur = s; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] += '…'; }
  return lines;
}

/**
 * c: {w, h, fps, title, subtitle, stats, attribution, labels: {alt, vario, speed, time, altitude, max}, profile: {startMs, endMs, alt[]},
 *     varioColor(v) → [r,g,b]}
 */
export function createOverlay(c) {
  const { w, h } = c;
  const u = Math.min(w, h) / 1080, portrait = h > w;
  const side = portrait ? 0.055 * w : 0.035 * w;
  // 9:16: sus ~8 % și jos ~10 % le acoperă Instagram / WhatsApp; HUD-ul imediat sub zona de sus, profilul și atribuirea
  // cât mai jos, imediat deasupra zonei de jos
  const top = portrait ? 0.085 * h : 0.045 * h;
  const bottom = h - (portrait ? 0.1 * h : 0.045 * h);
  // ce se arde în video (sursele hărții mereu; restul după alegere)
  const show = { title: true, hud: true, profile: true, watermark: true, ...(c.show || {}) };
  const titleFrames = show.title ? 2 * c.fps : 0, fadeFrames = Math.round(c.fps * 0.5);

  // fundalul static: atribuirea + numele site-ului (o singură dată)
  const base = document.createElement('canvas'); base.width = w; base.height = h;
  const bg = base.getContext('2d');
  bg.font = `500 ${22 * u}px ${FONT}`;
  const attrLines = wrap(bg, c.attribution, w - 2 * side - 24 * u, 3);
  const lineH = 27 * u;
  const attrH = attrLines.length * lineH + 14 * u;
  const attrTop = bottom - attrH;
  const attrW = Math.max(...attrLines.map((l) => bg.measureText(l).width)) + 24 * u;
  bg.fillStyle = SCRIM; rrect(bg, side, attrTop, attrW, attrH, 10 * u); bg.fill();
  bg.fillStyle = '#f2f4f6'; bg.textBaseline = 'top';
  attrLines.forEach((l, i) => bg.fillText(l, side + 12 * u, attrTop + 8 * u + i * lineH));
  bg.textBaseline = 'alphabetic';
  bg.shadowColor = 'rgba(0,0,0,0.8)'; bg.shadowBlur = 6 * u; bg.shadowOffsetY = 2 * u;
  bg.fillStyle = 'rgba(255,255,255,0.92)'; bg.font = `700 ${40 * u}px ${FONT_C}`; bg.textAlign = 'right';
  // în 9:16 HUD-ul e pe toată lățimea, sub numele site-ului; în 16:9 și 1:1 HUD-ul e în stânga, numele în dreapta
  const wmY = portrait && show.hud ? top + 112 * u + 46 * u : top + 40 * u;   // 9:16: sub HUD (care ia toată lățimea)
  if (show.watermark) {
    bg.fillText('paraglidingwind.com', w - side, wmY);
    bg.font = `600 ${20 * u}px ${FONT}`; bg.fillStyle = 'rgba(255,255,255,0.8)';
    bg.fillText(c.labels.subtitle, w - side, wmY + 28 * u);
  }
  bg.shadowColor = 'transparent'; bg.textAlign = 'left';

  // panoul profilului
  const ph = portrait ? 170 * u : 150 * u;
  const pw = portrait ? w - 2 * side : Math.min(w - 2 * side, 980 * u);
  const pr = { x: side, y: attrTop - 12 * u - ph, w: pw, h: ph };
  const inner = { x: pr.x + 20 * u, y: pr.y + 46 * u, w: pr.w - 40 * u, h: pr.h - 62 * u };
  const alt = c.profile.alt, n = alt.length;
  let lo = Math.min(...alt), hi = Math.max(...alt);
  if (hi - lo < 50) { const m = (hi + lo) / 2; lo = m - 25; hi = m + 25; }
  const PX = new Float32Array(n), PY = new Float32Array(n);
  for (let i = 0; i < n; i++) { PX[i] = inner.x + (inner.w * i) / Math.max(1, n - 1); PY[i] = inner.y + inner.h - (inner.h * (alt[i] - lo)) / (hi - lo); }
  const prof = document.createElement('canvas'); prof.width = w; prof.height = h;
  const pg = prof.getContext('2d');
  pg.fillStyle = SCRIM; rrect(pg, pr.x, pr.y, pr.w, pr.h, 18 * u); pg.fill();
  if (n >= 2) {
    const grad = pg.createLinearGradient(0, inner.y, 0, inner.y + inner.h);
    grad.addColorStop(0, 'rgba(255,255,255,0.33)'); grad.addColorStop(1, 'rgba(255,255,255,0.06)');
    pg.beginPath(); pg.moveTo(PX[0], inner.y + inner.h);
    for (let i = 0; i < n; i++) pg.lineTo(PX[i], PY[i]);
    pg.lineTo(PX[n - 1], inner.y + inner.h); pg.closePath(); pg.fillStyle = grad; pg.fill();
    pg.beginPath(); pg.moveTo(PX[0], PY[0]); for (let i = 1; i < n; i++) pg.lineTo(PX[i], PY[i]);
    pg.strokeStyle = 'rgba(255,255,255,0.6)'; pg.lineWidth = 3 * u; pg.lineJoin = 'round'; pg.stroke();
    pg.font = `700 ${22 * u}px ${FONT}`; pg.fillStyle = DIM;
    const lbl = c.labels.altitude;
    pg.fillText(lbl, pr.x + 20 * u, pr.y + 34 * u);
    pg.fillText(c.labels.max, pr.x + 20 * u + pg.measureText(lbl).width + 24 * u, pr.y + 34 * u);
  }

  // titlul (desenat o dată, estompat prin globalAlpha)
  const title = document.createElement('canvas'); title.width = w; title.height = h;
  const tg = title.getContext('2d');
  const tgrad = tg.createLinearGradient(0, 0, 0, h);
  tgrad.addColorStop(0.15, 'rgba(0,0,0,0)'); tgrad.addColorStop(0.38, 'rgba(0,0,0,0.69)');
  tgrad.addColorStop(0.62, 'rgba(0,0,0,0.69)'); tgrad.addColorStop(0.85, 'rgba(0,0,0,0)');
  tg.fillStyle = tgrad; tg.fillRect(0, 0, w, h);
  tg.shadowColor = 'rgba(0,0,0,0.8)'; tg.shadowBlur = 6 * u; tg.shadowOffsetY = 2 * u; tg.textAlign = 'center';
  const centered = (text, size, y, color, weight = 700, font = FONT_C) => {
    tg.font = `${weight} ${size}px ${font}`;
    const tw = tg.measureText(text).width, maxW = w - 2 * side;
    if (tw > maxW) tg.font = `${weight} ${(size * maxW) / tw}px ${font}`;
    tg.fillStyle = color; tg.fillText(text, w / 2, y);
  };
  centered(c.title, 92 * u, h / 2 - 20 * u, '#fff');
  centered(c.subtitle, 44 * u, h / 2 + 50 * u, '#e6eaee', 600, FONT);
  if (c.stats) centered(c.stats, 32 * u, h / 2 + 100 * u, '#c9d1d9', 500, FONT);

  const hudY = top;
  const hudW = portrait ? w - 2 * side : Math.min(w * 0.55, 1000 * u);

  function drawHud(g, v, a) {
    const cellH = 112 * u, cw = hudW / 4;
    g.save(); g.globalAlpha = a;
    g.fillStyle = SCRIM; rrect(g, side, hudY, hudW, cellH, 18 * u); g.fill();
    const cell = (k, lbl, val, unit, color) => {
      const x = side + k * cw + 20 * u;
      g.font = `700 ${22 * u}px ${FONT}`; g.fillStyle = DIM; g.fillText(lbl, x, hudY + 34 * u);
      g.font = `600 ${26 * u}px ${FONT}`; const uw = unit ? g.measureText(unit).width + 6 * u : 0;
      let size = 54 * u;
      g.font = `700 ${size}px ${FONT_C}`;
      const avail = cw - 30 * u - uw, vw = g.measureText(val).width;
      if (vw > avail) { size = (size * avail) / vw; g.font = `700 ${size}px ${FONT_C}`; }
      g.fillStyle = color; g.fillText(val, x, hudY + 94 * u);
      const vw2 = g.measureText(val).width;
      if (unit) { g.font = `600 ${26 * u}px ${FONT}`; g.fillStyle = DIM; g.fillText(unit, x + vw2 + 6 * u, hudY + 94 * u); }
    };
    const vc = v.varioMs > 0.3 ? c.varioColor(Math.max(1.2, v.varioMs)) : v.varioMs < -1.5 ? c.varioColor(v.varioMs) : null;
    cell(0, c.labels.alt, v.alt, 'm', '#fff');
    cell(1, c.labels.vario, v.vario, 'm/s', vc ? `rgb(${vc[0]},${vc[1]},${vc[2]})` : '#fff');
    cell(2, c.labels.speed, v.speed, 'km/h', '#fff');
    cell(3, c.labels.time, v.flightTime, '', '#fff');
    g.restore();
  }

  function drawMarker(g, ms, v, a) {
    if (n < 2) return;
    const f = Math.min(1, Math.max(0, (ms - c.profile.startMs) / Math.max(1, c.profile.endMs - c.profile.startMs)));
    const p = f * (n - 1), i = Math.min(n - 2, Math.floor(p)), fr = p - i;
    const mx = PX[i] + (PX[i + 1] - PX[i]) * fr, my = PY[i] + (PY[i + 1] - PY[i]) * fr;
    g.save(); g.globalAlpha = a;
    g.beginPath(); g.moveTo(PX[0], PY[0]); for (let k = 1; k <= i; k++) g.lineTo(PX[k], PY[k]); g.lineTo(mx, my);
    g.strokeStyle = MARK; g.lineWidth = 5 * u; g.lineJoin = 'round'; g.stroke();
    g.beginPath(); g.moveTo(mx, inner.y); g.lineTo(mx, inner.y + inner.h); g.lineWidth = 3 * u; g.stroke();
    g.beginPath(); g.arc(mx, my, 9 * u, 0, Math.PI * 2); g.fillStyle = MARK; g.fill();
    g.font = `700 ${22 * u}px ${FONT}`; g.fillStyle = DIM; g.textAlign = 'right';
    const tl = v.timeLapse >= 1.5 ? `  ·  ×${Math.round(v.timeLapse)}` : '';
    g.fillText(v.clock + tl, pr.x + pr.w - 20 * u, pr.y + 34 * u);
    g.restore();
  }

  /** Desenează cadrul `frame` peste imaginea hărții deja pusă în `g`. */
  function draw(g, frame, ms, v) {
    const ta = frame < titleFrames - fadeFrames ? 1 : frame < titleFrames ? 1 - (frame - (titleFrames - fadeFrames)) / fadeFrames : 0;
    g.drawImage(base, 0, 0);
    const ha = 1 - ta;
    if (ha > 0) {
      if (show.profile) { g.save(); g.globalAlpha = ha; g.drawImage(prof, 0, 0); g.restore(); drawMarker(g, ms, v, ha); }
      if (show.hud) drawHud(g, v, ha);
    }
    if (ta > 0) { g.save(); g.globalAlpha = ta; g.drawImage(title, 0, 0); g.restore(); }
  }
  return { draw };
}
