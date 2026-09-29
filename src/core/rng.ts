/**
 * 确定性随机与噪声。
 *
 * 本项目所有的"随机"都必须是索引的纯函数：同一份 seed 永远得到同一片草地、
 * 同一排树。几何代码里禁止出现 `Math.random()`，否则每次刷新场景都会不一样，
 * 截图核对与视觉回归就无从谈起。
 */

export const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** 哈希值，落在 [-1, 1)。接受的 key 可以是整数也可以是浮点。 */
export function variation(n: number) {
  return (((Math.sin(n * 127.1 + 31.7) * 43758.5453) % 1) + 1) % 1;
}

/** 线性同余发生器，用于画程序化纹理。 */
export function makeRandom(seed = 1) {
  let s = Math.floor(seed) >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ------------------------------------------------------------------ *
 * 值噪声 / fBm —— 用来做起伏草原与纹理斑块
 * ------------------------------------------------------------------ */

function hash2(x: number, y: number) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}

/** 双线性插值的值噪声，返回 [0,1)。 */
export function valueNoise2D(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** 分形叠加噪声，返回 [0,1)。octaves 越多越"碎"。 */
export function fbm2D(x: number, y: number, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amplitude = 0.5;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise2D(x * frequency, y * frequency);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

/** 极坐标下的"有机圆"：把椭圆扰动成不规则的湖泊轮廓。 */
export function blobRadius(angle: number, seed = 0): number {
  return (
    1 +
    0.16 * Math.sin(angle * 3 + seed) +
    0.09 * Math.sin(angle * 5 - seed * 1.7) +
    0.05 * Math.sin(angle * 8 + seed * 2.3)
  );
}

export const radians = (deg: number) => deg * DEG;
