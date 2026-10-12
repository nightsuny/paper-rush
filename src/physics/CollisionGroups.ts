/**
 * 碰撞分组与路面类型。
 *
 * Rapier 的 InteractionGroups 是 32 位：高 16 位为 membership，低 16 位为 filter。
 */

export const GROUP = {
  /** 赛道静态几何（路面、护栏、路肩） */
  TRACK: 0x0001,
  /** 场景装饰（可碰撞的帐篷、纸箱等） */
  PROP: 0x0002,
  /** 车辆 */
  VEHICLE: 0x0004,
  /** 触发区（检查点、机关） */
  TRIGGER: 0x0008,
} as const;

/** 组合 membership 与 filter 为 Rapier 的分组整数。 */
export function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/** 路面材质类型，影响抓地与滚动阻力。 */
export interface SurfaceType {
  readonly id: string;
  /** 轮胎摩擦系数倍率。 */
  readonly gripScale: number;
  /** 附加滚动阻力系数。 */
  readonly rollingScale: number;
  /** 是否属于赛道（离开赛道会被判定为切弯）。 */
  readonly onTrack: boolean;
  readonly color: number;
}

export const SURFACES: Record<string, SurfaceType> = {
  asphalt: { id: 'asphalt', gripScale: 1.0, rollingScale: 1.0, onTrack: true, color: 0x8d8579 },
  kerb: { id: 'kerb', gripScale: 0.92, rollingScale: 1.25, onTrack: true, color: 0xd8534a },
  grass: { id: 'grass', gripScale: 0.55, rollingScale: 5.0, onTrack: false, color: 0x9dc46a },
  cardboard: { id: 'cardboard', gripScale: 0.95, rollingScale: 1.1, onTrack: true, color: 0xc89b62 },
  wall: { id: 'wall', gripScale: 0.8, rollingScale: 1.0, onTrack: true, color: 0xe8dfc8 },
  void: { id: 'void', gripScale: 0.5, rollingScale: 2.0, onTrack: false, color: 0x6d6455 },
};

export function surfaceById(id: string): SurfaceType {
  return SURFACES[id] ?? SURFACES.asphalt;
}
