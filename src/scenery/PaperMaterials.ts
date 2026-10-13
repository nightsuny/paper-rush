import * as THREE from 'three';
import { createRng, cssColor, hash2, range } from '../game/random';
import type { TrackTheme } from '../tracks/types';

/**
 * 纸艺材质库：所有纹理都由 CanvasTexture 程序化生成，不使用任何外部贴图。
 *
 * 目标观感 = 一本真实的立体纸艺赛道书：
 *  - 纸纤维噪声 + 轻微颜色斑驳
 *  - 折痕/拼接缝
 *  - 卡纸厚度靠侧壁几何 + 边缘暗化表现
 *  - 卡通分级光照（MeshToonMaterial + 渐变图）而非 PBR 金属反射
 */

const textureCache = new Map<string, THREE.Texture>();

function canvas(size: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  return { c, ctx };
}

export interface PaperTextureOptions {
  /** 底色（0xRRGGBB） */
  color: number;
  size?: number;
  seed?: number;
  /** 纸纤维强度 0..1 */
  fiber?: number;
  /** 颜色斑驳强度 0..1 */
  blotch?: number;
  /** 折痕数量 */
  creases?: number;
  /** 画一张裁剪垫式的浅格线 */
  grid?: number;
  /** 边缘暗化强度 0..1 */
  edgeShade?: number;
  /** 缓存键（同样的参数只生成一次） */
  key: string;
}

