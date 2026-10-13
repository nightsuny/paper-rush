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
  /**
   * 路缘（马路牙子）相对路面的抬升（米）。0 = 没有路缘。
   * 土路不应该有路缘 —— 真实村里的土路就是直接接到土肩上。
   */
  readonly kerbHeight?: number;
  /**
   * 路面不平整度（米，峰谷幅度）。土路取大一些才有"坑洼"的体感；
   * 沥青路取很小，只当作细微起伏。
   * 值会同时作用到**视觉网格与碰撞网格**（同一份断面），所以车是真的会颠。
   */
  readonly roughness?: number;
}

export const ROAD_KINDS: Record<RoadKind, RoadKindSpec> = {
  // 主干道：双车道沥青，有路缘、有标线，接近平直
  primary: {
    kind: 'primary',
    width: 9,
    surface: 'asphalt',
    referenceSpeed: 30,
    defaultGuardrail: false,
    kerbHeight: 0.055,
    roughness: 0.012,
  },
  // 乡道：单车道沥青，有路缘与标线，但更窄、起伏稍大
  secondary: {
    kind: 'secondary',
    width: 6.4,
    surface: 'asphalt',
    referenceSpeed: 22,
    defaultGuardrail: false,
    kerbHeight: 0.05,
    roughness: 0.022,
  },
  // 土路：村道与林道。窄、无路缘、无标线、明显坑洼
  dirt: {
    kind: 'dirt',
    width: 4.6,
    surface: 'dirt',
    referenceSpeed: 13,
    defaultGuardrail: false,
    kerbHeight: 0,
    roughness: 0.085,
  },
};

/** 装饰分区的类型，决定这一段路两侧长什么。 */
export type RoadBiome = 'meadow' | 'forest' | 'village' | 'farm' | 'urban';

/** 一条路段。`closed` 为 true 时是环线（环岛、环线赛道）。 */
export interface RoadSegmentConfig {
  id: string;
  kind: RoadKind;
  /**
   * 该路段两侧的景观类型。RegionView 据此选择装饰种类与密度 ——
   * 这样"地图主题影响观感"是按路段配置的，而不是全图一个调子。
   */
  biome?: RoadBiome;
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
  /**
   * **手工摆放**的景观件：一栋房子、一段院墙、一口水塘……
   *
   * 这是村庄的做法：逐点写出来，每一条都带 `note` 说明为什么摆在这里。
   * 与之相对的"按概率撒"只适合林地/旷野这种**成片**的东西。
   */
  placements?: PlacementConfig[];
  /** 出生点 */
  spawn: { segment: string; t: number; lateral?: number };
  seed: number;
  terrainAmplitude: number;
  terrainScale: number;
  paperThickness: number;
}

/** 手工摆放的景观件种类。 */
export type PlacementKind =
  | 'house'
  | 'barn'
  | 'shed'
  | 'haystack'
  | 'crate'
  | 'pond'
  | 'fence'
  | 'tree'
  | 'bush'
  | 'flower';

/**
 * 一个手工摆放的景观件。
 *
 * 坐标是**世界坐标（米）**，不是相对路段的参数 —— 设计村庄时要在脑子里摆位置，
 * 用"第几条路第几成"这种参数化表达反而看不出布局。
 */
export interface PlacementConfig {
  kind: PlacementKind;
  x: number;
  z: number;
  /** 朝向（弧度）。房子的正面是局部 +Z，所以 heading 决定它面向哪边。 */
  heading?: number;
  scale?: number;
  // --- house ---
  width?: number;
  depth?: number;
  height?: number;
  roofHeight?: number;
  roof?: 'slate' | 'tile' | 'thatch';
  wall?: number;
  windows?: number;
  doorOffset?: number;
  chimney?: boolean;
  // --- barn / shed / haystack / crate / pond ---
  /** 圆的半径（pond）或长条的长度（fence） */
  radius?: number;
  /** 长条的另一端（fence 专用） */
  x2?: number;
  z2?: number;
  /** 树的品种 */
  tree?: 'conifer' | 'broadleaf';
  /** 设计意图：这一件为什么在这里 */
  note?: string;
}

/** 区域边界空气墙的厚度（米）。 */
export const REGION_WALL_THICKNESS = 3;
/** 空气墙高度（米）。 */
export const REGION_WALL_HEIGHT = 14;
/** 闸口开口宽度（米）。 */
export const GATE_OPENING_WIDTH = 14;
