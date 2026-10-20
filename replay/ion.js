// Imagini satelit detaliate (Bing Maps Aerial) prin Cesium ion, cu tokenul gratuit al fiecărui vizitator (ca în aplicația
// SkyReplay: terrain/CesiumIonImagerySource.kt, ImagerySources.cleanIonToken). Site-ul nu are niciun token.
// Tokenul pleacă doar spre api.cesium.com; nu se scrie în jurnale. Logica pură e testată în tests/replay-ion.test.mjs.

export const ION_API = 'https://api.cesium.com';
export const ASSET_BING_AERIAL = 2;
export const BING_CREDIT = 'Imagery © Microsoft Bing via Cesium ion';

/** Doar caracterele unui JWT (litere, cifre, . _ -): scoate spațiile, rândurile noi și caracterele invizibile lipite din greșeală. */
export const cleanIonToken = (raw) => String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '');

export const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&copy;/g, '©').replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Răspunsul ion `/v1/assets/{id}/endpoint` → ce ne trebuie pentru Bing. */
export function parseEndpoint(o) {
  const opts = o?.options || {};
  return {
    type: o?.type || '', externalType: o?.externalType || null,
    url: opts.url || o?.url || null, key: opts.key || null, mapStyle: opts.mapStyle || 'Aerial',
    attributions: (o?.attributions || []).map((a) => stripHtml(a?.html)).filter(Boolean),
  };
}

/** Metadatele Bing (Imagery/Metadata) → șabloanele de dale MapLibre ({quadkey}), unul pe subdomeniu, și zoomul maxim. */
export function bingTiles(meta) {
  const r = meta?.resourceSets?.[0]?.resources?.[0];
  if (!r?.imageUrl) throw new Error('bing-meta');
  const subs = r.imageUrlSubdomains?.length ? r.imageUrlSubdomains : [''];
  const tiles = subs.map((s) => r.imageUrl.replace(/^http:\/\//, 'https://').replace('{subdomain}', s).replace('{culture}', 'en-US'));
  return { tiles, maxzoom: Math.min(19, r.zoomMax || 19) };
}

/** Atribuirea afișată (și arsă în video): creditele din endpoint (fără reclama „Upgrade for commercial use”) plus creditul Bing/ion. */
export const ionAttribution = (ep) => [...new Set([...(ep.attributions || []).filter((a) => !/upgrade/i.test(a)), BING_CREDIT])].join(' · ');

/** Eroare cu un cod pentru mesajele din interfață (fără token sau URL-uri cu chei în mesaj). */
const fail = (code, status) => Object.assign(new Error(code), { code, status });

/**
 * Tokenul → sursa de dale Bing. fetchFn = fetch (injectabil în teste). Întâi cu antetul Authorization: Bearer;
 * dacă browserul nu poate (rețea/CORS), încă o dată cu access_token în adresă, tot doar spre api.cesium.com.
 */
export async function resolveIon(rawToken, fetchFn = fetch, assetId = ASSET_BING_AERIAL) {
  const token = cleanIonToken(rawToken);
  if (!token) throw fail('empty');
  const url = `${ION_API}/v1/assets/${assetId}/endpoint`;
  let r;
  try { r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } }); } catch {
    try { r = await fetchFn(`${url}?access_token=${encodeURIComponent(token)}`); } catch { throw fail('network'); }
  }
  if (r.status === 401 || r.status === 403) throw fail('auth', r.status);
  if (r.status === 404) throw fail('asset', r.status);
  if (!r.ok) throw fail('http', r.status);
  const ep = parseEndpoint(await r.json());
  if ((ep.externalType || '').toUpperCase() !== 'BING' || !ep.key) throw fail('type');
  const base = (ep.url || 'https://dev.virtualearth.net').replace(/\/$/, '');
  let m;
  try { m = await fetchFn(`${base}/REST/v1/Imagery/Metadata/${encodeURIComponent(ep.mapStyle)}?incl=ImageryProviders&key=${encodeURIComponent(ep.key)}&uriScheme=https`); } catch { throw fail('network'); }
  if (!m.ok) throw fail('bing', m.status);
  const { tiles, maxzoom } = bingTiles(await m.json());
  return { tiles, maxzoom, attribution: ionAttribution(ep), token };
}
