const EDGE = 4;
const RUN = 8;

// Linear in the text (one map lookup per 8-window) and builds no regex from the key.
export function maskKey(text: string, key: string): string {
  const len = key.length;
  if (len <= RUN) return text;
  const windows = new Map<string, number>();
  for (let k = 0; k + RUN <= len; k++) {
    let bits = 0;
    for (let j = 0; j < RUN; j++) {
      const i = k + j;
      if (i >= EDGE && i < len - EDGE) bits |= 1 << j;
    }
    const w = key.slice(k, k + RUN);
    windows.set(w, (windows.get(w) ?? 0) | bits);
  }
  const masked = new Uint8Array(text.length);
  for (let t = 0; t + RUN <= text.length; t++) {
    const bits = windows.get(text.slice(t, t + RUN));
    if (bits === undefined) continue;
    for (let j = 0; j < RUN; j++) if (bits & (1 << j)) masked[t + j] = 1;
  }
  let out = '';
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (!masked[i]) { i++; continue; }
    out += `${text.slice(start, i)}....`;
    while (i < text.length && masked[i]) i++;
    start = i;
  }
  return out + text.slice(start);
}
