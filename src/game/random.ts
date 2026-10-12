/**
 * 确定性随机与噪声工具。
 *
 * 全项目只使用这一套：同样的种子必须生成完全相同的赛道、地形与纸艺装饰，
 * 这样"同配置可重现"才是可验证的，而不是口头承诺。
 */

/** mulberry32：小、快、确定性好。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二维整数哈希 → [0,1) */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** 值噪声 + 分形叠加。 */
export function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0; o < octaves; o++) {
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const o1 = seed + o * 7919;
    const v00 = hash2(ix, iy, o1);
    const v10 = hash2(ix + 1, iy, o1);
    const v01 = hash2(ix, iy + 1, o1);
    const v11 = hash2(ix + 1, iy + 1, o1);
    const v = (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
    sum += (v * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.03;
    fy *= 2.03;
  }
  return sum / norm;
}

/** 从数组里按种子随机取一个。 */
export function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/** [min, max) 区间的确定性随机。 */
export function range(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** 把 0xRRGGBB 拆成 CSS 颜色字符串，可调亮度。 */
export function cssColor(hex: number, lightnessShift = 0): string {
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 0xff) + lightnessShift));
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 0xff) + lightnessShift));
  const b = Math.min(255, Math.max(0, (hex & 0xff) + lightnessShift));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
