import { Centerline, type CenterlineProjection, type CurveSpec } from '../tracks/Centerline';
import { ROAD_KINDS, type RoadSegmentConfig } from './types';

/**
 * 路网：多条路段（开放或闭合）+ 全网空间索引。
 *
 * 这是开放世界最核心的一层：整个游戏里"我离道路多远、我在哪条路上、前方曲率多少"
 * 全部通过这里的 project() 回答。地形走廊、装饰摆放、边界判定、AI 线路都依赖它。
 *
 * 索引：把所有路段的采样点放进一张共享的 XZ 网格，查询时只检查候选格子，
 * 因此路段数量增加时查询开销基本不变（不需要遍历所有路段）。
 */

export interface RoadSegmentCurve extends CurveSpec {
  id: string;
}

/** 全网投影结果：比单条路的投影多了"在哪条路段上"。 */
export interface NetworkProjection {
  segmentIndex: number;
  segmentId: string;
  /** 段内归一化位置 0..1 */
  t: number;
  lateral: number;
  distance: number;
  halfWidth: number;
  /** 采样点索引（该段内） */
  sampleIndex: number;
}

export interface RoadNetworkOptions {
  /** 采样分辨率（米） */
  resolution?: number;
}

export class RoadNetwork {
  readonly curves: Centerline<RoadSegmentCurve>[];
  readonly configs: RoadSegmentConfig[];

  private readonly cell: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly gridW: number;
  private readonly gridH: number;
  /** 每个格子内保存 [segmentIndex, sampleIndex] 对（交错存放） */
  private readonly grid: number[][];
  /** 每条路的不平整度（米）与其噪声种子 */
  private readonly roughness: number[];
  private readonly roughnessSeed: number[];
  /** 用于跳过 NaN / 空网 */
  readonly totalLength: number;
  readonly bounds: { minX: number; minZ: number; maxX: number; maxZ: number };

