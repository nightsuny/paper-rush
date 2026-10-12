/**
 * 赛道配置的数据结构。
 *
 * 赛道 = 配置数据 + 程序化生成。本文件只描述"长什么样"，
 * 具体的网格、碰撞面、检查点由 tracks/Track.ts 生成。
 */

/** 中心线控制点。x/z 为平面坐标，y 为高程，可选 bank 指定该点超高（弧度，右高为正）。 */
export interface ControlPoint {
  x: number;
  y: number;
  z: number;
  /** 该点处的道路半宽覆盖值（米），不填则用 config.width/2。 */
  halfWidth?: number;
  /** 该点处的超高角（弧度），不填则按曲率自动计算。 */
  bank?: number;
}

export interface CheckpointConfig {
  /** 沿赛道的归一化位置 0..1。 */
  t: number;
  /** 判定半宽（米），一般略大于道路半宽。 */
  halfWidth: number;
}

export interface GuardrailConfig {
  /** 起始归一化位置 0..1 */
  from: number;
  /** 结束归一化位置 0..1 */
  to: number;
  /** 在哪一侧：'left' | 'right' | 'both' */
  side: 'left' | 'right' | 'both';
  /** 含义同上，用于把护栏偏移到路肩外 */
  offset: number;
}

/** 装饰区类型：决定该区域放什么纸艺装饰。 */
export type DecorationKind = 'flowers' | 'trees' | 'hills' | 'houses' | 'rocks' | 'none';

export interface DecorationZone {
  from: number;
  to: number;
  side: 'left' | 'right' | 'both';
  kind: DecorationKind;
  /** 密度（每 50 米的个数） */
  density: number;
}

export interface TrackTheme {
  /** 天空顶部/底部颜色 */
  skyTop: number;
  skyBottom: number;
  /** 环境光与主光颜色 */
  ambient: number;
  sun: number;
  sunIntensity: number;
  ambientIntensity: number;
  /** 雾色与浓度 */
  fog: number;
  fogNear: number;
  fogFar: number;
  /** 纸板世界底座颜色 */
  paperGround: number;
  /** 路面颜色 */
  road: number;
  roadEdge: number;
  kerb: number;
  /** 草地颜色 */
  grass: number;
  /** 装饰主色 */
  accent: number;
  accent2: number;
  accent3: number;
}

export interface TrackConfig {
  id: string;
  /** 章节序号，用于 UI 显示 */
  chapter: number;
  name: string;
  subtitle: string;
  /** 难度 1-5 */
  difficulty: number;
  /** 建议圈数 */
  laps: number;
  theme: TrackTheme;
  /** 控制点（闭合回路，首尾自动相连） */
  points: ControlPoint[];
  /** 标准道路全宽（米） */
  width: number;
  /** 路肩宽度（米） */
  shoulder: number;
  /** 检查点（必须按行进顺序排列，t 递增） */
  checkpoints: CheckpointConfig[];
  /** 护栏段 */
  guardrails: GuardrailConfig[];
  /** 装饰区 */
  decorations: DecorationZone[];
  /** 纸板厚度（米），用于生成可见的路边"卡纸厚度" */
  paperThickness: number;
  /** 起点线所在的归一化位置 */
  startT: number;
  /** 本赛道最大超高（弧度） */
  maxBank: number;
  /** 随机种子：同配置必须生成完全相同的结果 */
  seed: number;
  /** 地形：起伏高度（米）与波动频率 */
  terrainAmplitude: number;
  terrainScale: number;
}
