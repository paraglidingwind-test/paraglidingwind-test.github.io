// Mirrors ro.parapanta.skyreplay.io.FlightImporter: detect FIT / IGC / GPX by content (extension
// as fallback) → Flight { points: [{t, lat, lon, alt, altBaro, vario, speed, hr}], sport, sourceName }.
import { isFit, decode, toFlight } from './fit.js?v=a6ebe58';
import { looksLikeIgc, looksLikeGpx, parseIgc, parseGpx } from './text-parsers.js?v=a6ebe58';

const utf8 = new TextDecoder('utf-8');

export function detect(bytes, fileName) {
  if (isFit(bytes)) return 'FIT';
  const head = utf8.decode(bytes.subarray(0, Math.min(bytes.length, 16384))).replace(/^﻿/, '');
  if (looksLikeGpx(head)) return 'GPX';
  if (looksLikeIgc(head)) return 'IGC';
  const ext = (fileName || '').split('.').pop().toLowerCase();
  return { fit: 'FIT', igc: 'IGC', gpx: 'GPX' }[ext] ?? null;
}

/** @param {Uint8Array} bytes */
export function parseFlight(bytes, fileName = null) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const name = fileName ? fileName.split('/').pop() : null;
  const text = () => utf8.decode(bytes).replace(/^﻿/, '');
  let flight;
  switch (detect(bytes, fileName)) {
    case 'FIT': flight = toFlight(decode(bytes), name); break;
    case 'IGC': flight = parseIgc(text(), name); break;
    case 'GPX': flight = parseGpx(text(), name); break;
    default: throw new Error(`Unsupported flight file format: ${fileName || 'unknown'}`);
  }
  if (!flight.points.length) throw new Error(`No GPS fixes found in ${fileName || 'file'}`);
  return flight;
}