  constructor(configs: RoadSegmentConfig[], opts: RoadNetworkOptions = {}) {
    const resolution = opts.resolution ?? 1.4;
    this.configs = configs;
    this.curves = configs.map((cfg) => {
      const spec: RoadSegmentCurve = {
        id: cfg.id,
        points: cfg.points,
        width: cfg.width ?? ROAD_KINDS[cfg.kind].width,
        maxBank: 0.05,
        closed: cfg.closed === true,
      };
      return new Centerline(spec, resolution);
    });
    this.totalLength = this.curves.reduce((a, c) => a + c.totalLength, 0);
    this.roughness = configs.map((c) => ROAD_KINDS[c.kind].roughness ?? 0);
    this.roughnessSeed = configs.map((_, i) => i + 1);

    // ---- 共享空间索引 ----
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const c of this.curves) {
      for (const s of c.samples) {
        if (s.x < minX) minX = s.x;
        if (s.z < minZ) minZ = s.z;
        if (s.x > maxX) maxX = s.x;
        if (s.z > maxZ) maxZ = s.z;
      }
    }
    if (!Number.isFinite(minX)) {
      minX = minZ = 0;
      maxX = maxZ = 1;
    }
    this.cell = 18;
    this.minX = minX - this.cell;
    this.minZ = minZ - this.cell;
    this.gridW = Math.max(1, Math.ceil((maxX - minX) / this.cell) + 3);
    this.gridH = Math.max(1, Math.ceil((maxZ - minZ) / this.cell) + 3);
    this.grid = Array.from({ length: this.gridW * this.gridH }, () => [] as number[]);
    for (let si = 0; si < this.curves.length; si++) {
      const samples = this.curves[si].samples;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const gx = Math.floor((s.x - this.minX) / this.cell);
        const gz = Math.floor((s.z - this.minZ) / this.cell);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const ix = gx + dx;
            const iz = gz + dz;
            if (ix < 0 || iz < 0 || ix >= this.gridW || iz >= this.gridH) continue;
            this.grid[ix + iz * this.gridW].push(si, i);
          }
        }
      }
    }
    this.bounds = { minX, minZ, maxX, maxZ };
  }

  get segmentCount(): number {
    return this.curves.length;
  }

  /** 第 i 条路的不平整度（米）。 */
  roughnessOf(i: number): number {
    return this.roughness[i] ?? 0;
  }

  /** 第 i 条路的不平整噪声种子。 */
  roughnessSeedOf(i: number): number {
    return this.roughnessSeed[i] ?? 1;
  }

  segmentById(id: string): Centerline<RoadSegmentCurve> | undefined {
    return this.curves.find((c) => c.config.id === id);
  }

  segmentIndexById(id: string): number {
    return this.curves.findIndex((c) => c.config.id === id);
  }

  /**
   * 给定半径内出现的**最低**路面采样点（找不到返回 null）。
   *
   * 地形的"走廊压平"必须取最低的那条路。如果取最近的那条，两条不同高度的路靠在一起时，
   * 地形会被压到较高那条的平面，把较低那条整条埋掉 —— 实测最严重处草地高出路面 5.81 m，
   * 车开过去会被弹飞（实测 1440 km/h）。取最低值则两条路都不会被埋。
   */
  lowestRoadSampleWithin(
    x: number,
    z: number,
    radius: number,
    excludeSegment?: number,
  ): { segmentIndex: number; sampleIndex: number; distance: number; y: number } | null {
    const span = Math.ceil(radius / this.cell) + 1;
    const gx = Math.floor((x - this.minX) / this.cell);
    const gz = Math.floor((z - this.minZ) / this.cell);
    let best: { segmentIndex: number; sampleIndex: number; distance: number; y: number } | null =
      null;
    const r2 = radius * radius;
    for (let dx = -span; dx <= span; dx++) {
      const ix = gx + dx;
      if (ix < 0 || ix >= this.gridW) continue;
      for (let dz = -span; dz <= span; dz++) {
        const iz = gz + dz;
        if (iz < 0 || iz >= this.gridH) continue;
        const list = this.grid[ix + iz * this.gridW];
        for (let k = 0; k < list.length; k += 2) {
          const si = list[k];
          if (si === excludeSegment) continue;
          const i = list[k + 1];
          const s = this.curves[si].samples[i];
          const ddx = s.x - x;
          const ddz = s.z - z;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > r2) continue;
          if (best === null || s.y < best.y) {
            best = { segmentIndex: si, sampleIndex: i, distance: Math.sqrt(d2), y: s.y };
          }
        }
      }
    }
    return best;
  }

  /** 世界坐标 → 全网最近路段投影。 */
  project(x: number, z: number, yHint?: number): NetworkProjection {
    const gx = Math.floor((x - this.minX) / this.cell);
    const gz = Math.floor((z - this.minZ) / this.cell);
    const candidates: number[] | null =
      gx >= 0 && gz >= 0 && gx < this.gridW && gz < this.gridH
        ? this.grid[gx + gz * this.gridW]
        : null;

    let bestSeg = 0;
    let bestIdx = 0;
    let bestScore = Infinity;

    const consider = (si: number, i: number): void => {
      const s = this.curves[si].samples[i];
      const dx = s.x - x;
      const dz = s.z - z;
      let score = dx * dx + dz * dz;
      if (yHint !== undefined) {
        const dy = s.y - yHint;
        // 高度差大 → 认为在另一层（高架），加大代价
        score += dy * dy * 6;
      }
      if (score < bestScore) {
        bestScore = score;
        bestSeg = si;
        bestIdx = i;
      }
    };

    if (candidates && candidates.length > 0) {
      for (let k = 0; k < candidates.length; k += 2) consider(candidates[k], candidates[k + 1]);
    }
    // 兜底：没有候选（离所有路都很远，或索引未覆盖）时全量扫描一次
    if (!Number.isFinite(bestScore)) {
      for (let si = 0; si < this.curves.length; si++) {
        const samples = this.curves[si].samples;
        for (let i = 0; i < samples.length; i++) consider(si, i);
      }
    }

    const curve = this.curves[bestSeg];
    const s = curve.samples[bestIdx];
    const dx = x - s.x;
    const dz = z - s.z;
    return {
      segmentIndex: bestSeg,
      segmentId: curve.config.id,
      t: s.s / Math.max(curve.totalLength, 1e-6),
      lateral: dx * s.rx + dz * s.rz,
      distance: Math.sqrt(Math.max(bestScore, 0)),
      halfWidth: s.halfWidth,
      sampleIndex: bestIdx,
    };
  }

  /** 到最近路面的距离（不含横向超高）。 */
  distanceToRoad(x: number, z: number, yHint?: number): number {
    return this.project(x, z, yHint).distance;
  }

  /** 该点所在的路面高度（含横向超高）。 */
  roadHeightAt(x: number, z: number, yHint?: number): number {
    const p = this.project(x, z, yHint);
    const s = this.curves[p.segmentIndex].samples[p.sampleIndex];
    return s.y + p.lateral * s.ry;
  }

  /** 单路段的投影（用于把玩家吸附到指定路段，例如重置到出生点）。 */
  projectOnSegment(index: number, x: number, z: number): CenterlineProjection {
    return this.curves[index].project(x, z);
  }

  /**
   * 该点是否位于"路面覆盖范围"内（路面 + 路肩 + 过渡坡）。
   * 用于判断是否在道路上。
   */
  isOnRoad(x: number, z: number, yHint?: number): boolean {
    const p = this.project(x, z, yHint);
    return p.distance <= p.halfWidth;
  }
}
