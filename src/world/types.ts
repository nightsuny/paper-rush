import type { ControlPoint, DecorationZone, GuardrailConfig, TrackTheme } from '../tracks/types';

/**
 * 开放世界的数据模型。
 *
 * 与赛道配置（TrackConfig）的关系：
 *  - TrackConfig 描述"一条闭合赛道"
 *  - RegionConfig 描述"一个可驾驶区域"，由**多条路段 + 路口 + 边界**组成
 * 两者共用曲线（ControlPoint）、护栏、装饰区这些基础结构，但不再是同一个概念。
 */

/** 路段等级：决定默认宽度与路面材质。 */
export type RoadKind = 'primary' | 'secondary' | 'dirt';

export interface RoadKindSpec {
  readonly kind: RoadKind;
  /** 默认路面全宽（米） */
  readonly width: number;
  /** 路面碰撞体注册的路面类型 id（见 physics/CollisionGroups） */
  readonly surface: string;
  /** 默认限速参考（m/s），供将来的 AI 车流与挑战门使用 */
  readonly referenceSpeed: number;
  /**
   * 是否默认两边加护栏。
   * 开放世界里默认 **false**：四周围栏会让玩家失去开放感，
   * 只有配置里显式写了 guardrails 的路段才铺护栏（例如临水/临崖路段）。
   */
  readonly defaultGuardrail: boolean;
}

export const ROAD_KINDS: Record<RoadKind, RoadKindSpec> = {
  primary: { kind: 'primary', width: 10, surface: 'asphalt', referenceSpeed: 30, defaultGuardrail: false },
  secondary: { kind: 'secondary', width: 8, surface: 'asphalt', referenceSpeed: 24, defaultGuardrail: false },
  dirt: { kind: 'dirt', width: 6.5, surface: 'dirt', referenceSpeed: 16, defaultGuardrail: false },
};

/** 一条路段。`closed` 为 true 时是环线（环岛、环线赛道）。 */
export interface RoadSegmentConfig {
  id: string;
  kind: RoadKind;
  /** 控制点。闭合路段首尾自动相连；开放路段两端就是路的尽头（会接路口或区域边界）。 */
  points: ControlPoint[];
  closed?: boolean;
  /** 覆盖该等级默认宽度 */
  width?: number;
  /** 覆盖该等级默认路面材质 */
  surface?: string;
  guardrails?: GuardrailConfig[];
  decorations?: DecorationZone[];
  /** 该路段两端的处理方式，决定是否在端头收口 */
  ends?: { start?: RoadEnd; end?: RoadEnd };
}

/**
 * 路段端头的类型：
 *  - 'junction' 接到路口（路面在此与路口铺装重叠，护栏自动抑制）
 *  - 'gate'     接到区域出口闸口（空气墙在此断开）
 *  - 'dead'     断头路（端头收口，做成一个圆形小环岛样式的尽头）
 */
export type RoadEnd = 'junction' | 'gate' | 'dead';

export interface JunctionConfig {
  id: string;
  kind: 'roundabout' | 'tee' | 'cross';
  x: number;
  z: number;
  y: number;
  /** 路口铺装半径（米）：用于计算护栏抑制范围 */
  radius: number;
  /** 中央岛半径（米），不填取 radius × 0.55 */
  islandRadius?: number;
  /**
   * 环岛中央岛的高度（米）。>0 时生成一个抬高的实体岛（不可行驶）。
   * 非环岛路口填 0。
   */
  islandHeight?: number;
}

export interface RegionGateConfig {
  id: string;
  x: number;
  z: number;
  /** 闸口朝向（弧度）：空气墙在这个方向上是开口的 */
  heading: number;
  /** 通往的下一个区域 id（尚未实现跨区加载，仅作标记与提示文案） */
  toRegion?: string;
  label: string;
}

export interface CollectibleConfig {
  id: string;
  x: number;
  z: number;
}

export interface TimeTrialConfig {
  id: string;
  name: string;
  /** 起点门：所在路段 id 与段内归一化位置 */
  from: { segment: string; t: number };
  /** 终点门 */
  to: { segment: string; t: number };
}

export interface LandmarkConfig {
  kind: 'windmill' | 'waterwheel' | 'villageArch';
  x: number;
  z: number;
  scale: number;
  heading?: number;
}

/** 区域主题：在赛道主题的基础上增加 biome，用来选择装饰与地形参数。 */
export interface RegionTheme extends TrackTheme {
  biome: 'meadow' | 'forest' | 'village' | 'snow' | 'urban' | 'coast';
}

export interface RegionConfig {
  id: string;
  name: string;
  subtitle: string;
  theme: RegionTheme;
  /** 区域边界矩形：空气墙沿此边界布置，并在闸口处断开 */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  roads: RoadSegmentConfig[];
  junctions: JunctionConfig[];
  gates: RegionGateConfig[];
  collectibles: CollectibleConfig[];
  timeTrials: TimeTrialConfig[];
  landmarks: LandmarkConfig[];
  /** 出生点 */
  spawn: { segment: string; t: number; lateral?: number };
  seed: number;
  terrainAmplitude: number;
  terrainScale: number;
  paperThickness: number;
}

/** 区域边界空气墙的厚度（米）。 */
export const REGION_WALL_THICKNESS = 3;
/** 空气墙高度（米）。 */
export const REGION_WALL_HEIGHT = 14;
/** 闸口开口宽度（米）。 */
export const GATE_OPENING_WIDTH = 14;
