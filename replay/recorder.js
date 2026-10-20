// Înregistrarea videoclipului în browser: harta (WebGL) se randează cadru cu cadru, determinist (ceasul reluării nu
// merge după ceasul real), fiecare cadru așteaptă dalele (fără pete gri), se compune cu Canvas 2D cu titlul, HUD-ul,
// profilul și atribuirea, apoi se înregistrează cu MediaRecorder. Nimic nu pleacă din browser.
//
// Cum iese durata corectă: MediaRecorder pune pe cadre ora reală. Între cadre (cât se încarcă și se randează harta)
// înregistrarea stă pe pauză; pentru fiecare cadru se reia exact 1/fps secunde, deci clipul are durata planificată
// oricât de încet s-ar randa. Harta nu are nevoie de preserveDrawingBuffer: imaginea se copiază în evenimentul
// „idle”/„render” al hărții, în același pas cu desenarea.
import { renderPlan, bitrate, Timeline, cinematicCamera, localFrame, zoomForDistance, pickMime, mimeInfo, FPS } from './video.js?v=a6ebe58';
import { createOverlay } from './overlay.js?v=a6ebe58';

const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function recorderSupport() {
  const ok = typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
  const mime = ok ? pickMime((m) => MediaRecorder.isTypeSupported(m)) : null;
  return { ok: ok && !!mime, mime, ...mimeInfo(mime) };
}

/** Cea mai mare dimensiune pe care o poate randa placa video a hărții. */
function maxRenderDim(map) {
  try {
    const gl = map.painter?.context?.gl || map.getCanvas().getContext('webgl2') || map.getCanvas().getContext('webgl');
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    return Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), vp[0], vp[1]);
  } catch { return 4096; }
}

/**
 * env: {map, deck (MapboxOverlay), track, setScale(k) — scara liniilor/textelor deck.gl, pts, thermals, zOff, setTime(ms) — pune ceasul reluării și straturile (fără cameră),
 *       hud(ms, frame) → valorile HUD, overlay: {title, subtitle, stats, attribution, labels}, varioColor,
 *       currentCam(): {mode, center, zoom, pitch, bearing}, chase: Float64Array, prepare(): curăță interfața}
 * opts: {fmt, range: {a, b}, durationS, camera: 'cine' | 'current'}
 * ui: {preview(canvas), progress(i, n, etaS), signal}
 */
