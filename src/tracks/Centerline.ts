import type { ControlPoint } from './types';

/**
 * 赛道中心线：闭合 Catmull-Rom 样条 + 等弧长重采样 + 带超高的局部坐标系。
 *
 * 所有下游模块（道路网格、碰撞面、检查点、AI 线路、小地图）都只依赖这里，
 * 保证"一处定义、处处一致"。
 *
 * 坐标约定（与三辆车/车辆物理保持一致）：
 *   切向 T = 行进方向；世界上方 U = (0,1,0)
 *   右向 R = T × U   →  当 T = +Z 时 R = -X（与 Rapier 车辆控制器的前向轴一致）
 *   上向 W = R × T
 *   超高 bank > 0 表示道路右侧抬高。
 */

export interface CenterlineSample {
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  /** 单位右向（横向偏移正方向） */
  rx: number;
  ry: number;
  rz: number;
  /** 单位上向（含超高） */
  ux: number;
  uy: number;
  uz: number;
  /** 该点道路半宽（米） */
  halfWidth: number;
  /** 累计弧长（米） */
  s: number;
  /** 曲率大小（1/米） */
  curvature: number;
  /** 带符号曲率：左转为正 */
  signedCurvature: number;
  /** 坡度 dy/ds */
  grade: number;
  /** 超高角（弧度） */
  bank: number;
  /** 超高是否为配置显式指定（否则为按曲率自动生成） */
  bankExplicit: boolean;
}

/**
 * Centerline 需要的最小配置。
 * `TrackConfig`（闭合赛道）与 `RoadSegmentConfig`（开放路段）都能满足它，
 * 因此同一套曲线/投影/标架代码可以同时服务赛道与开放世界路网。
 */
export interface CurveSpec {
  points: readonly ControlPoint[];
  width: number;
  maxBank: number;
  /** 是否闭合回路。默认 true；开放世界里的路段为 false。 */
  closed?: boolean;
}

