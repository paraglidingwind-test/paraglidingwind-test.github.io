// FIT decoder. Mirrors ro.parapanta.skyreplay.io.FitDecoder (Kotlin) — keep both in sync.
// File header, chained files, definition/data messages, compressed timestamp headers,
// developer data (BarometricAltitude / VerticalSpeed), both endiannesses, invalid values.
// Robust: stops at the first corrupt message and returns everything decoded so far.

export const FIT_EPOCH_MS = 631065600000; // 1989-12-31T00:00:00Z

const MESG_SPORT = 12, MESG_SESSION = 18, MESG_RECORD = 20, MESG_FIELD_DESCRIPTION = 206;
const SEMI_TO_DEG = 180 / 2147483648;

class CorruptFit extends Error {}

export function isFit(b) {
  return b.length >= 12 && b[0] >= 12 && b[8] === 0x2e && b[9] === 0x46 && b[10] === 0x49 && b[11] === 0x54;
}

export function sportName(code) {
  if (code == null) return null;
  const m = {
    0: 'generic', 1: 'running', 2: 'cycling', 3: 'transition', 4: 'fitness_equipment', 5: 'swimming',
    10: 'training', 11: 'walking', 13: 'alpine_skiing', 17: 'hiking', 18: 'multisport', 20: 'paddling',
    25: 'flying', 26: 'hang_gliding', 27: 'horseback_riding', 30: 'rock_climbing', 31: 'sailing',
    33: 'sky_diving', 36: 'mountaineering',
  };
  return m[code] ?? `sport_${code}`;
}

/** 1 = barometric altitude, 2 = vertical speed, 0 = other. */
export function devRole(name) {
  if (name == null) return 0;
  const k = name.toLowerCase().replace(/[^a-z]/g, '');
  if ((k.includes('baro') && k.includes('alt')) || k === 'pressurealtitude') return 1;
  if (k.includes('verticalspeed') || k.includes('vario') || k === 'vspeed' || k === 'vs' || k.includes('climbrate')) return 2;
  return 0;
}

function typeSize(t) {
  switch (t & 0x1f) {
    case 0: case 1: case 2: case 7: case 10: case 13: return 1;
    case 3: case 4: case 11: return 2;
    case 5: case 6: case 8: case 12: return 4;
    case 9: case 14: case 15: case 16: return 8;
    default: return 1;
  }
}

/** First element of a (possibly array) field; null if invalid. */
function readNumber(dv, p, size, baseType, big) {
  const t = baseType & 0x1f;
  const ts = typeSize(t);
  if (size < ts) return null;
  const le = !big;
  let raw;
  switch (t) {
    case 0: case 2: case 13: raw = dv.getUint8(p); return raw === 0xff ? null : raw;
    case 10: raw = dv.getUint8(p); return raw === 0 ? null : raw;
    case 1: raw = dv.getInt8(p); return raw === 0x7f ? null : raw;
    case 3: raw = dv.getInt16(p, le); return raw === 0x7fff ? null : raw;
    case 4: raw = dv.getUint16(p, le); return raw === 0xffff ? null : raw;
    case 11: raw = dv.getUint16(p, le); return raw === 0 ? null : raw;
    case 5: raw = dv.getInt32(p, le); return raw === 0x7fffffff ? null : raw;
    case 6: raw = dv.getUint32(p, le); return raw === 0xffffffff ? null : raw;
    case 12: raw = dv.getUint32(p, le); return raw === 0 ? null : raw;
    case 8: {
      if (dv.getUint32(p, le) === 0xffffffff) return null;
      const f = dv.getFloat32(p, le); return Number.isFinite(f) ? f : null;
    }
    case 9: {
      if (dv.getBigUint64(p, le) === 0xffffffffffffffffn) return null;
      const f = dv.getFloat64(p, le); return Number.isFinite(f) ? f : null;
    }
    case 14: { const v = dv.getBigInt64(p, le); return v === 0x7fffffffffffffffn ? null : Number(v); }
    case 15: { const v = dv.getBigUint64(p, le); return v === 0xffffffffffffffffn ? null : Number(v); }
    case 16: { const v = dv.getBigUint64(p, le); return v === 0n ? null : Number(v); }
    default: return null;
  }
}