export async function recordVideo(env, opts, ui) {
  const { map, track } = env;
  const sup = recorderSupport();
  if (!sup.ok) throw new Error('no-recorder');
  const plan = renderPlan(opts.fmt, Math.min(maxRenderDim(map), 4096), window.devicePixelRatio || 1, window.innerWidth, window.innerHeight);
  const { w, h, cssW, cssH } = plan;
  const tl = new Timeline(opts.range.a, opts.range.b, opts.durationS, FPS);
  const n = tl.frames;

  // --- starea de dinainte, ca s-o refacem
  const el = map.getContainer();
  const saved = {
    style: el.getAttribute('style'),
    cam: { center: map.getCenter(), elevation: map.getCenterElevation?.(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() },
    padding: map.getPadding(), cssH: el.clientHeight, fade: ['eox', 'ion'].filter((id) => map.getLayer(id)).map((id) => [id, map.getPaintProperty(id, 'raster-fade-duration')]), interactive: map.dragPan.isEnabled(),
  };
  const restore = () => {
    if (saved.style == null) el.removeAttribute('style'); else el.setAttribute('style', saved.style);
    env.setScale(1);
    deckPixels(true);
    map.setPixelRatio(null);
    map.resize();
    for (const [id, v] of saved.fade) if (map.getLayer(id)) map.setPaintProperty(id, 'raster-fade-duration', v ?? 300);
    map.setPadding(saved.padding);
    map.jumpTo(saved.cam);
    for (const hnd of ['dragPan', 'dragRotate', 'touchZoomRotate', 'touchPitch', 'keyboard', 'doubleClickZoom', 'boxZoom'])
      if (saved.interactive) map[hnd].enable();
  };

  // --- harta la rezoluția videoclipului (independent de fereastră), fără interacțiune
  for (const hnd of ['dragPan', 'dragRotate', 'touchZoomRotate', 'touchPitch', 'keyboard', 'doubleClickZoom', 'boxZoom']) map[hnd].disable();
  Object.assign(el.style, { inset: 'auto', left: '0px', top: '0px', right: 'auto', bottom: 'auto', width: `${cssW}px`, height: `${cssH}px` });
  // containerul încape în fereastră (vezi renderPlan); harta și deck.gl folosesc același pixelRatio;
  // liniile și textele deck.gl se scalează cu uiScale
  map.setPixelRatio(plan.pixelRatio);
  const dk = env.deck?._deck;
  const deckPixels = (v) => { try { dk?.setProps({ useDevicePixels: v }); dk?.device?.getDefaultCanvasContext?.()?.setProps?.({ useDevicePixels: v }); } catch { /* altă versiune deck.gl */ } };
  deckPixels(plan.pixelRatio);
  env.setScale(plan.uiScale);
  map.resize();
  for (const [id] of saved.fade) map.setPaintProperty(id, 'raster-fade-duration', 0);
  // fără padding (rămas de la fitBounds): camera calculată privește exact spre centrul cadrului
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  const fov = map.getVerticalFieldOfView?.() ?? 36.87;

  // --- camera pentru fiecare cadru
  const pts = env.pts;
  const lf = localFrame(pts[0].lat, pts[0].lon);
  let camAt;
  if (opts.camera === 'cine') {
    const tt = new Float64Array(pts.length), x = new Float64Array(pts.length), y = new Float64Array(pts.length), z = new Float64Array(pts.length);
    pts.forEach((p, i) => { tt[i] = p.t; const [a, b] = lf.toXY(p.lat, p.lon); x[i] = a; y[i] = b; z[i] = p.alt + env.zOff; });
    const thr = env.thermals.map((th) => ({ startMs: th.startMs, endMs: th.endMs }));
    const cc = cinematicCamera(tl, tt, x, y, z, thr, w / h, fov);
    let lift = 0;
    camAt = (i) => {
      const [lat, lon] = lf.toLatLon(cc.tx[i], cc.ty[i]);
      let p = cc.pitch[i];
      const d = cc.dist[i], yr = (cc.yaw[i] * Math.PI) / 180;
      // camera nu intră în munte: dacă terenul din spate e prea sus, ridicăm unghiul (repede în sus, încet înapoi)
      const back = d * Math.cos((p * Math.PI) / 180);
      const [clat, clon] = lf.toLatLon(cc.tx[i] - Math.sin(yr) * back, cc.ty[i] - Math.cos(yr) * back);
      const ground = map.queryTerrainElevation([clon, clat]);
      if (ground != null) {
        const need = (Math.asin(Math.min(1, Math.max(-1, (ground + 120 - cc.tz[i]) / d))) * 180) / Math.PI - p;
        lift = need > lift ? need : lift * 0.97 + Math.max(0, need) * 0.03;
      }
      p = Math.min(80, p + Math.max(0, lift));
      return { center: [lon, lat], elevation: cc.tz[i], zoom: zoomForDistance(d, lat, cssH, fov), pitch: 90 - p, bearing: cc.yaw[i] };
    };
  } else {
    const c = env.currentCam();
    const zoom = c.zoom + Math.log2(cssH / Math.max(1, saved.cssH));
    let b = c.bearing;
    camAt = (i) => {
      const ms = tl.flightTimeAt(i);
      if (c.mode === 'free') return { center: c.center, elevation: c.elevation, zoom, pitch: c.pitch, bearing: c.bearing };
      const pos = track.positionAt(ms);
      if (c.mode === 'chase') { const target = env.chase[track.indexAt(ms)]; let d = (target - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; b += d * 0.06; }
      return { center: [pos.lon, pos.lat], elevation: pos.alt + env.zOff, zoom, pitch: c.pitch, bearing: b };
    };
  }

  // --- pânzele: cadrul hărții copiat + ieșirea înregistrată (și previzualizarea)
  const frame = document.createElement('canvas'); frame.width = w; frame.height = h;
  const fg = frame.getContext('2d');
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const og = out.getContext('2d');
  ui.preview(out);
  const prof = [];
  for (let k = 0; k <= 300; k++) prof.push(track.positionAt(tl.startMs + ((tl.endMs - tl.startMs) * k) / 300).alt);
  const ov = createOverlay({ w, h, fps: FPS, ...env.overlay, profile: { startMs: tl.startMs, endMs: tl.endMs, alt: prof }, varioColor: env.varioColor });

  const copy = () => { fg.drawImage(map.getCanvas(), 0, 0, w, h); };   // canvasul hărții are ~w×h (rotunjiri de pixeli CSS)
  /** Așteaptă ca harta să fie gata (dalele încărcate, nimic în mișcare) și copiază imaginea în același pas cu desenarea. */
  const grab = (timeoutMs) => new Promise((res) => {
    let done = false, late = false;
    const finish = (why) => { if (done) return; done = true; map.off('idle', onIdle); map.off('render', onRender); clearTimeout(to); res(why); };
    const onIdle = () => { copy(); finish('idle'); };
    const onRender = () => { if (late) { copy(); finish('timeout'); } };
    const to = setTimeout(() => { late = true; map.triggerRepaint(); }, timeoutMs);
    map.on('idle', onIdle); map.on('render', onRender);
    map.triggerRepaint();
  });

  const stream = out.captureStream(0);
  const vtrack = stream.getVideoTracks()[0];
  const manual = typeof vtrack.requestFrame === 'function';
  const rstream = manual ? stream : out.captureStream(FPS);
  const rtrack = rstream.getVideoTracks()[0];
  const rec = new MediaRecorder(rstream, { mimeType: sup.mime, videoBitsPerSecond: bitrate(w, h, FPS) });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });

  const t0 = performance.now();
  let slow = 0, cancelled = false;
  const frameMs = 1000 / FPS;
  try {
    for (let i = 0; i < n; i++) {
      if (ui.signal?.aborted) { cancelled = true; break; }
      const ms = tl.flightTimeAt(i);
      map.jumpTo(camAt(i));
      env.setTime(ms);
      await raf(); await raf();
      const why = await grab(i === 0 ? 20000 : 6000);   // primul cadru: dalele pot dura mai mult
      if (why !== 'idle') slow++;
      // compunerea + un cadru de 1/fps s în înregistrare
      if (i === 0) rec.start(); else rec.resume();
      og.drawImage(frame, 0, 0);
      ov.draw(og, i, ms, env.hud(ms, tl.speedAt(i)));
      if (manual) rtrack.requestFrame();
      await sleep(frameMs);
      if (i < n - 1) rec.pause();
      const el2 = performance.now() - t0;
      ui.progress(i + 1, n, ((el2 / (i + 1)) * (n - i - 1)) / 1000);
    }
    // ultimul cadru mai stă o clipă, ca să nu fie tăiat la final
    if (!cancelled) await sleep(frameMs);
  } finally {
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    rstream.getTracks().forEach((t) => t.stop()); stream.getTracks().forEach((t) => t.stop());
    restore();
  }
  if (cancelled) return null;
  const blob = new Blob(chunks, { type: sup.mime.split(';')[0] });
  return { blob, mime: sup.mime, label: sup.label, ext: sup.ext, w, h, scaled: plan.scaled, frames: n, durationS: n / FPS, elapsedMs: performance.now() - t0, slowFrames: slow };
}