/** 通用纸张纹理：纤维 + 斑驳 + 折痕 + 可选网格。 */
export function paperTexture(opts: PaperTextureOptions): THREE.CanvasTexture {
  const cached = textureCache.get(opts.key);
  if (cached) return cached as THREE.CanvasTexture;

  const size = opts.size ?? 256;
  const { c, ctx } = canvas(size);
  const rng = createRng(opts.seed ?? 1);
  const fiber = opts.fiber ?? 0.5;
  const blotch = opts.blotch ?? 0.5;

  ctx.fillStyle = cssColor(opts.color);
  ctx.fillRect(0, 0, size, size);

  // 1) 大块颜色斑驳：像同一批纸的细微色差
  const blotchCount = Math.round(6 + blotch * 22);
  for (let i = 0; i < blotchCount; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = range(rng, size * 0.06, size * 0.3);
    const shift = Math.round(range(rng, -14, 14) * blotch);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${shift > 0 ? 255 : 0},${shift > 0 ? 255 : 0},${shift > 0 ? 255 : 0},${Math.abs(shift) / 255 + 0.02})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 2) 纸纤维：细短笔触，带一点方向性
  const strokes = Math.round(1400 * fiber);
  ctx.lineWidth = 1;
  for (let i = 0; i < strokes; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const ang = rng() * Math.PI * 2;
    const len = range(rng, 1.5, 7);
    const dark = rng() > 0.5;
    const a = range(rng, 0.015, 0.07) * fiber;
    ctx.strokeStyle = dark ? `rgba(70,58,40,${a})` : `rgba(255,252,240,${a})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }

  // 3) 逐像素细颗粒
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (hash2(i, 7, opts.seed ?? 1) - 0.5) * 16 * fiber;
    d[i] = Math.min(255, Math.max(0, d[i] + n));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);

  // 4) 折痕：浅色的折线与压痕
  const creases = opts.creases ?? 2;
  for (let i = 0; i < creases; i++) {
    const horizontal = rng() > 0.5;
    const pos = rng() * size;
    const shift = range(rng, 2.5, 6);
    ctx.strokeStyle = 'rgba(255,253,245,0.30)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(0, pos);
      ctx.lineTo(size, pos + range(rng, -shift, shift));
    } else {
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos + range(rng, -shift, shift), size);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(60,48,34,0.16)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(0, pos + 2);
      ctx.lineTo(size, pos + 2);
    } else {
      ctx.moveTo(pos + 2, 0);
      ctx.lineTo(pos + 2, size);
    }
    ctx.stroke();
  }

  // 5) 裁剪垫式网格（用于桌面/草地，强化"手工台"感）
  if (opts.grid && opts.grid > 0) {
    ctx.strokeStyle = `rgba(90,74,52,${0.10 * opts.grid})`;
    ctx.lineWidth = 1;
    const cells = 8;
    for (let i = 0; i <= cells; i++) {
      const p = (i / cells) * size;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }
  }

  // 6) 边缘暗化：模拟纸张吸收胶水/阴影
  const edge = opts.edgeShade ?? 0;
  if (edge > 0) {
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(60,46,30,${0.22 * edge})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(opts.key, tex);
  return tex;
}

/** 路面纹理：沥青纸底 + 边线 + 中央虚线（横向 u 覆盖整条路宽，纵向 v 代表 12 米）。 */
export function roadTexture(theme: TrackTheme, seed: number): THREE.CanvasTexture {
  const key = `road-${theme.road}-${seed}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const w = 512;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  const rng = createRng(seed);

  ctx.fillStyle = cssColor(theme.road);
  ctx.fillRect(0, 0, w, h);

  // 沥青纸的斑驳
  for (let i = 0; i < 260; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = range(rng, 3, 26);
    const dark = rng() > 0.45;
    ctx.fillStyle = dark ? `rgba(70,62,52,${range(rng, 0.02, 0.09)})` : `rgba(255,250,238,${range(rng, 0.02, 0.07)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 细颗粒
  const img = ctx.getImageData(0, 0, w, h);
  const dd = img.data;
  for (let i = 0; i < dd.length; i += 4) {
    const n = (hash2(i, 3, seed) - 0.5) * 22;
    dd[i] = Math.min(255, Math.max(0, dd[i] + n));
    dd[i + 1] = Math.min(255, Math.max(0, dd[i + 1] + n));
    dd[i + 2] = Math.min(255, Math.max(0, dd[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);

  // 纸纤维方向性笔触
  for (let i = 0; i < 700; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const len = range(rng, 4, 18);
    ctx.strokeStyle = `rgba(${rng() > 0.5 ? '250,246,232' : '64,56,44'},${range(rng, 0.02, 0.06)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + range(rng, -1.5, 1.5));
    ctx.stroke();
  }

  // 道路两侧白色实线
  const lineColor = 'rgba(250,247,236,0.88)';
  ctx.fillStyle = lineColor;
  ctx.fillRect(w * 0.035, 0, w * 0.012, h);
  ctx.fillRect(w * 0.953, 0, w * 0.012, h);

  // 中央虚线：v 方向 12 米 → 3 米线段 + 9 米间隔
  const dashLen = h * (3 / 12);
  for (let y = 0; y < h; y += h / 2) {
    ctx.fillRect(w * 0.494, y, w * 0.012, dashLen);
  }

  // 拼接折痕：横向两道，模拟卡纸拼接
  ctx.strokeStyle = 'rgba(255,252,240,0.18)';
  ctx.lineWidth = 2;
  for (const y of [h * 0.33, h * 0.66]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}

/** 路肩条纹：红白相间的纸带。 */
export function kerbTexture(theme: TrackTheme): THREE.CanvasTexture {
  const key = `kerb-${theme.kerb}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;
  const w = 32;
  const h = 64;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  for (let i = 0; i < 2; i++) {
    ctx.fillStyle = i === 0 ? cssColor(theme.kerb) : cssColor(theme.accent);
    ctx.fillRect(0, (i * h) / 2, w, h / 2);
  }
  // 纸面颗粒
  for (let i = 0; i < 240; i++) {
    ctx.fillStyle = `rgba(90,74,52,${Math.random() * 0.07})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}

/** 卡纸侧壁：可见的瓦楞/层压纹理。 */
export function cardboardTexture(color: number, seed: number): THREE.CanvasTexture {
  return paperTexture({
    color,
    seed,
    size: 128,
    fiber: 0.9,
    blotch: 0.35,
    creases: 1,
    key: `cardboard-${color}-${seed}`,
  });
}

/** 黑白格旗帜（起点线 / 龙门架 / 结算界面）。 */
export function checkerTexture(cells = 8): THREE.CanvasTexture {
  const key = `checker-${cells}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;
  const size = cells * 16;
  const { c, ctx } = canvas(size);
  const s = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f7f3e6' : '#2b2a28';
      ctx.fillRect(x * s, y * s, s, s);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}

/** 天空：纸质渐变（顶部藏蓝 → 底部米黄），带一点手绘颗粒。 */
export function skyTexture(theme: TrackTheme, seed: number): THREE.CanvasTexture {
  const key = `sky-${theme.skyTop}-${theme.skyBottom}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;
  const w = 64;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  // 注意方向：SphereGeometry 的 v=1 在**天顶**、v=0 在南极、v=0.5 正好是地平线。
  // 之前把 skyTop 放在 v=0，等于把天空倒过来贴 —— 天顶是暖白色 skyBottom，
  // 于是画面正上方出现一大团奶油色"穹顶"。这里按"地平线暖、天顶蓝"重排。
  const g = ctx.createLinearGradient(0, 0, 0, h);
  // 暖色只留在地平线附近 ~10° 以内，再往上很快转蓝。
  // 早先把暖色铺到 v=0.74（≈43° 仰角），整片低空都是奶油色，看上去就是天上扣了个圆盘。
  g.addColorStop(0, cssColor(theme.skyBottom, 8));
  g.addColorStop(0.5, cssColor(theme.skyBottom, 8));
  g.addColorStop(0.58, cssColor(theme.skyTop, 34));
  g.addColorStop(0.72, cssColor(theme.skyTop));
  g.addColorStop(1, cssColor(theme.skyTop));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // 手绘颗粒，避免渐变过于平滑
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    ctx.fillRect(x, y, 1, 1);
  }
  void seed;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}

/**
 * 卡通光照渐变图：把连续光照压成 3 档，
 * 得到"纸片被柔光照射"的插画感，而不是写实反光。
 */
export function toonGradient(steps = 4): THREE.DataTexture {
  const key = `toon-${steps}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.DataTexture;
  const data = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i++) {
    // 最暗一档不能太低：90/255 会让背光面接近黑色，纸艺风格应该是"柔和的深色"而不是黑。
    const v = Math.round(134 + (121 * i) / Math.max(steps - 1, 1));
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  textureCache.set(key, tex);
  return tex;
}

/** 纸张材质：卡通分级 + 可选贴图。 */
export function paperMaterial(
  color: number,
  options: {
    map?: THREE.Texture;
    side?: THREE.Side;
    roughness?: number;
    emissive?: number;
    /** 使用顶点色（与 color 相乘）。用于地面这种"一张连续材质、按距离过渡颜色"的情形。 */
    vertexColors?: boolean;
  } = {},
): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({
    color,
    map: options.map,
    gradientMap: toonGradient(4),
    side: options.side ?? THREE.FrontSide,
    vertexColors: options.vertexColors === true,
  });
  if (options.emissive) {
    mat.emissive = new THREE.Color(options.emissive);
    mat.emissiveIntensity = 0.55;
  }
  return mat;
}

/** 描边材质：反面渲染的深色壳层，模拟手绘轮廓线。 */
export function outlineMaterial(color = 0x2e2a24): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
}

/**
 * 给一个网格加描边（反向外壳法）。
 * 只用在对轮廓要求高的物体（车辆、树、房子、地标）上，避免整体开销。
 */
export function addOutline(
  mesh: THREE.Mesh,
  thickness: number,
  parent: THREE.Object3D,
  material?: THREE.Material,
): THREE.Mesh {
  const outline = new THREE.Mesh(mesh.geometry, material ?? outlineMaterial());
  outline.scale.copy(mesh.scale);
  // 沿法线放大：对非均匀缩放的几何用 scale 近似即可
  const s = 1 + thickness;
  outline.scale.multiplyScalar(s);
  outline.position.copy(mesh.position);
  outline.quaternion.copy(mesh.quaternion);
  outline.renderOrder = -1;
  parent.add(outline);
  return outline;
}

/** 清理纹理缓存（切换画质/重载时使用）。 */
export function clearTextureCache(): void {
  for (const tex of textureCache.values()) tex.dispose();
  textureCache.clear();
}

/**
 * 手绘纸牌：米白撕边卡纸 + 红色印章式标题 + 黑色手绘副标题。
 * 用于地图路牌、起终点横幅与结算界面的一致性视觉。
 */
export function makeSignTexture(opts: {
  title: string;
  subtitle?: string;
  width?: number;
  height?: number;
  titleColor?: string;
  paper?: number;
  seed?: number;
}): THREE.CanvasTexture {
  const w = opts.width ?? 512;
  const h = opts.height ?? 256;
  const key = `sign-${opts.title}-${opts.subtitle ?? ''}-${w}x${h}-${opts.paper ?? 0xf6f1e2}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  const rng = createRng(opts.seed ?? opts.title.length * 7919);

  // 纸底
  ctx.fillStyle = cssColor(opts.paper ?? 0xf6f1e2);
  ctx.fillRect(0, 0, w, h);

  // 纤维与斑驳
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(120,102,74,${rng() * 0.05})`;
    ctx.fillRect(rng() * w, rng() * h, 2, 1);
  }

  // 撕边：沿四边打一圈不规则的小缺口
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const bites = 70;
  for (let i = 0; i < bites; i++) {
    const edge = i % 4;
    const t = rng();
    const r = range(rng, 2, 7);
    const x = edge === 0 ? t * w : edge === 1 ? t * w : edge === 2 ? 0 : w;
    const y = edge === 0 ? 0 : edge === 1 ? h : t * h;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 内侧手绘描边
  ctx.strokeStyle = 'rgba(52,44,34,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, w - 20, h - 20);

  // 红色印章式标题
  const titleSize = Math.round(h * (opts.subtitle ? 0.34 : 0.44));
  ctx.font = `900 ${titleSize}px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = w / 2;
  const cy = opts.subtitle ? h * 0.4 : h * 0.5;

  // 印章底：略偏的红色块，像盖上去的
  const metrics = ctx.measureText(opts.title);
  const tw = metrics.width;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.012);
  ctx.fillStyle = 'rgba(199,58,48,0.12)';
  ctx.fillRect(-tw / 2 - 18, -titleSize * 0.68, tw + 36, titleSize * 1.36);
  ctx.restore();

  ctx.fillStyle = opts.titleColor ?? '#c33a2f';
  ctx.fillText(opts.title, cx, cy);

  if (opts.subtitle) {
    ctx.font = `600 ${Math.round(h * 0.14)}px "PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif`;
    ctx.fillStyle = 'rgba(48,42,34,0.86)';
    ctx.fillText(opts.subtitle, cx, h * 0.74);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textureCache.set(key, tex);
  return tex;
}

/**
 * 车门上的号码圆牌：白底圆 + 彩色圆环 + 黑字号码（透明背景）。
 * 用于给赛车一个可辨认的"编号"，也让纸艺车更像玩具。
 */
export function makeRoundelTexture(number: number, ringColor = 0xc33a2f): THREE.CanvasTexture {
  const key = `roundel-${number}-${ringColor}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;
  const size = 128;
  const { c, ctx } = canvas(size);
  const cx = size / 2;
  ctx.clearRect(0, 0, size, size);
  // 白底
  ctx.fillStyle = '#f8f4e8';
  ctx.beginPath();
  ctx.arc(cx, cx, size * 0.46, 0, Math.PI * 2);
  ctx.fill();
  // 彩色圆环
  ctx.strokeStyle = cssColor(ringColor);
  ctx.lineWidth = size * 0.08;
  ctx.beginPath();
  ctx.arc(cx, cx, size * 0.4, 0, Math.PI * 2);
  ctx.stroke();
  // 号码
  ctx.fillStyle = '#2f2a24';
  ctx.font = `900 ${Math.round(size * 0.52)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), cx, cx + size * 0.03);
  // 纸面颗粒
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = `rgba(90,74,52,${Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textureCache.set(key, tex);
  return tex;
}

/**
 * 弯道箭头牌：米白纸板 + 黑黄相间的连续箭头。
 * 放在急弯外侧，既提示弯向，也让赛道看起来"有人设计过"。
 */
export function makeChevronTexture(direction: 1 | -1 = 1, count = 3): THREE.CanvasTexture {
  const key = `chevron-${direction}-${count}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;
  const w = 512;
  const h = 128;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  // 纸底
  ctx.fillStyle = '#f6f1e2';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(120,102,74,${Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 1);
  }
  // 黑边框
  ctx.strokeStyle = '#2b2620';
  ctx.lineWidth = 7;
  ctx.strokeRect(4, 4, w - 8, h - 8);
  // 箭头：从深到浅的黄黑三角
  const bw = w / count;
  for (let i = 0; i < count; i++) {
    const x0 = i * bw;
    ctx.fillStyle = i % 2 === 0 ? '#e8b53a' : '#2b2620';
    ctx.beginPath();
    const cx = x0 + bw * 0.5;
    const tip = cx + direction * bw * 0.34;
    const back = cx - direction * bw * 0.26;
    ctx.moveTo(tip, h * 0.5);
    ctx.lineTo(back, h * 0.16);
    ctx.lineTo(back, h * 0.84);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textureCache.set(key, tex);
  return tex;
}