const utf8 = new TextDecoder('utf-8');
function readString(b, p, size) {
  let len = 0;
  while (len < size && b[p + len] !== 0) len++;
  return utf8.decode(b.subarray(p, p + len)).trim();
}

const le16 = (b, p) => b[p] | (b[p + 1] << 8);
const be16 = (b, p) => (b[p] << 8) | b[p + 1];
const le32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function crc(b, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) {
    const byte = b[i];
    let tmp = CRC_TABLE[c & 0xf];
    c = (c >> 4) & 0x0fff;
    c = c ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[c & 0xf];
    c = (c >> 4) & 0x0fff;
    c = c ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return c;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{records:Array, sportCode:number|null, sport:string|null, devFields:Array,
 *   messageCounts:Object, crcOk:boolean|null, truncated:boolean}}
 */
export function decode(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (!isFit(bytes)) throw new Error('Not a FIT file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const st = {
    records: [], counts: {}, devDescs: new Map(), sessionSport: null, sportMsgSport: null, lastTimestamp: -1,
  };
  let crcOk = null, truncated = false, pos = 0;
  const n = bytes.length;

  const need = (p, end) => { if (p > end) throw new CorruptFit('truncated'); };

  function handle(global, values, strings, devValues, ts) {
    st.counts[global] = (st.counts[global] || 0) + 1;
    if (global === MESG_RECORD) st.records.push(toRecord(values, devValues, ts));
    else if (global === MESG_SESSION) { if (values.has(5) && st.sessionSport == null) st.sessionSport = values.get(5); }
    else if (global === MESG_SPORT) { if (values.has(0) && st.sportMsgSport == null) st.sportMsgSport = values.get(0); }
    else if (global === MESG_FIELD_DESCRIPTION) {
      const devIndex = values.get(0), num = values.get(1), base = values.get(2);
      if (devIndex == null || num == null || base == null) return;
      const sc = values.get(6);
      st.devDescs.set((devIndex << 8) | num, {
        devIndex, fieldNum: num, name: strings.get(3) ?? `field_${num}`, baseType: base,
        scale: sc && sc !== 0 ? sc : 1, offset: values.get(7) ?? 0, units: strings.get(8) ?? null,
      });
    }
  }

  function toRecord(v, devValues, ts) {
    let altBaro = null, vario = null;
    for (const [key, value] of devValues) {
      const role = devRole(st.devDescs.get(key)?.name);
      if (role === 1 && altBaro == null) altBaro = value;
      else if (role === 2 && vario == null) vario = value;
    }
    const alt = v.get(78) ?? v.get(2);
    const spd = v.get(73) ?? v.get(6);
    return {
      timeMs: ts != null ? FIT_EPOCH_MS + ts * 1000 : null,
      lat: v.has(0) ? v.get(0) * SEMI_TO_DEG : null,
      lon: v.has(1) ? v.get(1) * SEMI_TO_DEG : null,
      altitude: alt != null ? alt / 5 - 500 : null,
      speed: spd != null ? spd / 1000 : null,
      heartRate: v.get(3) ?? null,
      altBaro, vario,
    };
  }

  function readData(start, end, def, compressedTs) {
    let p = start;
    const values = new Map();
    const strings = new Map();
    for (const f of def.fields) {
      need(p + f.size, end);
      if ((f.baseType & 0x1f) === 7) {
        const s = readString(bytes, p, f.size);
        if (s) strings.set(f.num, s);
      } else {
        const v = readNumber(dv, p, f.size, f.baseType, def.big);
        if (v != null) values.set(f.num, v);
      }
      p += f.size;
    }
    const devValues = new Map();
    for (const d of def.devFields) {
      need(p + d.size, end);
      const key = (d.devIndex << 8) | d.num;
      const desc = st.devDescs.get(key);
      if (desc && (desc.baseType & 0x1f) !== 7) {
        const v = readNumber(dv, p, d.size, desc.baseType, def.big);
        if (v != null) devValues.set(key, v / desc.scale - desc.offset);
      }
      p += d.size;
    }
    let ts = values.get(253) ?? null;
    if (ts != null) st.lastTimestamp = ts;
    if (ts == null && compressedTs >= 0) ts = compressedTs;
    handle(def.global, values, strings, devValues, ts);
    return p;
  }

  while (pos + 12 <= n) {
    const hs = bytes[pos];
    if (hs < 12 || pos + hs > n || !(bytes[pos + 8] === 0x2e && bytes[pos + 9] === 0x46 && bytes[pos + 10] === 0x49 && bytes[pos + 11] === 0x54)) break;
    const dataSize = le32(bytes, pos + 4);
    const start = pos + hs;
    let end = start + dataSize;
    let sizeOk = true;
    if (dataSize <= 0 || end > n) { end = n; sizeOk = false; }

    const defs = new Array(16).fill(null);
    let lastTs = -1;
    let p = start;
    let fileTruncated = false;
    try {
      while (p < end) {
        const h = bytes[p];
        p++;
        if (h & 0x80) {
          // compressed timestamp header
          const local = (h >> 5) & 0x03;
          const offset = h & 0x1f;
          const def = defs[local];
          if (!def) throw new CorruptFit('undefined local type');
          let ts = -1;
          if (lastTs >= 0) {
            ts = (lastTs - (lastTs % 32)) + offset; // (lastTs & ~0x1F) | offset, safe beyond 2^31
            if (offset < lastTs % 32) ts += 0x20;
            lastTs = ts;
          }
          p = readData(p, end, def, ts);
        } else if (h & 0x40) {
          const local = h & 0x0f;
          const hasDev = (h & 0x20) !== 0;
          need(p + 5, end);
          const big = bytes[p + 1] === 1;
          const global = big ? be16(bytes, p + 2) : le16(bytes, p + 2);
          const nf = bytes[p + 4];
          p += 5;
          need(p + nf * 3, end);
          const fields = [];
          for (let k = 0; k < nf; k++) { fields.push({ num: bytes[p], size: bytes[p + 1], baseType: bytes[p + 2] }); p += 3; }
          const devFields = [];
          if (hasDev) {
            need(p + 1, end);
            const nd = bytes[p]; p++;
            need(p + nd * 3, end);
            for (let k = 0; k < nd; k++) { devFields.push({ num: bytes[p], size: bytes[p + 1], devIndex: bytes[p + 2] }); p += 3; }
          }
          defs[local] = { global, big, fields, devFields };
        } else {
          const def = defs[h & 0x0f];
          if (!def) throw new CorruptFit('undefined local type');
          const before = st.lastTimestamp;
          p = readData(p, end, def, -1);
          if (st.lastTimestamp !== before) lastTs = st.lastTimestamp;
        }
      }
    } catch (e) {
      if (e instanceof CorruptFit || e instanceof RangeError) fileTruncated = true;
      else throw e;
    }
    if (fileTruncated || !sizeOk) truncated = true;
    if (sizeOk && !fileTruncated && end + 2 <= n) {
      const stored = le16(bytes, end);
      if (stored !== 0) crcOk = crc(bytes, pos, end) === stored;
      pos = end + 2;
    } else break;
  }
  const code = st.sessionSport ?? st.sportMsgSport;
  return {
    records: st.records, sportCode: code, sport: sportName(code), devFields: [...st.devDescs.values()],
    messageCounts: st.counts, crcOk, truncated,
  };
}

/** Valid fixes as a Flight, sorted by time, one point per timestamp (mirrors FitDecoder.toFlight). */
export function toFlight(fit, sourceName = null) {
  const recs = fit.records.filter((r) => r.timeMs != null).sort((a, b) => a.timeMs - b.timeMs); // stable
  const pts = [];
  let lastAlt = null;
  for (const r of recs) {
    const t = r.timeMs;
    if (t == null) continue;
    const alt = r.altitude ?? r.altBaro ?? lastAlt;
    if (alt != null) lastAlt = alt;
    const { lat, lon } = r;
    if (lat == null || lon == null) continue;
    if (lat === 0 && lon === 0) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    if (pts.length && pts[pts.length - 1].t === t) continue;
    pts.push({ t, lat, lon, alt: alt ?? 0, altBaro: r.altBaro, vario: r.vario, speed: r.speed, hr: r.heartRate });
  }
  return { points: pts, sport: fit.sport, sourceName };
}
