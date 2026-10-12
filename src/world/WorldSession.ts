import type { Car } from '../vehicles/Car';
import type { RoadNetwork, NetworkProjection } from './RoadNetwork';
import type { RegionConfig } from './types';

/**
 * 开放世界的自由驾驶会话（S1 只做"开着玩"所需要的最小统计）。
 *
 * 与 race/RaceSession 的区别：这里没有圈数与检查点。
 * 收集物、计时挑战与区域完成度在 S3 加进来，那时会在这个类上扩展，
 * 而不是把玩法硬塞进 HUD。
 */

export interface WorldStats {
  /** 自由驾驶累计时间（秒） */
  elapsed: number;
  /** 累计行驶里程（米） */
  distance: number;
  /** 最高速度 m/s */
  topSpeed: number;
  /** 当前所在路段 id */
  segmentId: string;
  /** 当前路段上的归一化位置 */
  segmentT: number;
  /** 横向偏移（米） */
  lateral: number;
  /** 是否在路面范围内 */
  onRoad: boolean;
  /** 当前是否腾空 */
  airborne: boolean;
  /** 离开路面的累计时间（秒） */
  offRoadTime: number;
  /** 撞到区域边界的累计次数 */
  boundaryHits: number;
  /** 距离区域边界的最小距离（米），用于 HUD 提示 */
  distanceToBoundary: number;
}

export interface WorldSessionOptions {
  config: RegionConfig;
  network: RoadNetwork;
  car: Car;
  spawn: { x: number; y: number; z: number; heading: number };
}

const BOUNDARY_HIT_COOLDOWN = 1.5;

export class WorldSession {
  readonly config: RegionConfig;
  readonly network: RoadNetwork;
  readonly car: Car;
  readonly spawn: { x: number; y: number; z: number; heading: number };

  private readonly stats: WorldStats;
  private prevX: number;
  private prevZ: number;
  private boundaryCooldown = 0;
  /** 撞到边界时置位一次，供 Game 弹提示 */
  boundaryHitFlag = false;

  constructor(opts: WorldSessionOptions) {
    this.config = opts.config;
    this.network = opts.network;
    this.car = opts.car;
    this.spawn = opts.spawn;
    const proj = this.network.project(opts.spawn.x, opts.spawn.z, opts.spawn.y);
    this.stats = {
      elapsed: 0,
      distance: 0,
      topSpeed: 0,
      segmentId: proj.segmentId,
      segmentT: proj.t,
      lateral: proj.lateral,
      onRoad: proj.distance <= proj.halfWidth,
      airborne: false,
      offRoadTime: 0,
      boundaryHits: 0,
      distanceToBoundary: this.boundaryDistance(opts.spawn.x, opts.spawn.z),
    };
    this.prevX = opts.spawn.x;
    this.prevZ = opts.spawn.z;
  }

  get current(): Readonly<WorldStats> {
    return this.stats;
  }

  /** 推进一个物理步。 */
  update(dt: number, proj: NetworkProjection): void {
    const p = this.car.position;
    this.stats.elapsed += dt;
    const step = Math.hypot(p.x - this.prevX, p.z - this.prevZ);
    this.stats.distance += step;
    this.prevX = p.x;
    this.prevZ = p.z;

    const tel = this.car.telemetry;
    this.stats.topSpeed = Math.max(this.stats.topSpeed, tel.speed);
    this.stats.segmentId = proj.segmentId;
    this.stats.segmentT = proj.t;
    this.stats.lateral = proj.lateral;
    this.stats.onRoad = proj.distance <= proj.halfWidth;
    this.stats.airborne = tel.airborne;
    if (!this.stats.onRoad) this.stats.offRoadTime += dt;

    // 边界：靠近时给 HUD 提示，撞上时计一次
    const bd = this.boundaryDistance(p.x, p.z);
    this.stats.distanceToBoundary = bd;
    this.boundaryCooldown = Math.max(0, this.boundaryCooldown - dt);
    if (bd < 6 && this.boundaryCooldown <= 0) {
      this.stats.boundaryHits++;
      this.boundaryCooldown = BOUNDARY_HIT_COOLDOWN;
      this.boundaryHitFlag = true;
    }
  }

  /** 消费一次"撞到边界"标记。 */
  takeBoundaryHit(): boolean {
    if (!this.boundaryHitFlag) return false;
    this.boundaryHitFlag = false;
    return true;
  }

  /** 回到出生点（R 键）。 */
  resetToSpawn(): void {
    this.car.teleportTo(
      { x: this.spawn.x, y: this.spawn.y, z: this.spawn.z },
      this.spawn.heading,
    );
    this.prevX = this.spawn.x;
    this.prevZ = this.spawn.z;
  }

  /** 把车放到指定路段的位置（调试与"回到路上"用）。 */
  resetToSegment(segmentId: string, t: number, lateral = 0): boolean {
    const idx = this.network.segmentIndexById(segmentId);
    if (idx < 0) return false;
    const curve = this.network.curves[idx];
    const s = curve.sampleAt(Math.min(Math.max(t, 0), 1));
    this.car.teleportTo(
      { x: s.x + s.rx * lateral, y: s.y + s.ry * lateral + 0.4, z: s.z + s.rz * lateral },
      Math.atan2(s.tx, s.tz),
    );
    this.prevX = this.car.position.x;
    this.prevZ = this.car.position.z;
    return true;
  }

  /** 到区域边界矩形的最近距离（米）。 */
  private boundaryDistance(x: number, z: number): number {
    const b = this.config.bounds;
    return Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z);
  }
}