export interface CenterlineProjection {
  index: number;
  /** 沿赛道归一化进度 0..1 */
  t: number;
  /** 横向偏移（米，正为右） */
  lateral: number;
  /** 到中心线的平面距离（米） */
  distance: number;
  halfWidth: number;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export class Centerline<S extends CurveSpec = CurveSpec> {
  readonly config: S;
  readonly samples: CenterlineSample[];
  readonly totalLength: number;
  /** 是否为闭合回路 */
  readonly closed: boolean;

  private readonly cell = 16;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly gridW: number;
  private readonly gridH: number;
  private readonly grid: number[][];

  constructor(config: S, resolution = 1.0) {
    this.config = config;
    this.closed = config.closed !== false;
    const built = this.build(config, resolution);
    this.samples = built.samples;
    this.totalLength = built.totalLength;

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const s of this.samples) {
      minX = Math.min(minX, s.x);
      minZ = Math.min(minZ, s.z);
      maxX = Math.max(maxX, s.x);
      maxZ = Math.max(maxZ, s.z);
    }
    this.minX = minX - this.cell;
    this.minZ = minZ - this.cell;
    this.gridW = Math.max(1, Math.ceil((maxX - minX) / this.cell) + 2);
    this.gridH = Math.max(1, Math.ceil((maxZ - minZ) / this.cell) + 2);
    this.grid = Array.from({ length: this.gridW * this.gridH }, () => [] as number[]);
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      const gx = Math.floor((s.x - this.minX) / this.cell);
      const gz = Math.floor((s.z - this.minZ) / this.cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const ix = gx + dx;
          const iz = gz + dz;
          if (ix < 0 || iz < 0 || ix >= this.gridW || iz >= this.gridH) continue;
          this.grid[ix + iz * this.gridW].push(i);
        }
      }
    }
  }

  private build(
    config: CurveSpec,
    resolution: number,
  ): { samples: CenterlineSample[]; totalLength: number } {
    const points = config.points;
    const n = points.length;
    const closed = config.closed !== false;
    const sub = 14;
    const rawX: number[] = [];
    const rawY: number[] = [];
    const rawZ: number[] = [];
    const rawHalf: number[] = [];
    const rawBank: number[] = [];
    const defaultHalf = config.width / 2;

    // 闭合曲线：邻居回绕；开放曲线：端点处复制相邻点（标准开放 Catmull-Rom 处理）
    const segCount = closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const p0 = points[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)];
      const p1 = points[i];
      const p2 = points[closed ? (i + 1) % n : Math.min(i + 1, n - 1)];
      const p3 = points[closed ? (i + 2) % n : Math.min(i + 2, n - 1)];
      const w1 = p1.halfWidth ?? defaultHalf;
      const w2 = p2.halfWidth ?? defaultHalf;
      const b1 = p1.bank;
      const b2 = p2.bank;
      const hasBank = b1 !== undefined && b2 !== undefined;
      for (let k = 0; k < sub; k++) {
        const t = k / sub;
        rawX.push(catmullRom(p0.x, p1.x, p2.x, p3.x, t));
        rawY.push(catmullRom(p0.y, p1.y, p2.y, p3.y, t));
        rawZ.push(catmullRom(p0.z, p1.z, p2.z, p3.z, t));
        rawHalf.push(w1 + (w2 - w1) * t);
        rawBank.push(hasBank ? (b1 as number) + ((b2 as number) - (b1 as number)) * t : NaN);
      }
    }

    // 开放曲线要把终点也放进折线里（闭合曲线靠回绕自然闭合）
    if (!closed) {
      const last = points[n - 1];
      rawX.push(last.x);
      rawY.push(last.y);
      rawZ.push(last.z);
      rawHalf.push(last.halfWidth ?? defaultHalf);
      rawBank.push(last.bank ?? NaN);
    }

    const m = rawX.length;
    const rawSegs = closed ? m : m - 1;
    const cum: number[] = [0];
    for (let i = 0; i < rawSegs; i++) {
      const j = closed ? (i + 1) % m : i + 1;
      cum.push(cum[i] + Math.hypot(rawX[j] - rawX[i], rawZ[j] - rawZ[i]));
    }
    const totalLength = cum[rawSegs];
    const count = Math.max(closed ? 64 : 8, Math.round(totalLength / resolution));
    // 闭合曲线采样 [0, totalLength)；开放曲线要多采一个点，让 t=1 处真实存在
    const sampleCount = closed ? count : count + 1;
    const step = totalLength / Math.max(count, 1);

    const samples: CenterlineSample[] = [];
    let cursor = 0;
    for (let i = 0; i < sampleCount; i++) {
      const target = Math.min(i * step, totalLength);
      while (cursor < rawSegs - 1 && cum[cursor + 1] < target) cursor++;
      const segLen = Math.max(cum[cursor + 1] - cum[cursor], 1e-9);
      const f = Math.min(Math.max((target - cum[cursor]) / segLen, 0), 1);
      const a = closed ? cursor % m : cursor;
      const b = closed ? (cursor + 1) % m : Math.min(cursor + 1, m - 1);
      const noteBank = rawBank[a];
      samples.push({
        x: rawX[a] + (rawX[b] - rawX[a]) * f,
        y: rawY[a] + (rawY[b] - rawY[a]) * f,
        z: rawZ[a] + (rawZ[b] - rawZ[a]) * f,
        tx: 0, ty: 0, tz: 0,
        rx: 0, ry: 0, rz: 0,
        ux: 0, uy: 1, uz: 0,
        halfWidth: rawHalf[a] + (rawHalf[b] - rawHalf[a]) * f,
        s: target,
        curvature: 0,
        signedCurvature: 0,
        grade: 0,
        bank: Number.isNaN(noteBank) ? 0 : noteBank,
        bankExplicit: !Number.isNaN(noteBank),
      });
    }

    const N = samples.length;
    // 切向 / 坡度 / 带符号曲率
    // 开放曲线在端点用单侧差分（prev 或 next 取自身），不会退化成零向量
    const idxPrev = (i: number) => (closed ? (i - 1 + N) % N : Math.max(i - 1, 0));
    const idxNext = (i: number) => (closed ? (i + 1) % N : Math.min(i + 1, N - 1));
    for (let i = 0; i < N; i++) {
      const prev = samples[idxPrev(i)];
      const next = samples[idxNext(i)];
      let dx = next.x - prev.x;
      let dy = next.y - prev.y;
      let dz = next.z - prev.z;
      const len = Math.max(Math.hypot(dx, dy, dz), 1e-9);
      dx /= len;
      dy /= len;
      dz /= len;
      const s = samples[i];
      s.tx = dx;
      s.ty = dy;
      s.tz = dz;

      const ds = Math.max(Math.hypot(next.x - prev.x, next.z - prev.z), 1e-6);
      s.grade = (next.y - prev.y) / ds;

      // 曲率用三点外接圆精确求解：κ = 4·面积 / (a·b·c) = 2|cross| / (a·b·c)
      // （切向差分法在采样步长下会把曲率低估约一个采样间隔，不能用）
      const ax = prev.x - s.x;
      const az = prev.z - s.z;
      const cx = next.x - s.x;
      const cz = next.z - s.z;
      const cross = ax * cz - az * cx;
      const la = Math.hypot(ax, az);
      const lc = Math.hypot(cx, cz);
      const lb = Math.hypot(next.x - prev.x, next.z - prev.z);
      const denom = la * lc * lb;
      // cross > 0 表示向左转（本工程约定左转为正曲率）
      s.signedCurvature = denom > 1e-9 ? (2 * cross) / denom : 0;
      s.curvature = Math.abs(s.signedCurvature);
    }

    // 超高：显式指定优先，否则按曲率平滑推出并限制在 maxBank
    //
    // 注意：绝不能用 min(maxBank, k·常数) 这种形式 —— 只要常数足够大，
    // 它在几乎所有位置都会饱和成 ±maxBank，于是每次曲率变号都会让路面横坡
    // 突跳一次（相邻采样点之间扭转好几度），车会被这种"路面扭麻花"直接顶飞。
    // 这里用 tanh 做连续过渡，再做一次沿弧长的滑动平均。
    const kRef = 0.02; // 1/50m：半径 50m 的弯大约用到 76% 的最大超高
    for (let i = 0; i < N; i++) {
      const s = samples[i];
      if (s.bankExplicit) continue;
      s.bank = config.maxBank * Math.tanh(s.signedCurvature / kRef);
    }
    // 沿赛道的滑动平均（仅平滑自动生成的超高；显式指定的点保持原值）
    const autoBank = samples.map((s) => s.bank);
    const half = 6; // ±6 个采样点 ≈ ±8.4m
    for (let i = 0; i < N; i++) {
      if (samples[i].bankExplicit) continue;
      let sum = 0;
      let n = 0;
      for (let k = -half; k <= half; k++) {
        const j = closed ? ((i + k) % N + N) % N : Math.min(Math.max(i + k, 0), N - 1);
        if (samples[j].bankExplicit) continue;
        sum += autoBank[j];
        n++;
      }
      if (n > 0) samples[i].bank = sum / n;
    }

    // 正交标架：R = T × U, W = R × T，再绕 T 施加超高
    for (let i = 0; i < N; i++) {
      const s = samples[i];
      let rx = -s.tz;
      let ry = 0;
      let rz = s.tx;
      const rl = Math.max(Math.hypot(rx, ry, rz), 1e-9);
      rx /= rl;
      ry /= rl;
      rz /= rl;
      // up = right × tangent
      let ux = ry * s.tz - rz * s.ty;
      let uy = rz * s.tx - rx * s.tz;
      let uz = rx * s.ty - ry * s.tx;
      const ul = Math.max(Math.hypot(ux, uy, uz), 1e-9);
      ux /= ul;
      uy /= ul;
      uz /= ul;
      const c = Math.cos(s.bank);
      const sn = Math.sin(s.bank);
      // 绕切向旋转：bank > 0 时右侧抬高
      s.rx = rx * c + ux * sn;
      s.ry = ry * c + uy * sn;
      s.rz = rz * c + uz * sn;
      const rl2 = Math.max(Math.hypot(s.rx, s.ry, s.rz), 1e-9);
      s.rx /= rl2;
      s.ry /= rl2;
      s.rz /= rl2;
      s.ux = s.ry * s.tz - s.rz * s.ty;
      s.uy = s.rz * s.tx - s.rx * s.tz;
      s.uz = s.rx * s.ty - s.ry * s.tx;
      const ul2 = Math.max(Math.hypot(s.ux, s.uy, s.uz), 1e-9);
      s.ux /= ul2;
      s.uy /= ul2;
      s.uz /= ul2;
    }

    return { samples, totalLength };
  }

  /** 归一化位置 → 插值采样。闭合曲线回绕，开放曲线夹紧到 [0,1]。 */
  sampleAt(t: number): CenterlineSample {
    const N = this.samples.length;
    if (!this.closed) {
      const tt = Math.min(Math.max(t, 0), 1);
      // 开放曲线：N 个采样点覆盖 [0,1]，共 N-1 段
      const f = tt * (N - 1);
      const i0 = Math.min(Math.floor(f), Math.max(N - 2, 0));
      const i1 = Math.min(i0 + 1, N - 1);
      const k = f - i0;
      const a = this.samples[i0];
      const b = this.samples[i1];
      return {
        x: a.x + (b.x - a.x) * k,
        y: a.y + (b.y - a.y) * k,
        z: a.z + (b.z - a.z) * k,
        tx: a.tx + (b.tx - a.tx) * k,
        ty: a.ty + (b.ty - a.ty) * k,
        tz: a.tz + (b.tz - a.tz) * k,
        rx: a.rx + (b.rx - a.rx) * k,
        ry: a.ry + (b.ry - a.ry) * k,
        rz: a.rz + (b.rz - a.rz) * k,
        ux: a.ux + (b.ux - a.ux) * k,
        uy: a.uy + (b.uy - a.uy) * k,
        uz: a.uz + (b.uz - a.uz) * k,
        halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * k,
        s: a.s + (b.s - a.s) * k,
        curvature: a.curvature + (b.curvature - a.curvature) * k,
        signedCurvature: a.signedCurvature + (b.signedCurvature - a.signedCurvature) * k,
        grade: a.grade + (b.grade - a.grade) * k,
        bank: a.bank + (b.bank - a.bank) * k,
        bankExplicit: a.bankExplicit && b.bankExplicit,
      };
    }
    const tt = ((t % 1) + 1) % 1;
    const f = tt * N;
    const i0 = Math.floor(f) % N;
    const i1 = (i0 + 1) % N;
    const k = f - Math.floor(f);
    const a = this.samples[i0];
    const b = this.samples[i1];
    return {
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      z: a.z + (b.z - a.z) * k,
      tx: a.tx + (b.tx - a.tx) * k,
      ty: a.ty + (b.ty - a.ty) * k,
      tz: a.tz + (b.tz - a.tz) * k,
      rx: a.rx + (b.rx - a.rx) * k,
      ry: a.ry + (b.ry - a.ry) * k,
      rz: a.rz + (b.rz - a.rz) * k,
      ux: a.ux + (b.ux - a.ux) * k,
      uy: a.uy + (b.uy - a.uy) * k,
      uz: a.uz + (b.uz - a.uz) * k,
      halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * k,
      s: a.s + (b.s - a.s) * k,
      curvature: a.curvature + (b.curvature - a.curvature) * k,
      signedCurvature: a.signedCurvature + (b.signedCurvature - a.signedCurvature) * k,
      grade: a.grade + (b.grade - a.grade) * k,
      bank: a.bank + (b.bank - a.bank) * k,
      bankExplicit: a.bankExplicit && b.bankExplicit,
    };
  }

  /** 由 (t, 横向偏移, 竖直偏移) 求世界坐标。 */
  pointAt(t: number, lateral = 0, height = 0): { x: number; y: number; z: number } {
    const s = this.sampleAt(t);
    return {
      x: s.x + s.rx * lateral + s.ux * height,
      y: s.y + s.ry * lateral + s.uy * height,
      z: s.z + s.rz * lateral + s.uz * height,
    };
  }

  /**
   * 世界坐标 → 中心线投影。
   * @param yHint 车辆当前高度：用于在有高架/桥梁时优先匹配同层路段。
   */
  project(x: number, z: number, yHint?: number): CenterlineProjection {
    const gx = Math.floor((x - this.minX) / this.cell);
    const gz = Math.floor((z - this.minZ) / this.cell);
    let candidates: number[] | null = null;
    if (gx >= 0 && gz >= 0 && gx < this.gridW && gz < this.gridH) {
      const list = this.grid[gx + gz * this.gridW];
      if (list.length > 0) candidates = list;
    }

    let best = -1;
    let bestScore = Infinity;
    const evaluate = (i: number) => {
      const s = this.samples[i];
      const dx = s.x - x;
      const dz = s.z - z;
      let score = dx * dx + dz * dz;
      if (yHint !== undefined) {
        const dy = s.y - yHint;
        // 高度差大 → 认为是另一层路段，加大代价
        score += dy * dy * 6;
      }
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    };

    if (candidates) {
      for (const i of candidates) evaluate(i);
    } else {
      for (let i = 0; i < this.samples.length; i++) evaluate(i);
    }

    const s = this.samples[best];
    const dx = x - s.x;
    const dz = z - s.z;
    return {
      index: best,
      t: s.s / this.totalLength,
      lateral: dx * s.rx + dz * s.rz,
      distance: Math.hypot(dx, dz),
      halfWidth: s.halfWidth,
    };
  }

  /** 路面（含超高）在世界坐标处的高度。 */
  roadHeightAt(x: number, z: number, yHint?: number): number {
    const p = this.project(x, z, yHint);
    const s = this.samples[p.index];
    return s.y + p.lateral * s.ry;
  }

  /** 中心线上离给定位置最近的点（用于重置到赛道上）。 */
  nearestOnTrack(
    x: number,
    z: number,
    yHint?: number,
  ): { x: number; y: number; z: number; heading: number; t: number; lateral: number } {
    const p = this.project(x, z, yHint);
    const s = this.samples[p.index];
    const lat = Math.max(-s.halfWidth * 0.6, Math.min(s.halfWidth * 0.6, p.lateral));
    return {
      x: s.x + s.rx * lat,
      y: s.y + s.ry * lat,
      z: s.z + s.rz * lat,
      heading: Math.atan2(s.tx, s.tz),
      t: p.t,
      lateral: lat,
    };
  }
}
