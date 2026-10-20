// Ce fel de dispozitiv: ca ajutorul și rândul cu gesturile să vorbească despre mâna utilizatorului.
// 'touch' = telefon / tabletă (Android, iPhone, iPad), 'mac' = Mac cu touchpad / mouse, 'pc' = Windows / Linux / ChromeOS.
// Pur (testat în tests/replay-device.test.mjs); în pagină primește navigator + matchMedia.
export function deviceKind({ platform = '', ua = '', maxTouchPoints = 0, coarse = false, hover = true } = {}) {
  const p = `${platform} ${ua}`;
  const ios = /iPhone|iPad|iPod/i.test(p) || (/Mac/i.test(p) && maxTouchPoints > 1);   // iPadOS se prezintă ca Mac
  const android = /Android/i.test(p);
  if (ios || android || (coarse && !hover)) return 'touch';
  if (/Mac/i.test(p)) return 'mac';
  return 'pc';
}

export const currentDevice = () => deviceKind({
  platform: navigator.userAgentData?.platform || navigator.platform || '', ua: navigator.userAgent || '',
  maxTouchPoints: navigator.maxTouchPoints || 0,
  coarse: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(any-hover: hover)').matches,
});
